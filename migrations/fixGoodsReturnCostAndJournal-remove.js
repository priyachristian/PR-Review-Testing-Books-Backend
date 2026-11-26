/**
 * Goods Return credit notes: returned stock at cost, and the stock lines in the journal.
 *
 * 1. Price (BOOKS-720 period only): from 2026-10-23 the return batch was priced at the credit
 *    note's selling rate. It is restated to the cost the goods left at — the invoice's batches,
 *    else the delivery challan's, else the item cost price (same order as buildReturnCostMap).
 *    The ItemBatch keeps its price per entered unit (cost x conversionFactor); the note's
 *    items[].batches keep the per-main-unit cost. Warehouse value moves only for the quantity
 *    still in stock; any part already sold is reported, its sale is not touched.
 * 2. Journal: a note whose journal does not carry the returned stock (Inventory Dr / COGS Cr) at
 *    its batch value is posted again through ledger.service, exactly as a live save would.
 *
 * Notes before 2026-10-23 whose batch differs from cost are listed for review and not changed.
 *
 * Which notes are checked: type GOODS_RETURN, not deleted, status DRAFT / OPEN / PARTIALLY_USED /
 * USED / CLOSED (the statuses that carry a journal), with at least one return batch.
 *
 * Output: one table per company, one row per action, then a SUMMARY table.
 *
 *   Columns
 *     Credit Note / Date / Status   the note (Date = created date, which decides PRICE vs REVIEW)
 *     Action                        what the row is about, see below
 *     Item / Qty                    PRICE, REVIEW: the returned item and its main-unit quantity
 *     Rate now / Cost rate          PRICE, REVIEW: batch rate per main unit today / the cost it should be
 *     Cost from                     where the cost came from: invoice, delivery challan or item cost price
 *                                   (item cost price = no document batches; today's master value, weakest)
 *     Value now / Correct value     PRICE, REVIEW: Qty x rate, today and at cost
 *                                   JOURNAL: Inventory Asset posted today / what the return batches add up to
 *
 *   Action
 *     PRICE    created on/after 2026-10-23 and the batch is not at cost (BOOKS-720 used the selling
 *              rate). --apply re-prices the ItemBatch, the note's items[].batches and the warehouse value.
 *     JOURNAL  the note's Inventory Dr / COGS Cr does not equal its return batch value ("missing" = not
 *              posted at all). --apply deletes and re-posts the note's journal through ledger.service.
 *     REVIEW   created before 2026-10-23 and the batch is not at cost. Never changed: the cause is not
 *              BOOKS-720 and "Cost from: item cost price" may be newer than the batch. Check by hand.
 *              A REVIEW note can still get a JOURNAL row; it is posted at the batch value as it stands.
 *
 *   Result
 *     to fix                              report mode: what --apply would do
 *     not changed (before BOOKS-720)      REVIEW row, never written
 *     DONE                                written (one transaction per note)
 *     DONE (N already sold, sale not changed)
 *                                         re-priced, but N of the returned quantity was already sold at
 *                                         the old rate; that sale's COGS is not touched
 *     FAILED: <reason>                    nothing written for this note (its whole transaction rolled
 *                                         back); the run continues with the next note
 *
 *   SUMMARY (per company)
 *     Notes checked        Goods Return notes with batches
 *     Re-priced            notes with at least one PRICE row
 *     Stock value change   total of (Correct value - Value now) over PRICE rows
 *     Journals posted      notes with a JOURNAL row
 *     Inventory Dr added   total of (Correct value - Value now) over JOURNAL rows
 *     Review only          notes with at least one REVIEW row
 *     Failed               notes whose transaction failed
 *
 * After --apply, a report run should show only REVIEW rows (and FAILED ones to look at).
 *
 * Run: node migrations/fixGoodsReturnCostAndJournal-remove.js                      (report, all companies)
 *      node migrations/fixGoodsReturnCostAndJournal-remove.js <companyId>           (report, one company)
 *      node migrations/fixGoodsReturnCostAndJournal-remove.js <companyId> --apply   (write)
 *      node migrations/fixGoodsReturnCostAndJournal-remove.js --apply               (write, all companies)
 */
const mongoose = require('mongoose');
const config = require('../config/config');
const { getModelsAndConnections } = require('@smit9313/abss-models-core');
const modelService = require('../services/model.service');

const BOOKS_720_FROM = new Date('2026-10-23T00:00:00.000Z');
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

// Weighted cost per main unit, per item, from document lines that carry batches.
const weightedCostByItem = lines => {
  const totals = new Map();
  for (const line of lines) {
    const itemId = line.itemId?.toString();
    if (!itemId) continue;
    const total = totals.get(itemId) || { quantity: 0, value: 0 };
    for (const batch of line.batches || []) {
      total.quantity += Number(batch.quantity) || 0;
      total.value += (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0);
    }
    totals.set(itemId, total);
  }
  const costs = new Map();
  for (const [itemId, total] of totals) {
    if (total.quantity > 0 && total.value > 0) costs.set(itemId, round2(total.value / total.quantity));
  }
  return costs;
};

const batchValue = batches =>
  round2((batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0), 0));

const migrate = async () => {
  const rawConnection = await bootstrap();
  // Required after setApp, so the services resolve their models against the booted layer.
  const ledgerService = require('../modules/accountant/ledger/ledger.service');
  const { LEDGER_SOURCE_MODULES } = require('../utils/enum');
  const { CreditNote, Invoice, DeliveryChallan, LedgerEntry } = modelService.getBooksModels();
  const { Item, ItemBatch, ItemInventory } = modelService.getBooksCrmModels();
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

  const notes = await CreditNote.find({
    ...scope,
    type: 'GOODS_RETURN',
    isDeleted: { $ne: true },
    status: { $in: POSTED_STATUSES },
    'items.batches.0': { $exists: true },
  })
    .sort({ companyId: 1, createdAt: 1 })
    .lean();

  const invoiceIds = notes.map(note => note.invoiceId).filter(Boolean);
  const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
    .select('items deliveryChallanIds')
    .lean();
  const invoiceById = new Map(invoices.map(invoice => [invoice._id.toString(), invoice]));
  const challanIds = invoices
    .flatMap(invoice => (invoice.deliveryChallanIds || []).map(link => link.deliveryChallanId))
    .filter(Boolean);
  const challans = await DeliveryChallan.find({ _id: { $in: challanIds } })
    .select('items')
    .lean();
  const challanById = new Map(challans.map(challan => [challan._id.toString(), challan]));

  const itemIds = [...new Set(notes.flatMap(note => note.items.map(line => line.itemId?.toString())).filter(Boolean))];
  const items = await Item.find({ _id: { $in: itemIds } })
    .select('itemName purchaseInformation.costPrice inventoryAccountId')
    .lean();
  const itemById = new Map(items.map(item => [item._id.toString(), item]));
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

  // One table per company: a row per action, the last column says what happened to it.
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
    const totals = summary.get(companyId) || {
      notes: 0,
      repriced: 0,
      priceChange: 0,
      journals: 0,
      stockPosted: 0,
      review: 0,
      failed: 0,
    };
    summary.set(companyId, totals);
    totals.notes += 1;

    const invoice = invoiceById.get(note.invoiceId?.toString());
    const invoiceCost = weightedCostByItem(invoice?.items || []);
    const challanCost = weightedCostByItem(
      (invoice?.deliveryChallanIds || []).flatMap(link => challanById.get(link.deliveryChallanId?.toString())?.items || []),
    );
    const inBooks720Period = new Date(note.createdAt) >= BOOKS_720_FROM;

    const noteRow = values => ({
      'Credit Note': note.creditNoteId,
      Date: day(note.createdAt),
      Status: note.status,
      ...values,
    });
    const rows = [];
    const batchUpdates = [];

    for (const line of note.items) {
      if (!(line.batches || []).length) continue;
      const itemId = line.itemId?.toString();
      const item = itemById.get(itemId);
      const cost = invoiceCost.get(itemId) ?? challanCost.get(itemId) ?? round2(item?.purchaseInformation?.costPrice);
      const costSource = invoiceCost.has(itemId) ? 'invoice' : challanCost.has(itemId) ? 'delivery challan' : 'item cost price';

      for (const batch of line.batches) {
        const oldRate = round2(batch.purchasePrice);
        if (Math.abs(oldRate - cost) < 0.01) continue;
        const quantity = Number(batch.quantity) || 0;
        const row = noteRow({
          Action: inBooks720Period ? 'PRICE' : 'REVIEW',
          Item: String(item?.itemName || itemId).slice(0, 30),
          Qty: quantity,
          'Rate now': rupees(oldRate),
          'Cost rate': rupees(cost),
          'Cost from': costSource,
          'Value now': rupees(quantity * oldRate),
          'Correct value': rupees(quantity * cost),
          Result: inBooks720Period ? 'to fix' : 'not changed (before BOOKS-720)',
        });
        rows.push(row);
        if (inBooks720Period) batchUpdates.push({ batch, cost, row });
      }
    }

    const newItems = note.items.map(line => ({
      ...line,
      batches: (line.batches || []).map(batch => {
        const update = batchUpdates.find(entry => entry.batch === batch);
        return update ? { ...batch, purchasePrice: update.cost } : batch;
      }),
    }));
    const expectedStock = round2(newItems.reduce((sum, line) => sum + batchValue(line.batches), 0));

    const posted = await LedgerEntry.aggregate([
      { $match: { companyId: note.companyId, sourceId: note._id, accountId: { $in: inventoryAccountIds } } },
      { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
    const postedStock = round2((posted[0]?.debit || 0) - (posted[0]?.credit || 0));
    const repostJournal = Math.abs(postedStock - expectedStock) >= 0.01;

    if (repostJournal) {
      rows.push(
        noteRow({
          Action: 'JOURNAL',
          Item: postedStock ? 'Inventory Dr / COGS Cr wrong' : 'Inventory Dr / COGS Cr missing',
          Qty: '',
          'Rate now': '',
          'Cost rate': '',
          'Cost from': 'return batches',
          'Value now': rupees(postedStock),
          'Correct value': rupees(expectedStock),
          Result: 'to fix',
        }),
      );
    }
    if (!rows.length) continue;
    companyRows.push(...rows);
    if (rows.some(row => row.Action === 'REVIEW')) totals.review += 1;
    if (!batchUpdates.length && !repostJournal) continue;

    const countFixed = () => {
      totals.repriced += batchUpdates.length ? 1 : 0;
      totals.priceChange += batchUpdates.reduce(
        (sum, { batch, cost }) => sum + (Number(batch.quantity) || 0) * (cost - batch.purchasePrice),
        0,
      );
      totals.journals += repostJournal ? 1 : 0;
      totals.stockPosted += repostJournal ? expectedStock - postedStock : 0;
    };

    if (!apply) {
      countFixed();
      continue;
    }

    const fixRows = rows.filter(row => row.Action !== 'REVIEW');
    const session = await rawConnection.startSession();
    try {
      session.startTransaction();
      for (const { batch, cost, row } of batchUpdates) {
        const itemBatch = await ItemBatch.findById(batch.itemBatchId).session(session);
        if (!itemBatch) throw new Error(`ItemBatch ${batch.itemBatchId} not found`);
        const factor = Number(itemBatch.conversionFactor) || 1;
        const oldBaseRate = (Number(itemBatch.purchasePrice) || 0) / factor;
        const inStock = Number(itemBatch.remainingQty) || 0;
        const soldQuantity = round2((Number(itemBatch.quantity) || 0) - inStock);

        itemBatch.purchasePrice = round2(cost * factor);
        await itemBatch.save({ session });

        const valueDelta = round2(inStock * (cost - oldBaseRate));
        if (valueDelta) {
          await ItemInventory.updateOne(
            { itemId: itemBatch.itemId, companyId: itemBatch.companyId, 'warehouses.warehouseId': itemBatch.warehouseId },
            { $inc: { 'warehouses.$.inventoryValue': valueDelta, totalInventoryValue: valueDelta } },
            { session },
          );
        }
        if (soldQuantity > 0) row.Result = `DONE (${soldQuantity} already sold, sale not changed)`;
      }

      if (batchUpdates.length) {
        await CreditNote.updateOne({ _id: note._id }, { $set: { items: newItems } }, { session });
      }
      if (repostJournal) {
        await ledgerService.deleteJournal(
          { companyId: note.companyId, sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE, sourceId: note._id },
          session,
        );
        await ledgerService.postCreditNoteJournal(
          { companyId: note.companyId, creditNote: { ...note, items: newItems }, addedBy: note.updatedBy || note.addedBy },
          session,
        );
      }
      await session.commitTransaction();
      countFixed();
      fixRows.forEach(row => {
        if (row.Result === 'to fix') row.Result = 'DONE';
      });
    } catch (error) {
      await session.abortTransaction();
      totals.failed += 1;
      fixRows.forEach(row => {
        row.Result = `FAILED: ${error.message}`;
      });
    } finally {
      await session.endSession();
    }
  }
  printCompany();

  console.log('\nSUMMARY');
  console.table(
    [...summary.entries()]
      .filter(([, totals]) => totals.repriced || totals.journals || totals.review || totals.failed)
      .map(([companyId, totals]) => ({
        Company: String(companyName.get(companyId) || companyId).slice(0, 40),
        'Notes checked': totals.notes,
        'Re-priced': totals.repriced,
        'Stock value change': rupees(totals.priceChange),
        'Journals posted': totals.journals,
        'Inventory Dr added': rupees(totals.stockPosted),
        'Review only': totals.review,
        Failed: totals.failed,
      })),
  );
  console.log(
    apply
      ? '\nWritten. Re-run without --apply: it should list only REVIEW rows.\n'
      : '\nNothing was written. Re-run with --apply to correct.\n',
  );
  process.exit(0);
};

migrate().catch(error => {
  console.error('Goods return cost/journal fix failed:', error);
  process.exit(1);
});
