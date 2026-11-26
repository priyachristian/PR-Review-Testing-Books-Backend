/**
 * Goods Return debit notes: the journal must carry the returned stock and match the document.
 *
 * A debit note posted on create read its items before the returned batches were set on them, so the
 * journal credited the line amount to the item's purchase/expense account instead of Inventory Asset
 * at cost (with the rate difference to Purchase Discounts). An edit never re-posted the journal at all.
 * The batches stored on the note are right (they come from the FIFO deduction), so the fix is only the
 * journal: it is deleted and posted again through ledger.service, exactly as a live save would.
 *
 * Which notes are checked: type GOODS_RETURN, not deleted, status DRAFT / OPEN / PARTIALLY_USED / USED /
 * CLOSED (the statuses that carry a journal), with at least one return batch.
 *
 * Output: one table per company, one row per note that needs it, then a SUMMARY table.
 *
 *   Columns
 *     Debit Note / Date / Status   the note
 *     Problem                      what is wrong with its journal, see below
 *     Inventory Cr now / correct   Inventory Asset credit posted today / the return batches' value at cost
 *     AP Dr now / correct          vendor (Accounts Payable) line posted today / note total x exchange rate
 *     Result                       see below
 *
 *   Problem
 *     STOCK MISSING   no Inventory credit at all - the create-path bug
 *     STOCK WRONG     Inventory credit present but not equal to the batch value
 *     TOTAL WRONG     vendor line does not equal the note total - the journal was not re-posted after an edit
 *
 *   Result
 *     to fix             report mode: --apply would delete and re-post this note's journal
 *     DONE               re-posted (one transaction per note)
 *     FAILED: <reason>   nothing written for this note; the run continues
 *
 *   SUMMARY (per company)
 *     Notes checked / Journals re-posted / Inventory Cr added (correct - now) / Failed
 *
 * After --apply, a report run should list no rows.
 *
 * Run: node migrations/fixGoodsReturnDebitNoteJournal-remove.js                      (report, all companies)
 *      node migrations/fixGoodsReturnDebitNoteJournal-remove.js <companyId>           (report, one company)
 *      node migrations/fixGoodsReturnDebitNoteJournal-remove.js <companyId> --apply   (write)
 *      node migrations/fixGoodsReturnDebitNoteJournal-remove.js --apply               (write, all companies)
 */
const mongoose = require('mongoose');
const config = require('../config/config');
const { getModelsAndConnections } = require('@smit9313/abss-models-core');
const modelService = require('../services/model.service');

const POSTED_STATUSES = ['DRAFT', 'OPEN', 'PARTIALLY_USED', 'USED', 'CLOSED'];

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const rupees = value => `₹${round2(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = date => new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const bootstrap = async () => {
  // A data fix must not build indexes or collections on the live database.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const { models, connections } = await getModelsAndConnections(config.mongoose.db_names);
  modelService.setApp({
    locals: {
      db: {
        connections: {
          common: connections.common,
          booksCrm: connections['books-crm'],
          books: connections.books,
          crm: connections.crm,
          abssAdmin: connections['abss-admin'],
        },
        models: {
          common: models.common,
          booksCrm: models['books-crm'],
          books: models.books,
          crm: models.crm,
          abssAdmin: models['abss-admin'],
        },
        connection: connections.rawConnection,
      },
    },
  });
  return connections.rawConnection;
};

const migrate = async () => {
  const rawConnection = await bootstrap();
  // Required after setApp, so the services resolve their models against the booted layer.
  const ledgerService = require('../modules/accountant/ledger/ledger.service');
  const { LEDGER_SOURCE_MODULES } = require('../utils/enum');
  const { DebitNote, LedgerEntry } = modelService.getBooksModels();
  const { Item } = modelService.getBooksCrmModels();
  const { Company } = modelService.getCommonModels();

  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const companyArg = args.find(arg => !arg.startsWith('--'));
  const scope = companyArg ? { companyId: new mongoose.Types.ObjectId(companyArg) } : {};

  console.log('\nRUN');
  console.table([
    {
      Scope: companyArg || 'ALL COMPANIES',
      Database: config.mongoose.db_names.books,
      Mode: apply ? 'APPLYING CHANGES' : 'REPORT ONLY (nothing is written)',
    },
  ]);

  const notes = await DebitNote.find({
    ...scope,
    type: 'GOODS_RETURN',
    isDeleted: { $ne: true },
    status: { $in: POSTED_STATUSES },
    'items.batches.0': { $exists: true },
  })
    .sort({ companyId: 1, createdAt: 1 })
    .lean();

  const itemIds = [...new Set(notes.flatMap(note => note.items.map(line => line.itemId?.toString())).filter(Boolean))];
  const items = await Item.find({ _id: { $in: itemIds } })
    .select('inventoryAccountId')
    .lean();
  const inventoryAccountIds = [...new Set(items.map(item => item.inventoryAccountId?.toString()).filter(Boolean))].map(
    id => new mongoose.Types.ObjectId(id),
  );

  const companies = await Company.find({ _id: { $in: [...new Set(notes.map(note => note.companyId.toString()))] } })
    .select('name')
    .lean();
  const companyName = new Map(companies.map(company => [company._id.toString(), company.name]));

  const summary = new Map();
  let currentCompany = null;
  let companyRows = [];

  const printCompany = () => {
    if (!currentCompany || !companyRows.length) return;
    console.log(`\n${companyName.get(currentCompany) || currentCompany} (${currentCompany})`);
    console.table(companyRows);
  };

  for (const note of notes) {
    const companyId = note.companyId.toString();
    if (companyId !== currentCompany) {
      printCompany();
      currentCompany = companyId;
      companyRows = [];
    }
    const totals = summary.get(companyId) || { notes: 0, journals: 0, stockAdded: 0, failed: 0 };
    summary.set(companyId, totals);
    totals.notes += 1;

    const correctStock = round2(
      note.items.reduce(
        (sum, line) =>
          sum + (line.batches || []).reduce((s, b) => s + (Number(b.quantity) || 0) * (Number(b.purchasePrice) || 0), 0),
        0,
      ),
    );
    const correctPayable = round2((Number(note.total) || 0) * (Number(note.exchangeRate) || 1));

    const entries = await LedgerEntry.find({ companyId: note.companyId, sourceId: note._id })
      .select('accountId debit credit partyType')
      .lean();
    const inventoryAccountKeys = new Set(inventoryAccountIds.map(String));
    const stockNow = round2(
      entries
        .filter(entry => inventoryAccountKeys.has(String(entry.accountId)))
        .reduce((sum, entry) => sum + (entry.credit || 0) - (entry.debit || 0), 0),
    );
    const payableNow = round2(
      entries
        .filter(entry => entry.partyType === 'VENDOR')
        .reduce((sum, entry) => sum + (entry.debit || 0) - (entry.credit || 0), 0),
    );

    const stockWrong = Math.abs(stockNow - correctStock) >= 0.01;
    const totalWrong = Math.abs(payableNow - correctPayable) >= 1;
    if (!stockWrong && !totalWrong) continue;

    const problems = [];
    if (stockWrong) problems.push(stockNow ? 'STOCK WRONG' : 'STOCK MISSING');
    if (totalWrong) problems.push('TOTAL WRONG');
    const row = {
      'Debit Note': note.debitNoteId,
      Date: day(note.createdAt),
      Status: note.status,
      Problem: problems.join(' + '),
      'Inventory Cr now': rupees(stockNow),
      'Inventory Cr correct': rupees(correctStock),
      'AP Dr now': rupees(payableNow),
      'AP Dr correct': rupees(correctPayable),
      Result: 'to fix',
    };
    companyRows.push(row);

    if (!apply) {
      totals.journals += 1;
      totals.stockAdded += correctStock - stockNow;
      continue;
    }

    const session = await rawConnection.startSession();
    try {
      session.startTransaction();
      await ledgerService.deleteJournal(
        { companyId: note.companyId, sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE, sourceId: note._id },
        session,
      );
      await ledgerService.postDebitNoteJournal(
        { companyId: note.companyId, debitNote: note, addedBy: note.updatedBy || note.addedBy },
        session,
      );
      await session.commitTransaction();
      totals.journals += 1;
      totals.stockAdded += correctStock - stockNow;
      row.Result = 'DONE';
    } catch (error) {
      await session.abortTransaction();
      totals.failed += 1;
      row.Result = `FAILED: ${error.message}`;
    } finally {
      await session.endSession();
    }
  }
  printCompany();

  console.log('\nSUMMARY');
  console.table(
    [...summary.entries()]
      .filter(([, totals]) => totals.journals || totals.failed)
      .map(([companyId, totals]) => ({
        Company: String(companyName.get(companyId) || companyId).slice(0, 40),
        'Notes checked': totals.notes,
        'Journals re-posted': totals.journals,
        'Inventory Cr added': rupees(totals.stockAdded),
        Failed: totals.failed,
      })),
  );
  console.log(
    apply
      ? '\nWritten. Re-run without --apply: it should list no rows.\n'
      : '\nNothing was written. Re-run with --apply to correct.\n',
  );
  process.exit(0);
};

migrate().catch(error => {
  console.error('Goods return debit note journal fix failed:', error);
  process.exit(1);
});
