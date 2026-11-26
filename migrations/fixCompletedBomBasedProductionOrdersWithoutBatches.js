/**
 * Fix: for each COMPLETED, BOM_BASED production order that has an empty root `batches` array
 * (see reportCompletedBomBasedProductionOrdersWithoutBatches.js for the read-only scan this
 * mirrors). The empty array turns out to have two distinct causes, handled differently:
 *
 * CASE 2 - REPAIR (the common case): an ItemBatch (sourceType: 'PRODUCTION_ORDER',
 *   sourceId: order._id) already exists, so the produced stock WAS recorded in the inventory
 *   sub-ledger - only the denormalized productionOrder.batches array was never populated.
 *   Rebuild that array from the authoritative ItemBatch rows (batchNo, quantity, purchasePrice,
 *   warehouseId, itemBatchId). NO inventory or ledger change - the stock already exists.
 *
 * CASE 1 - BACKFILL (only when no ItemBatch exists): the produced stock was never recorded at
 *   all, so recreate it the same way addStock() in warehouseBatch.service.js would have:
 *     1. Create one ItemBatch for the order's finished-goods item. quantity =
 *        order.totalFgSubmittedQty (cumulative actually-submitted qty). NOT order.fgSubmittedQty
 *        (overwritten per-submission), NOT order.quantity (planned; overstates if units were
 *        rejected).
 *     2. purchasePrice = the item's current purchaseInformation.costPrice - the same fallback
 *        submitProductionOrder() uses when a submission has no cost breakdown. The order's own
 *        historical raw-material/labor cost cannot be reconstructed.
 *     3. Increment ItemInventory like updateWarehouseInventory(): per-warehouse
 *        availableStock/inventoryValue plus document-level totalAvailableStock/totalInventoryValue.
 *     4. Push the new batch onto productionOrder.batches (root level).
 *
 * After --apply the report should show zero matches for every order this script touched (both cases).
 *
 * NOT touched: submissionHistory[].batches. There's no reliable way to attribute the backfilled
 * quantity to one specific historical submission, so submission-level records are left as-is.
 *
 * NOT touched (CASE 1 backfill only): the GENERAL LEDGER. A backfill rebuilds only the inventory
 * sub-ledger (ItemBatch + ItemInventory value); it does not post a production journal, and it
 * values stock at the item's current master costPrice (historical production cost is
 * unrecoverable). The finished-goods Inventory GL account is therefore NOT moved to match. Confirm
 * with Accounting that these orders represent real production, and reconcile the finished-goods
 * Inventory GL balance separately. (CASE 2 repairs touch no inventory or ledger at all.)
 *
 * Scope: mirrors the report — COMPLETED / BOM_BASED orders with empty batches, createdAt in 2026.
 *
 * Skipped (reported, never written):
 *   - totalFgSubmittedQty <= 0 - nothing was actually submitted, so there's no stock to add
 *     (a COMPLETED order can get there via rejections alone)
 *   - finished-goods item is not stock-tracked (itemCategory.isService or trackInventory: false)
 *     - handleWarehouseStock() would have skipped batch creation for these too; empty batches
 *       here is correct, not a bug
 *   - (backfill only) order.inventoryInwarehouseId missing, or that warehouse no longer exists
 *   - (backfill only) no ItemInventory document exists yet for the item (nothing to increment safely)
 *
 * Idempotent / safe to re-run: once an order's batches array is populated it no longer matches the
 * scope, and an order that already has an ItemBatch is repaired (never re-backfilled), so stock is
 * never double-counted.
 *
 * Each CASE 1 backfill runs inside its own multi-document transaction (ItemBatch insert +
 * ItemInventory increment + ProductionOrder.batches push), so a failure partway through one order
 * cannot leave it half-fixed. CASE 2 repairs are a single-document ProductionOrder update.
 *
 * DRY RUN BY DEFAULT - pass --apply to write.
 *
 * Usage:
 *   node migrations/fixCompletedBomBasedProductionOrdersWithoutBatches.js                    (dry run, all companies)
 *   node migrations/fixCompletedBomBasedProductionOrdersWithoutBatches.js --companyId=<id>    (dry run, one company)
 *   node migrations/fixCompletedBomBasedProductionOrdersWithoutBatches.js --apply              (writes changes)
 *   node migrations/fixCompletedBomBasedProductionOrdersWithoutBatches.js --apply --companyId=<id>
 *
 * Against another environment, supply its connection through the environment rather than
 * editing .env, for example:
 *   ABSS_CLUSTER='<uri>' ABSS_BOOKS='<db>' ABSS_CORE_DEV='<db>' ABSS_BOOKS_CRM_DEV='<db>' \
 *   ABSS_CRM_DEV='<db>' ABSS_ADMIN='<db>' node migrations/fixCompletedBomBasedProductionOrdersWithoutBatches.js
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PRODUCTION_ORDER_STATUS_COMPLETED = 'COMPLETED';
const PRODUCTION_MANAGE_METHOD_BOM_BASED = 'BOM_BASED';
const SOURCE_TYPE = 'PRODUCTION_ORDER';
const CREATED_AT_YEAR_START = new Date('2026-01-01T00:00:00.000Z');
const CREATED_AT_YEAR_END = new Date('2027-01-01T00:00:00.000Z');

function parseArgs(argv) {
  const shouldApply = argv.includes('--apply');
  const hit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { shouldApply, companyId: companyArg ? new ObjectId(companyArg) : null };
}

function roundQty(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function orderLabel(order) {
  return order.productionOrderCode || order._id.toString();
}

const fix = async () => {
  let client;
  try {
    const { shouldApply, companyId: onlyCompanyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;

    printSection('fixCompletedBomBasedProductionOrdersWithoutBatches', '═');
    console.log(`\nMode: ${shouldApply ? 'APPLY (will write changes)' : 'DRY RUN (no changes written)'}`);
    console.log(`Scope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(
      `createdAt window: 2026-01-01 to 2026-12-31   (matches reportCompletedBomBasedProductionOrdersWithoutBatches.js)`,
    );

    const ProductionOrders = db.books.collection('productionorders');
    const ItemBatch = db.booksCrm.collection('itembatches');
    const ItemInventory = db.booksCrm.collection('iteminventories');
    const Items = db.booksCrm.collection('items');
    const Warehouses = db.booksCrm.collection('warehouses');

    const scope = {
      status: PRODUCTION_ORDER_STATUS_COMPLETED,
      productionManageMethod: PRODUCTION_MANAGE_METHOD_BOM_BASED,
      $or: [{ batches: { $exists: false } }, { batches: { $size: 0 } }],
      createdAt: { $gte: CREATED_AT_YEAR_START, $lt: CREATED_AT_YEAR_END },
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
    };

    const orders = await ProductionOrders.find(scope).toArray();

    if (!orders.length) {
      console.log('\n✅ No COMPLETED / BOM_BASED production orders with empty batches found.\n');
      return;
    }
    console.log(`\nFound ${orders.length} matching production order(s).\n`);

    const toRepair = [];
    const toFix = [];
    const skipped = [];

    for (const order of orders) {
      const skip = reason => skipped.push({ order, reason });

      if (!order.itemId || !order.companyId) {
        skip('missing itemId/companyId on the order');
        continue;
      }

      const [item, existingBatches] = await Promise.all([
        Items.findOne({ _id: order.itemId, companyId: order.companyId }),
        ItemBatch.find({ sourceType: SOURCE_TYPE, sourceId: order._id }).toArray(),
      ]);

      if (!item) {
        skip('finished-goods item not found');
        continue;
      }
      if (item?.itemCategory?.isService === true || item?.trackInventory === false) {
        skip('item is not stock-tracked - addStock() would have skipped it too, empty batches is correct');
        continue;
      }

      // Case 2 - the stock was already recorded as ItemBatch(es); only the denormalized
      // productionOrder.batches array is empty. Rebuild that array from the authoritative
      // ItemBatch rows. No inventory or ledger change - the stock already exists.
      if (existingBatches.length) {
        toRepair.push({ order, item, batches: existingBatches });
        continue;
      }

      // Case 1 - no ItemBatch exists, so the produced stock was never recorded at all. Backfill it.
      const quantity = roundQty(order.totalFgSubmittedQty || 0);
      if (quantity <= 0) {
        skip('totalFgSubmittedQty is 0 - nothing was actually submitted for this order');
        continue;
      }
      if (!order.inventoryInwarehouseId) {
        skip('missing inventoryInwarehouseId (finished-goods warehouse)');
        continue;
      }

      const [warehouse, inventory] = await Promise.all([
        Warehouses.findOne({ _id: order.inventoryInwarehouseId }),
        ItemInventory.findOne({ itemId: order.itemId, companyId: order.companyId }),
      ]);

      if (!warehouse) {
        skip('finished-goods warehouse not found');
        continue;
      }
      if (!inventory) {
        skip('no ItemInventory document exists yet for this item - cannot safely increment');
        continue;
      }

      const purchasePrice = round2(item.purchaseInformation?.costPrice || 0);
      const value = round2(quantity * purchasePrice);

      toFix.push({ order, item, warehouse, quantity, purchasePrice, value });
    }

    printSection(`Will repair batches array from existing ItemBatch (${toRepair.length})`);
    if (!toRepair.length) console.log('\n  None.\n');
    else
      console.table(
        toRepair.map(r => ({
          productionOrderCode: orderLabel(r.order),
          productionOrderId: r.order._id.toString(),
          itemName: r.item.itemName || '(unnamed)',
          existingBatches: r.batches.length,
          quantity: r.batches.reduce((sum, b) => sum + (b.quantity || 0), 0),
        })),
      );

    printSection(`Will backfill missing stock (${toFix.length})`);
    if (!toFix.length) console.log('\n  None.\n');
    else
      console.table(
        toFix.map(f => ({
          productionOrderCode: orderLabel(f.order),
          productionOrderId: f.order._id.toString(),
          companyId: f.order.companyId.toString(),
          itemName: f.item.itemName || '(unnamed)',
          quantity: f.quantity,
          purchasePrice: f.purchasePrice,
          value: f.value,
          warehouseId: f.warehouse._id.toString(),
        })),
      );

    printSection(`Skipped (${skipped.length})`);
    if (!skipped.length) console.log('\n  None.\n');
    else
      console.table(
        skipped.map(s => ({
          productionOrderCode: orderLabel(s.order),
          productionOrderId: s.order._id.toString(),
          reason: s.reason,
        })),
      );

    if (toFix.length) {
      printSection('⚠  Accounting note (read before --apply)', '═');
      console.log(
        '\n  This backfill rebuilds the INVENTORY sub-ledger only (ItemBatch + ItemInventory value).\n' +
          "  It does NOT post a production GL journal, and it values stock at the item's current\n" +
          '  master costPrice (historical production cost is unrecoverable). The finished-goods\n' +
          '  Inventory GL account will therefore NOT move by these amounts.\n\n' +
          '  Confirm with Accounting that these orders represent real production and reconcile the\n' +
          '  finished-goods Inventory GL balance separately after applying.\n',
      );
    }

    if (!shouldApply) {
      console.log('\nℹ️  DRY RUN - no changes were written. Re-run with --apply to commit the fix.\n');
      return;
    }

    if (!toFix.length && !toRepair.length) {
      console.log('\nNothing to apply.\n');
      return;
    }

    let appliedCount = 0;
    const failures = [];

    if (toRepair.length) {
      console.log(`\nRepairing batches array on ${toRepair.length} production order(s)...\n`);
      for (const r of toRepair) {
        try {
          await ProductionOrders.updateOne(
            { _id: r.order._id },
            {
              $set: {
                batches: r.batches.map(b => ({
                  batchNo: b.batchNo,
                  quantity: b.quantity,
                  purchasePrice: b.purchasePrice,
                  warehouseId: b.warehouseId,
                  itemBatchId: b._id,
                })),
              },
            },
          );
          appliedCount++;
          console.log(`  ✅ Repaired ${orderLabel(r.order)} (${r.order._id.toString()})`);
        } catch (err) {
          failures.push({ order: r.order, error: err.message });
          console.error(`  ❌ Failed to repair ${orderLabel(r.order)}: ${err.message}`);
        }
      }
    }

    if (toFix.length) console.log(`\nBackfilling stock on ${toFix.length} production order(s)...\n`);

    for (const f of toFix) {
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const lastBatch = await ItemBatch.find(
            { itemId: f.order.itemId, companyId: f.order.companyId, warehouseId: f.order.inventoryInwarehouseId },
            { session },
          )
            .sort({ batchNo: -1 })
            .limit(1)
            .toArray();
          const batchNo = lastBatch.length ? lastBatch[0].batchNo + 1 : 1;

          // Backdated to the order's own production date so the batch lands in its historical
          // place rather than appearing to have been produced "today".
          const historicalDate = f.order.productionDate || f.order.createdAt || new Date();

          const batchDoc = {
            itemId: f.order.itemId,
            companyId: f.order.companyId,
            divisionId: f.warehouse.divisionId,
            branchId: f.warehouse.branchId,
            warehouseId: f.order.inventoryInwarehouseId,
            batchNo,
            quantity: f.quantity,
            remainingQty: f.quantity,
            purchasePrice: f.purchasePrice,
            vendorBatchNo: null,
            userBatchNo: null,
            vendorBatchExpiry: null,
            sourceType: SOURCE_TYPE,
            sourceId: f.order._id,
            deductions: [],
            addedBy: null,
            createdAt: historicalDate,
            updatedAt: historicalDate,
          };

          const insertResult = await ItemBatch.insertOne(batchDoc, { session });
          const itemBatchId = insertResult.insertedId;

          const warehouseIdStr = String(f.order.inventoryInwarehouseId);

          const incResult = await ItemInventory.updateOne(
            {
              itemId: f.order.itemId,
              companyId: f.order.companyId,
              warehouses: { $elemMatch: { warehouseId: f.order.inventoryInwarehouseId } },
            },
            [
              {
                $set: {
                  warehouses: {
                    $map: {
                      input: '$warehouses',
                      as: 'wh',
                      in: {
                        $cond: [
                          { $eq: [{ $toString: '$$wh.warehouseId' }, warehouseIdStr] },
                          {
                            $mergeObjects: [
                              '$$wh',
                              {
                                availableStock: {
                                  $round: [{ $add: [{ $ifNull: ['$$wh.availableStock', 0] }, f.quantity] }, 3],
                                },
                                inventoryValue: { $add: [{ $ifNull: ['$$wh.inventoryValue', 0] }, f.value] },
                              },
                            ],
                          },
                          '$$wh',
                        ],
                      },
                    },
                  },
                  totalAvailableStock: { $round: [{ $add: [{ $ifNull: ['$totalAvailableStock', 0] }, f.quantity] }, 3] },
                  totalInventoryValue: { $add: [{ $ifNull: ['$totalInventoryValue', 0] }, f.value] },
                },
              },
            ],
            { session },
          );

          if (incResult.matchedCount === 0) {
            // No entry for this warehouse yet on the ItemInventory doc - add one (same fallback
            // updateWarehouseInventory() takes when stockDelta > 0 and the warehouse is missing).
            await ItemInventory.updateOne(
              { itemId: f.order.itemId, companyId: f.order.companyId },
              [
                {
                  $set: {
                    warehouses: {
                      $concatArrays: [
                        { $ifNull: ['$warehouses', []] },
                        [
                          {
                            warehouseId: f.order.inventoryInwarehouseId,
                            branchId: f.warehouse.branchId,
                            divisionId: f.warehouse.divisionId,
                            availableStock: f.quantity,
                            openingStock: 0,
                            inventoryValue: f.value,
                            isActive: true,
                          },
                        ],
                      ],
                    },
                    totalAvailableStock: { $round: [{ $add: [{ $ifNull: ['$totalAvailableStock', 0] }, f.quantity] }, 3] },
                    totalInventoryValue: { $add: [{ $ifNull: ['$totalInventoryValue', 0] }, f.value] },
                  },
                },
              ],
              { session },
            );
          }

          await ProductionOrders.updateOne(
            { _id: f.order._id },
            {
              $push: {
                batches: {
                  batchNo,
                  quantity: f.quantity,
                  purchasePrice: f.purchasePrice,
                  warehouseId: f.order.inventoryInwarehouseId,
                  itemBatchId,
                },
              },
            },
            { session },
          );
        });

        appliedCount++;
        console.log(`  ✅ Fixed ${orderLabel(f.order)} (${f.order._id.toString()})`);
      } catch (err) {
        failures.push({ order: f.order, error: err.message });
        console.error(`  ❌ Failed to fix ${orderLabel(f.order)}: ${err.message}`);
      } finally {
        await session.endSession();
      }
    }

    console.log(
      `\n✅ Applied to ${appliedCount}/${toRepair.length + toFix.length} production orders (${toRepair.length} repaired, ${toFix.length} backfilled).`,
    );
    if (failures.length) {
      printSection(`Failures (${failures.length})`);
      console.table(failures.map(fl => ({ productionOrderId: fl.order._id.toString(), error: fl.error })));
    }
    console.log('');
  } catch (error) {
    console.error('Fix failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

fix();
