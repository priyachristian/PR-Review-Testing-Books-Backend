/**
 * Migration: rebuild a payment's journal from the document, and drop apply/remove journals.
 *
 * Apply/remove journals are keyed to the bill/invoice/OB line id, not the payment _id.
 * Backfill and the daily report do not replay them: rebuilding the payment journal from
 * current applied + unused already has that net, and replaying the line journals would
 * move AP/Prepaid (or AR/Unearned) twice.
 *
 * removeSurplusAdvanceReversals-remove.js only drops repeated reversals. A payment can also be
 * wrong this way: the payment journal is still the approve-time split, a later un-apply never
 * wrote its remove journal, and a later apply journal sits on top. Family CURRENT then does not
 * match today's postPayment*Journal.
 *
 * For those payments this deletes the payment journal and every apply/remove journal for that
 * payment, then posts the payment journal the same way approve/edit does today. Healthy
 * payments — original unused journal plus apply journals that already net to current unused —
 * are left alone.
 *
 * Apply/remove journals whose sourceId is not the payment _id and not a line still on the
 * payment are orphans (un-apply removed the line, or apply posted and the line was never kept).
 * Those are deleted too: the report cannot attach them to a payment, and they are not replayed.
 *
 * Usage:
 *   node migrations/rebuildStalePaymentAdvanceLedgers-remove.js up                         report only, all companies
 *   node migrations/rebuildStalePaymentAdvanceLedgers-remove.js up --companyId=<id>        report only, one company
 *   node migrations/rebuildStalePaymentAdvanceLedgers-remove.js up --apply                 write, all companies
 *   node migrations/rebuildStalePaymentAdvanceLedgers-remove.js up --companyId=<id> --apply write, one company
 */
const mongoose = require('mongoose');
const { ObjectId } = require('mongodb');
const { bootstrap, buildModules, round2 } = require('./backfillLedgerEntries');
const modelService = require('../services/model.service');

const ADVANCE_NARRATION = /applied to|application removed/i;

const parseArgs = () => {
  const companyHit = process.argv.find(a => a.startsWith('--companyId='));
  const companyArg = companyHit === undefined ? undefined : companyHit.slice('--companyId='.length);
  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return {
    companyId: companyArg ? new ObjectId(companyArg) : null,
    apply: process.argv.includes('--apply'),
  };
};

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const netByAccount = rows => {
  const nets = new Map();
  for (const row of rows) {
    if (row.isSplit) continue;
    const key = String(row.accountId);
    nets.set(key, round2((nets.get(key) || 0) + (row.debit || 0) - (row.credit || 0)));
  }
  return nets;
};

const netsEqual = (left, right) => {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    if (round2((left.get(key) || 0) - (right.get(key) || 0))) return false;
  }
  return true;
};

const paymentNo = payment => payment.paymentMadeId || payment.paymentReceivedId;

const currentLineIds = payment =>
  [
    ...(payment.bills || []),
    ...(payment.invoices || []),
    ...(payment.openingBalanceTransactions || []),
    ...(payment.refunds || []),
  ]
    .map(line => line._id)
    .filter(Boolean);

const advanceQuery = (payment, sourceModule) => {
  const or = [{ narration: new RegExp(`Advance ${escapeRegex(paymentNo(payment))} applied to`, 'i') }];
  const lineIds = currentLineIds(payment);
  if (lineIds.length) or.push({ sourceId: { $in: lineIds }, narration: ADVANCE_NARRATION });
  return { companyId: payment.companyId, sourceModule, $or: or };
};

module.exports = {
  async up() {
    const { companyId, apply } = parseArgs();
    const rawConnection = await bootstrap();
    const ledgerService = require('../modules/accountant/ledger/ledger.service');
    const enums = require('../utils/enum');
    const { LedgerEntry } = modelService.getBooksModels();
    const models = { books: modelService.getBooksModels(), common: modelService.getCommonModels() };
    models['books-crm'] = modelService.getBooksCrmModels();
    const modules = buildModules(ledgerService, models, enums);
    const paymentModules = modules.filter(module => module.name === 'PAYMENT_RECEIVED' || module.name === 'PAYMENT_MADE');

    const targetCompanies = companyId
      ? await models.common.Company.find({ _id: companyId }).select('name').lean()
      : await models.common.Company.find({}).select('name').sort({ name: 1 }).lean();

    console.log(`Scope: ${companyId ? companyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

    const movement = new Map();
    let rebuilt = 0;
    let droppedApplyJournals = 0;

    try {
      for (const company of targetCompanies) {
        for (const module of paymentModules) {
          const sourceModule = module.sourceModule || module.name;
          const documents = await module.model.find({ companyId: company._id, ...(module.filter || {}) }).lean();
          if (!documents.length) continue;

          for (const document of documents) {
            if (module.skip) {
              const skipped = await module.skip(document);
              if (skipped) continue;
            }

            const parentRows = await LedgerEntry.find({
              companyId: document.companyId,
              sourceModule,
              sourceId: document._id,
            }).lean();
            const applyRows = await LedgerEntry.find(advanceQuery(document, sourceModule)).lean();
            const storedNets = netByAccount([...parentRows, ...applyRows]);

            const session = await rawConnection.startSession();
            let expectedRows = [];
            try {
              await session.startTransaction();
              await LedgerEntry.deleteMany({ companyId: document.companyId, sourceModule, sourceId: document._id }, { session });
              await module.post(document, session);
              expectedRows = await LedgerEntry.find({
                companyId: document.companyId,
                sourceModule,
                sourceId: document._id,
              })
                .session(session)
                .lean();
              await session.abortTransaction();
            } catch (error) {
              if (session.inTransaction()) await session.abortTransaction();
              console.log(`  ${company.name || company._id}  ${paymentNo(document)}  probe failed — ${error.message}`);
              continue;
            } finally {
              await session.endSession();
            }

            // A payment that still carries apply/remove journals is rebuilt even when it nets right today:
            // the next apply/remove rebuilds the payment journal, and those line journals would count twice.
            if (!applyRows.length && netsEqual(storedNets, netByAccount(expectedRows))) continue;

            const applyJournals = [...new Set(applyRows.map(row => String(row.journalId)))];
            console.log(
              `  ${company.name || company._id}  ${paymentNo(document)}  parent ${parentRows.length} row(s), apply/remove ${applyRows.length} row(s) in ${applyJournals.length} journal(s)`,
            );

            const expectedNets = netByAccount(expectedRows);
            const accounts = new Set([...storedNets.keys(), ...expectedNets.keys()]);
            for (const account of accounts) {
              const delta = round2((expectedNets.get(account) || 0) - (storedNets.get(account) || 0));
              if (!delta) continue;
              movement.set(account, round2((movement.get(account) || 0) + delta));
            }

            rebuilt += 1;
            droppedApplyJournals += applyJournals.length;

            if (!apply) continue;

            const writeSession = await rawConnection.startSession();
            try {
              await writeSession.startTransaction();
              await LedgerEntry.deleteMany(
                { companyId: document.companyId, sourceModule, sourceId: document._id },
                { session: writeSession },
              );
              if (applyRows.length) {
                await LedgerEntry.deleteMany(
                  { companyId: document.companyId, journalId: { $in: applyRows.map(row => row.journalId) } },
                  { session: writeSession },
                );
              }
              await module.post(document, writeSession);
              await writeSession.commitTransaction();
            } catch (error) {
              if (writeSession.inTransaction()) await writeSession.abortTransaction();
              throw error;
            } finally {
              await writeSession.endSession();
            }
          }
        }

        const liveIds = new Set();
        for (const module of paymentModules) {
          const sourceModule = module.sourceModule || module.name;
          const documents = await module.model
            .find({ companyId: company._id })
            .select('bills invoices openingBalanceTransactions refunds')
            .lean();
          for (const document of documents) {
            liveIds.add(String(document._id));
            for (const id of currentLineIds(document)) liveIds.add(String(id));
          }

          const advanceRows = await LedgerEntry.find({
            companyId: company._id,
            sourceModule,
            $or: [{ narration: /applied to/i }, { narration: /application removed/i }],
          }).lean();
          const orphanJournals = new Map();
          for (const row of advanceRows) {
            if (liveIds.has(String(row.sourceId))) continue;
            const journalId = String(row.journalId);
            if (!orphanJournals.has(journalId)) orphanJournals.set(journalId, []);
            orphanJournals.get(journalId).push(row);
          }
          if (!orphanJournals.size) continue;

          for (const [, journalRows] of orphanJournals) {
            console.log(
              `  ${company.name || company._id}  orphan ${sourceModule} ${journalRows[0].narration}  ${journalRows.length} row(s)`,
            );
            droppedApplyJournals += 1;
            for (const row of journalRows) {
              const account = String(row.accountId);
              movement.set(account, round2((movement.get(account) || 0) - (row.debit || 0) + (row.credit || 0)));
            }
          }

          if (apply) {
            await LedgerEntry.deleteMany({
              companyId: company._id,
              journalId: { $in: [...orphanJournals.values()].map(rows => rows[0].journalId) },
            });
          }
        }
      }

      console.log(`\n${rebuilt} payment journal(s) to rebuild, ${droppedApplyJournals} apply/remove journal(s) dropped`);

      const moved = [...movement.entries()].filter(entry => entry[1] !== 0);
      if (moved.length) {
        const accounts = await models.books.Account.find({
          _id: { $in: moved.map(entry => new ObjectId(entry[0])) },
        })
          .select('accountName')
          .lean();
        const accountName = new Map(accounts.map(account => [String(account._id), account.accountName]));
        console.log('balances corrected:');
        for (const [account, amount] of moved) {
          console.log(
            `  ${String(accountName.get(account) || account).padEnd(28)} ${amount > 0 ? 'Dr' : 'Cr'} ${Math.abs(amount)}`,
          );
        }
      } else if (!rebuilt && !droppedApplyJournals) {
        console.log('no stale payment advance journals found');
      }

      console.log(apply ? '✅ Migration up completed' : 'ℹ️  Report only — rerun with --apply to write');
    } finally {
      await mongoose.disconnect();
    }
  },
};

if (require.main === module) {
  if (process.argv[2] !== 'up') {
    console.error('Usage: node migrations/rebuildStalePaymentAdvanceLedgers-remove.js up [--companyId=<id>] [--apply]');
    process.exit(1);
  }

  module.exports
    .up()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('❌ Migration up failed:', error);
      process.exit(1);
    });
}
