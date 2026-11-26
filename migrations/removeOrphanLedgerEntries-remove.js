/**
 * Migration: remove ledger rows whose source document no longer exists.
 *
 * Deleting a document is supposed to take its journal with it. Some paths did not, so the ledger
 * still holds rows for payments, production orders and opening balances that were deleted. Those
 * rows show a blank Document No., no party and no branch, and nothing can ever fill them in —
 * there is no document left to read.
 *
 * A row is only treated as dead when its sourceId is in none of the places that module's ids can
 * live: the module's own collection, and — where a document posts a journal per line — the line
 * arrays of that collection. Opening balance is checked against all three collections it has ever
 * been posted from, so rows that splitOpeningBalanceSourceModules-remove would rescue are never touched.
 *
 * Journals are removed whole. A journal with even one row still attached to a live document is
 * left alone and reported, so a half-deleted journal can never be created here.
 *
 * A dead journal that does not balance is reported with the effect its removal has on the trial
 * balance, so that number is seen before it is applied rather than after.
 *
 * Run splitOpeningBalanceSourceModules-remove first: it rescues rows that would otherwise merely
 * look dead.
 *
 * Usage:
 *   node migrations/removeOrphanLedgerEntries-remove.js up                         report only, all companies
 *   node migrations/removeOrphanLedgerEntries-remove.js up --companyId=<id>        report only, one company
 *   node migrations/removeOrphanLedgerEntries-remove.js up --apply                 write, all companies
 *   node migrations/removeOrphanLedgerEntries-remove.js up --companyId=<id> --apply write, one company
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

// Advance apply/removal audit journals are owned by removeSurplusAdvanceReversals — never touched here.
const ADVANCE_AUDIT_NARRATION = { $regex: 'applied to|application removed', $options: 'i' };

// Every collection a module's sourceId may legitimately point at, and the line arrays inside it.
const OWNERS = {
  INVOICE: [{ db: 'books', collection: 'invoices', lineArrays: [] }],
  BILL: [{ db: 'books', collection: 'bills', lineArrays: [] }],
  GRPO: [{ db: 'books', collection: 'grpoorders', lineArrays: [] }],
  CREDIT_NOTE: [{ db: 'books', collection: 'creditnotes', lineArrays: ['refunds'] }],
  DEBIT_NOTE: [{ db: 'books', collection: 'debitnotes', lineArrays: ['refunds'] }],
  EXPENSE: [{ db: 'books', collection: 'expenses', lineArrays: [] }],
  PRODUCTION: [
    { db: 'books', collection: 'productionorders', lineArrays: ['submissionHistory', 'processBased.processes', 'rawMaterials'] },
  ],
  MANUAL_JOURNAL: [{ db: 'books', collection: 'manualjournals', lineArrays: ['journalEntries'] }],
  INVENTORY_ADJUSTMENT: [{ db: 'books', collection: 'inventoryadjustments', lineArrays: [] }],
  BANK_TRANSFER: [{ db: 'booksCrm', collection: 'banktransferlogs', lineArrays: [] }],
  PAYMENT_RECEIVED: [
    { db: 'booksCrm', collection: 'paymentreceiveds', lineArrays: ['invoices', 'openingBalanceTransactions', 'refunds'] },
  ],
  PAYMENT_MADE: [{ db: 'books', collection: 'paymentmades', lineArrays: ['bills', 'openingBalanceTransactions', 'refunds'] }],
  // Opening balance has been posted from all three of these, so all three are checked.
  OPENING_BALANCE: [
    { db: 'books', collection: 'accountopeningbalances', lineArrays: [] },
    { db: 'booksCrm', collection: 'openingbalancetransactions', lineArrays: [] },
    { db: 'booksCrm', collection: 'items', lineArrays: [] },
  ],
  OPENING_BALANCE_PARTY: [{ db: 'booksCrm', collection: 'openingbalancetransactions', lineArrays: [] }],
  OPENING_STOCK: [{ db: 'booksCrm', collection: 'items', lineArrays: [] }],
};

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

// A line array may sit inside a nested object, e.g. processBased.processes.
const linesAt = (document, path) => {
  let value = document;
  for (const key of path.split('.')) {
    value = value?.[key];
  }
  return value || [];
};

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

module.exports = {
  async up() {
    const { companyId, apply } = parseArgs();
    const connection = await getConnection();
    const { client, books } = connection;
    const ledgerEntries = books.collection('ledgerentries');
    const companyScope = companyId ? { companyId } : {};

    try {
      console.log(`Scope: ${companyId ? companyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

      let deletedRows = 0;
      let drift = 0;

      for (const sourceModule of Object.keys(OWNERS)) {
        const sourceIds = await ledgerEntries.distinct('sourceId', { sourceModule, ...companyScope });
        if (!sourceIds.length) continue;

        // Anything still reachable from a document, as the document itself or as one of its lines.
        const alive = new Set();
        for (const owner of OWNERS[sourceModule]) {
          const collection = connection[owner.db].collection(owner.collection);

          const documents = await collection
            .find({ _id: { $in: sourceIds } })
            .project({ _id: 1 })
            .toArray();
          for (const document of documents) {
            alive.add(String(document._id));
          }

          if (!owner.lineArrays.length) continue;

          const filter = [];
          const projection = { _id: 1 };
          for (const array of owner.lineArrays) {
            filter.push({ [`${array}._id`]: { $in: sourceIds } });
            projection[array] = 1;
          }

          const holders = await collection.find({ $or: filter }).project(projection).toArray();
          for (const holder of holders) {
            for (const array of owner.lineArrays) {
              for (const line of linesAt(holder, array)) {
                alive.add(String(line._id));
              }
            }
          }
        }

        const dead = sourceIds.filter(id => !alive.has(String(id)));
        if (!dead.length) continue;

        const rows = await ledgerEntries
          .find({ sourceModule, sourceId: { $in: dead }, narration: { $not: ADVANCE_AUDIT_NARRATION }, ...companyScope })
          .toArray();

        const journals = new Map();
        for (const row of rows) {
          const key = String(row.journalId);
          if (!journals.has(key)) {
            journals.set(key, { journalId: row.journalId, debit: 0, credit: 0, count: 0 });
          }
          const journal = journals.get(key);
          journal.debit += row.debit || 0;
          journal.credit += row.credit || 0;
          journal.count += 1;
        }

        const removable = [];
        let partlyLive = 0;
        let moduleRows = 0;
        let moduleDrift = 0;

        for (const journal of journals.values()) {
          const whole = await ledgerEntries.countDocuments({ journalId: journal.journalId });
          if (whole !== journal.count) {
            partlyLive += 1;
            continue;
          }
          removable.push(journal.journalId);
          moduleRows += journal.count;
          moduleDrift += round2(journal.debit) - round2(journal.credit);
        }

        deletedRows += moduleRows;
        drift += moduleDrift;

        let note = '';
        if (partlyLive) {
          note += `, ${partlyLive} journals left alone (still partly attached to a live document)`;
        }
        if (round2(moduleDrift)) {
          note += `, carrying ${round2(moduleDrift)} of imbalance`;
        }
        console.log(`  ${sourceModule.padEnd(24)} ${moduleRows} rows in ${removable.length} journals${note}`);

        if (apply && removable.length) {
          await ledgerEntries.deleteMany({ journalId: { $in: removable }, ...companyScope });
        }
      }

      console.log(`\n${deletedRows} rows in total`);
      if (round2(drift)) {
        console.log(`removing them takes ${round2(drift)} of imbalance out of the ledger — those journals never balanced`);
      }
      console.log(apply ? '✅ Migration up completed' : 'ℹ️  Report only — rerun with --apply to write');
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  if (process.argv[2] !== 'up') {
    console.error('Usage: node migrations/removeOrphanLedgerEntries-remove.js up [--companyId=<id>] [--apply]');
    process.exit(1);
  }

  module.exports
    .up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
