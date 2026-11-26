/**
 * Restates credit-note return batches that were valued at the selling rate.
 *
 * A sales return re-enters stock at the cost the goods left at. Until this was corrected the
 * batch was created at the credit note's line rate — the price the customer paid — so returned
 * stock sat on the balance sheet inflated by the margin, and reselling it charged that inflated
 * figure to cost of goods sold.
 *
 * The right cost comes from the invoice the return came from: its line holds the batches the
 * sale actually consumed, so their weighted average is what the goods cost. Where the note has
 * no invoice behind it, the item's own cost price stands in. A batch already at or below cost
 * is left alone, so re-running writes nothing.
 *
 * Warehouse inventoryValue is corrected by the same difference, keeping stock value in step
 * with the batches behind it.
 *
 * Run: node migrations/fixCreditNoteBatchCost.js                      (report, all companies)
 *      node migrations/fixCreditNoteBatchCost.js <companyId>           (report, one company)
 *      node migrations/fixCreditNoteBatchCost.js <companyId> --apply   (write)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;
    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};

    console.log(`\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(`Cluster: ${(process.env.ABSS_CLUSTER || '').replace(/\/\/.*@/, '//***@').split('/?')[0]}`);
    console.log(apply ? 'Mode: APPLYING CHANGES\n' : 'Mode: report only — pass --apply to write\n');

    const batches = db.booksCrm.collection('itembatches');
    const items = db.booksCrm.collection('items');
    const inventories = db.booksCrm.collection('iteminventories');
    const creditNotes = db.books.collection('creditnotes');
    const invoices = db.books.collection('invoices');

    const returnBatches = await batches.find({ ...scope, sourceType: 'CREDIT_NOTE' }).toArray();
    console.log(`credit-note batches found : ${returnBatches.length}`);

    // The cost a sale consumed, per credit note and item.
    const noteIds = [...new Set(returnBatches.map(batch => batch.sourceId?.toString()).filter(Boolean))];
    const notes = noteIds.length
      ? await creditNotes
          .find({ _id: { $in: noteIds.map(id => new ObjectId(id)) } })
          .project({ invoiceId: 1, creditNoteId: 1 })
          .toArray()
      : [];
    const noteById = new Map(notes.map(note => [note._id.toString(), note]));

    const invoiceIds = [...new Set(notes.map(note => note.invoiceId?.toString()).filter(Boolean))];
    const sourceInvoices = invoiceIds.length
      ? await invoices
          .find({ _id: { $in: invoiceIds.map(id => new ObjectId(id)) } })
          .project({ items: 1 })
          .toArray()
      : [];
    const soldCostByInvoiceItem = new Map();
    for (const invoice of sourceInvoices) {
      for (const line of invoice.items || []) {
        const quantity = (line.batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0), 0);
        const value = (line.batches || []).reduce(
          (sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0),
          0,
        );
        if (quantity > 0 && value > 0) {
          soldCostByInvoiceItem.set(`${invoice._id}:${line.itemId}`, round2(value / quantity));
        }
      }
    }

    const itemIds = [...new Set(returnBatches.map(batch => batch.itemId?.toString()).filter(Boolean))];
    const itemDocs = itemIds.length
      ? await items
          .find({ _id: { $in: itemIds.map(id => new ObjectId(id)) } })
          .project({ itemNo: 1, 'purchaseInformation.costPrice': 1 })
          .toArray()
      : [];
    const itemById = new Map(itemDocs.map(item => [item._id.toString(), item]));

    const toFix = [];
    let noCostKnown = 0;

    for (const batch of returnBatches) {
      const note = noteById.get(batch.sourceId?.toString());
      const fromInvoice = note?.invoiceId ? soldCostByInvoiceItem.get(`${note.invoiceId}:${batch.itemId}`) : undefined;
      const item = itemById.get(batch.itemId?.toString());
      const cost = fromInvoice !== undefined ? fromInvoice : round2(item?.purchaseInformation?.costPrice);

      if (!cost) {
        noCostKnown += 1;
        continue;
      }
      const current = round2(batch.purchasePrice);
      if (current <= cost) continue;

      toFix.push({
        batch,
        itemNo: item?.itemNo || batch.itemId,
        noteNo: note?.creditNoteId || '-',
        from: current,
        to: cost,
        source: fromInvoice !== undefined ? 'invoice' : 'item cost',
        valueDrop: round2((current - cost) * (Number(batch.quantity) || 0)),
      });
    }

    const totalDrop = round2(toFix.reduce((sum, row) => sum + row.valueDrop, 0));
    console.log(`  over-valued (above cost) : ${toFix.length}`);
    console.log(`  cost unknown, skipped    : ${noCostKnown}`);
    console.log(`  inventory value overstated by : ${totalDrop}`);
    toFix
      .slice(0, 10)
      .forEach(row =>
        console.log(
          `    ${String(row.itemNo).padEnd(12)} note ${String(row.noteNo).padEnd(10)} ${String(row.from).padStart(10)} -> ${String(row.to).padStart(10)}  (${row.source})`,
        ),
      );

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to correct.\n');
      return;
    }

    let batchesFixed = 0;
    let warehousesAdjusted = 0;
    for (const row of toFix) {
      await batches.updateOne({ _id: row.batch._id }, { $set: { purchasePrice: row.to } });
      batchesFixed += 1;

      if (!row.valueDrop) continue;
      const inventory = await inventories.findOne({ itemId: row.batch.itemId, companyId: row.batch.companyId });
      if (!inventory) continue;
      const warehouse = (inventory.warehouses || []).find(
        entry => entry.warehouseId?.toString() === row.batch.warehouseId?.toString(),
      );
      if (!warehouse) continue;

      await inventories.updateOne(
        { _id: inventory._id, 'warehouses.warehouseId': row.batch.warehouseId },
        {
          $set: {
            'warehouses.$[target].inventoryValue': round2((warehouse.inventoryValue || 0) - row.valueDrop),
            totalInventoryValue: round2((inventory.totalInventoryValue || 0) - row.valueDrop),
          },
        },
        { arrayFilters: [{ 'target.warehouseId': row.batch.warehouseId }] },
      );
      warehousesAdjusted += 1;
    }

    console.log('\nWRITTEN');
    console.log(`   batches restated to cost   : ${batchesFixed}`);
    console.log(`   warehouse values corrected : ${warehousesAdjusted}`);
    console.log('\nReturned stock now carries the cost it left at.\n');
  } catch (error) {
    console.error('Credit note batch cost fix failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
