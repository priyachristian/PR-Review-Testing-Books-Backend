/**
 * Backfills ItemBatch.referenceBatches for existing batches.
 *
 * referenceBatches was added to the ItemBatch schema for the inventory transfer module to
 * store the batches a batch was derived from:
 *   [{ batchId: ObjectId(ItemBatch), batchNo: Number, quantity: Number, purchasePrice: Number }]
 *
 * For each APPROVED cross-warehouse transfer, every destination batch (sourceId = transfer _id) is
 * paired with the source batch it was deducted from (deductions.deductedSourceId = transfer _id) by
 * matching item, quantity and purchasePrice, and that source batch is written as the referenceBatch.
 *
 * Run: node migrations/backfillItemBatchReferenceBatches-remove.js                      (report, all companies)
 *      node migrations/backfillItemBatchReferenceBatches-remove.js <companyId>           (report, one company)
 *      node migrations/backfillItemBatchReferenceBatches-remove.js --apply               (write, all companies)
 *      node migrations/backfillItemBatchReferenceBatches-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

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

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    // Step 1: fetch all approved inventory transfers
    const transfers = await db.books
      .collection('inventorytransferrequests')
      .find({ ...scope, status: 'APPROVED' })
      .sort({ date: 1, createdAt: 1 })
      .toArray();
    console.log(`Approved inventory transfers found: ${transfers.length}\n`);

    // Step 2: fetch the batches linked to those transfers.
    //  - destination batches: created in toWarehouseId with sourceId = transfer _id (these get referenceBatches)
    //  - source batches: deducted from fromWarehouseId with deductions.deductedSourceId = transfer _id
    const itemBatches = db.booksCrm.collection('itembatches');
    const transferIds = transfers.map(t => t._id);
    const transferIdSet = new Set(transferIds.map(id => id.toString()));
    const TRANSFER_SOURCE_TYPES = ['MANUAL_STOCK_TRANSFER', 'PRODUCTIONORDER_STOCK_TRANSFER'];

    const [destBatchDocs, sourceBatchDocs] = transferIds.length
      ? await Promise.all([
          itemBatches.find({ sourceType: { $in: TRANSFER_SOURCE_TYPES }, sourceId: { $in: transferIds } }).toArray(),
          itemBatches
            .find({
              deductions: {
                $elemMatch: {
                  deductedSourceType: { $in: TRANSFER_SOURCE_TYPES },
                  deductedSourceId: { $in: transferIds },
                },
              },
            })
            .toArray(),
        ])
      : [[], []];

    const destBatchesByTransfer = new Map(); // transferId -> destination batches (toWarehouseId)
    destBatchDocs.forEach(batch => {
      const key = batch.sourceId.toString();
      if (!destBatchesByTransfer.has(key)) destBatchesByTransfer.set(key, []);
      destBatchesByTransfer.get(key).push(batch);
    });

    const sourceBatchesByTransfer = new Map(); // transferId -> source batches (fromWarehouseId)
    sourceBatchDocs.forEach(batch => {
      batch.deductions.forEach(deduction => {
        const key = deduction.deductedSourceId?.toString();
        if (!key || !transferIdSet.has(key)) return;
        if (!sourceBatchesByTransfer.has(key)) sourceBatchesByTransfer.set(key, []);
        sourceBatchesByTransfer.get(key).push({ batch, deduction });
      });
    });

    console.log(`Destination batches found: ${destBatchDocs.length}`);
    console.log(`Source batches found     : ${sourceBatchDocs.length}\n`);

    // Step 3: save the source batch details as referenceBatches on the destination batch.
    // Two kinds of transfer exist (see approveInventoryTransfer):
    //  - manual (MANUAL_STOCK_TRANSFER): moves request.itemId
    //  - production (PRODUCTIONORDER_STOCK_TRANSFER, isProductionOrderReq with rawMaterials): moves
    //    each rawMaterials[].rawMaterialId, never request.itemId, so one request spans several items
    // The transfer creates one destination batch per source batch deducted (same item, quantity
    // and purchasePrice), so each destination batch is paired with the not-yet-used source entry
    // of the same item that carries the same values. vendorBatchNo is not part of the match: the
    // transfer does not copy it onto the destination batch, so it is always null here.
    const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-6;

    const ops = [];
    const unmatched = [];
    let alreadySet = 0;

    transfers.forEach(transfer => {
      const key = transfer._id.toString();
      const isProduction = transfer.isProductionOrderReq === true && (transfer.rawMaterials || []).length > 0;
      const transferSourceType = isProduction ? 'PRODUCTIONORDER_STOCK_TRANSFER' : 'MANUAL_STOCK_TRANSFER';
      const transferItemIds = new Set(
        (isProduction ? transfer.rawMaterials.map(rm => rm.rawMaterialId) : [transfer.itemId])
          .filter(Boolean)
          .map(id => id.toString()),
      );
      const destBatches = (destBatchesByTransfer.get(key) || []).filter(
        batch =>
          batch.sourceType === transferSourceType &&
          batch.warehouseId &&
          batch.warehouseId.equals(transfer.toWarehouseId) &&
          transferItemIds.has(batch.itemId.toString()),
      );
      const sourceEntries = (sourceBatchesByTransfer.get(key) || []).filter(
        ({ batch, deduction }) =>
          deduction.deductedSourceType === transferSourceType &&
          batch.warehouseId &&
          batch.warehouseId.equals(transfer.fromWarehouseId) &&
          transferItemIds.has(batch.itemId.toString()),
      );
      const used = new Set();

      destBatches
        .sort((a, b) => a.batchNo - b.batchNo)
        .forEach(dest => {
          if (dest.referenceBatches && dest.referenceBatches.length) {
            alreadySet += 1;
            return;
          }
          const matchIndex = sourceEntries.findIndex(
            ({ batch, deduction }, index) =>
              !used.has(index) &&
              batch.itemId.equals(dest.itemId) &&
              near(deduction.quantityDeducted, dest.quantity) &&
              near(batch.purchasePrice, dest.purchasePrice),
          );
          if (matchIndex === -1) {
            unmatched.push({ transferId: transfer.transferId || key, destBatchId: dest._id, batchNo: dest.batchNo });
            return;
          }
          used.add(matchIndex);
          const { batch: source, deduction } = sourceEntries[matchIndex];
          ops.push({
            updateOne: {
              filter: { _id: dest._id },
              update: {
                $set: {
                  referenceBatches: [
                    {
                      batchId: source._id,
                      batchNo: source.batchNo,
                      quantity: deduction.quantityDeducted,
                      purchasePrice: source.purchasePrice,
                    },
                  ],
                },
              },
            },
          });
        });
    });

    let written = 0;
    if (apply && ops.length) {
      const result = await itemBatches.bulkWrite(ops, { ordered: false });
      written = result.modifiedCount;
    }

    console.log(
      `Destination batches  pending: ${String(ops.length).padStart(5)}   already set: ${String(alreadySet).padStart(5)}` +
        `   unmatched: ${String(unmatched.length).padStart(5)}` +
        (apply ? `   written: ${String(written).padStart(5)}` : ''),
    );
    if (unmatched.length) {
      console.log('\nUNMATCHED destination batches (no source batch with the same qty / price / vendor batch):');
      unmatched.slice(0, 30).forEach(u => console.log(`   transfer ${u.transferId}  batch ${u.destBatchId} (#${u.batchNo})`));
      if (unmatched.length > 30) console.log(`   ... and ${unmatched.length - 30} more`);
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    console.log('\nItemBatch.referenceBatches backfilled.\n');
  } catch (error) {
    console.error('ItemBatch referenceBatches backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
