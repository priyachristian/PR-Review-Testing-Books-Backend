/**
 * Verify that inventory batches (ItemBatch) are in sync with item inventory (ItemInventory).
 *
 * Compares:
 *   - ItemInventory.totalAvailableStock vs sum(ItemBatch.remainingQty) per item
 *   - ItemInventory.warehouses[].availableStock vs sum(ItemBatch.remainingQty) per (item, warehouse)
 *
 * ItemBatch can be stored in either:
 *   - booksCrm (itembatches): flat, one document per batch (itemId, warehouseId, remainingQty)
 *   - books (itembatches): one doc per item with branchDetails[].availableBatches[].remainingQty
 * The script detects structure and aggregates accordingly.
 *
 * Usage:
 *   node scripts/verify-inventory-batch-sync.js [--companyId=xxx] [--itemId=xxx] [--verbose]
 *
 * Requires: NODE_ENV and .env with ABSS_CLUSTER and db names.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  let itemId = null;
  let verbose = false;
  for (const a of args) {
    if (a.startsWith('--companyId=')) companyId = a.split('=')[1].trim();
    else if (a.startsWith('--itemId=')) itemId = a.split('=')[1].trim();
    else if (a === '--verbose' || a === '-v') verbose = true;
  }
  return { companyId, itemId, verbose };
}

/**
 * Compute per-item and per-(item, warehouse) totals from ItemBatch (flat: one doc per batch).
 */
async function getBatchTotalsFlat(batchColl, companyIdFilter, itemIdFilter) {
  const match = {};
  if (companyIdFilter) match.companyId = new mongoose.Types.ObjectId(companyIdFilter);
  if (itemIdFilter) match.itemId = new mongoose.Types.ObjectId(itemIdFilter);

  const byItem = await batchColl
    .aggregate([
      { $match: match },
      { $group: { _id: '$itemId', totalRemaining: { $sum: '$remainingQty' } } },
      { $project: { itemId: '$_id', totalRemaining: 1, _id: 0 } },
    ])
    .toArray();

  const byItemWarehouse = await batchColl
    .aggregate([
      { $match: { ...match, warehouseId: { $exists: true, $ne: null } } },
      { $group: { _id: { itemId: '$itemId', warehouseId: '$warehouseId' }, totalRemaining: { $sum: '$remainingQty' } } },
      { $project: { itemId: '$_id.itemId', warehouseId: '$_id.warehouseId', totalRemaining: 1, _id: 0 } },
    ])
    .toArray();

  const totalByItem = new Map(byItem.map(r => [r.itemId.toString(), r.totalRemaining]));
  const totalByItemWarehouse = new Map(byItemWarehouse.map(r => [`${r.itemId}_${r.warehouseId}`, r.totalRemaining]));
  return { totalByItem, totalByItemWarehouse };
}

/**
 * Compute per-item and per-(item, warehouse) totals from ItemBatch (nested: branchDetails.availableBatches).
 */
async function getBatchTotalsNested(batchColl, companyIdFilter, itemIdFilter) {
  const match = { branchDetails: { $exists: true, $ne: [] } };
  if (companyIdFilter) match.companyId = new mongoose.Types.ObjectId(companyIdFilter);
  if (itemIdFilter) match.itemId = new mongoose.Types.ObjectId(itemIdFilter);

  const batches = await batchColl.find(match).project({ itemId: 1, branchDetails: 1 }).toArray();

  const totalByItem = new Map();
  const totalByItemWarehouse = new Map();

  for (const doc of batches) {
    const itemIdStr = doc.itemId?.toString();
    if (!itemIdStr) continue;
    let itemTotal = 0;
    const whMap = new Map();

    for (const branch of doc.branchDetails || []) {
      const warehouseId = branch.warehouseId?.toString();
      for (const b of branch.availableBatches || []) {
        const qty = Number(b.remainingQty) ?? Number(b.quantity) ?? 0;
        itemTotal += qty;
        if (warehouseId) whMap.set(warehouseId, (whMap.get(warehouseId) || 0) + qty);
      }
    }

    totalByItem.set(itemIdStr, (totalByItem.get(itemIdStr) || 0) + itemTotal);
    for (const [whId, sum] of whMap) {
      const key = `${itemIdStr}_${whId}`;
      totalByItemWarehouse.set(key, (totalByItemWarehouse.get(key) || 0) + sum);
    }
  }

  return { totalByItem, totalByItemWarehouse };
}

function roundQty(val) {
  if (val == null || val === undefined) return 0;
  return Math.round(Number(val) * 1000) / 1000;
}

async function run() {
  const { companyId, itemId, verbose } = parseArgs();
  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const booksCrmDb = db.booksCrm;
    const booksDb = db.books;

    const invColl = booksCrmDb.collection('iteminventories');
    let batchCollCrm = booksCrmDb.collection('itembatches');
    const batchCollBooks = booksDb.collection('itembatches');

    const companyIdFilter = companyId || null;
    const itemIdFilter = itemId || null;

    const invMatch = { itemId: { $exists: true, $ne: null } };
    if (companyIdFilter) invMatch.companyId = new mongoose.Types.ObjectId(companyIdFilter);
    if (itemIdFilter) invMatch.itemId = new mongoose.Types.ObjectId(itemIdFilter);

    const inventories = await invColl
      .find(invMatch)
      .project({ itemId: 1, companyId: 1, totalAvailableStock: 1, warehouses: 1 })
      .toArray();

    if (inventories.length === 0) {
      console.log('No item inventory documents found for the given filters.');
      return;
    }

    const batchMatch = companyIdFilter ? { companyId: new mongoose.Types.ObjectId(companyIdFilter) } : {};
    let batchColl = batchCollCrm;
    let batchDbName = 'booksCrm';
    if ((await batchCollCrm.countDocuments(batchMatch)) === 0 && (await batchCollBooks.countDocuments(batchMatch)) > 0) {
      batchColl = batchCollBooks;
      batchDbName = 'books';
    }
    const sampleBatch = await batchColl.findOne(batchMatch);
    const useNested = sampleBatch && sampleBatch.branchDetails && Array.isArray(sampleBatch.branchDetails);

    const { totalByItem, totalByItemWarehouse } = useNested
      ? await getBatchTotalsNested(batchColl, companyIdFilter, itemIdFilter)
      : await getBatchTotalsFlat(batchColl, companyIdFilter, itemIdFilter);

    const mismatches = [];
    let checkedItems = 0;
    let checkedWarehouses = 0;

    for (const inv of inventories) {
      const itemIdStr = inv.itemId?.toString();
      if (!itemIdStr) continue;

      const invTotal = roundQty(inv.totalAvailableStock);
      const batchTotal = roundQty(totalByItem.get(itemIdStr) ?? 0);
      const totalDiff = roundQty(invTotal - batchTotal);
      checkedItems++;

      if (Math.abs(totalDiff) > 0.001) {
        mismatches.push({
          type: 'total',
          itemId: itemIdStr,
          inventoryStock: invTotal,
          batchTotal,
          diff: totalDiff,
        });
      } else if (verbose) {
        console.log(`OK [total] item ${itemIdStr}: inventory=${invTotal} batch=${batchTotal}`);
      }

      const warehouses = inv.warehouses || [];
      for (const wh of warehouses) {
        const whId = wh.warehouseId?.toString();
        if (!whId) continue;
        checkedWarehouses++;
        const invWhStock = roundQty(wh.availableStock);
        const batchWhTotal = roundQty(totalByItemWarehouse.get(`${itemIdStr}_${whId}`) ?? 0);
        const whDiff = roundQty(invWhStock - batchWhTotal);
        if (Math.abs(whDiff) > 0.001) {
          mismatches.push({
            type: 'warehouse',
            itemId: itemIdStr,
            warehouseId: whId,
            inventoryStock: invWhStock,
            batchTotal: batchWhTotal,
            diff: whDiff,
          });
        } else if (verbose) {
          console.log(`OK [warehouse] item ${itemIdStr} wh ${whId}: inventory=${invWhStock} batch=${batchWhTotal}`);
        }
      }
    }

    console.log('\n--- Inventory vs batch verification ---');
    console.log(`Batch structure: ${useNested ? 'nested (branchDetails)' : 'flat (one doc per batch)'}`);
    console.log(`Batch DB: ${batchDbName}`);
    console.log(`Items checked: ${checkedItems}`);
    console.log(`Warehouse rows checked: ${checkedWarehouses}`);
    console.log(`Total mismatches: ${mismatches.length}`);

    if (mismatches.length > 0) {
      console.log('\nMismatch details (inventory stock vs batch total, diff = inventory - batch):');
      console.table(mismatches);
      process.exitCode = 1;
    } else {
      console.log('All inventory and batch quantities are in sync.');
    }
  } catch (err) {
    console.error('Error:', err);
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
  }
}

run();
