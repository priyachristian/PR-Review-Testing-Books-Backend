/**
 * Read-only detail of items that hold stock but are not inventory items.
 *
 * These are already inconsistent: the warehouse shows quantity, but the purchase was
 * expensed instead of capitalised, so nothing on the balance sheet backs that stock.
 * Once the stock engine honours trackInventory they stop gaining stock; this report
 * exists so each one can be judged individually — genuine stock item wrongly flagged
 * (mark it tracked) versus a consumable that should never have had stock (adjust it out).
 *
 * Writes nothing.
 *
 * Run: node migrations/reportOrphanStockItems.js              (all companies)
 *      node migrations/reportOrphanStockItems.js <companyId>   (one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const report = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const targetCompanyId = process.argv[2] ? new ObjectId(process.argv[2]) : null;
    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};
    console.log(`\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}   (read-only)\n`);

    // Stock is read from what was actually put in: the quantity left on the batches, and the
    // opening figures entered against the item or its warehouses. The running availableStock
    // totals are deliberately not used - they are maintained separately, drift from the batches,
    // and an item counts as holding stock on the strength of the real quantity, not a total.
    const inventories = await db.booksCrm
      .collection('iteminventories')
      .find({
        ...scope,
        $or: [{ totalOpeningStock: { $gt: 0 } }, { warehouses: { $elemMatch: { openingStock: { $gt: 0 } } } }],
      })
      .project({ itemId: 1, companyId: 1, totalOpeningStock: 1, totalInventoryValue: 1, warehouses: 1 })
      .toArray();

    const batchStockRows = await db.booksCrm
      .collection('itembatches')
      .aggregate([
        { $match: { ...scope, remainingQty: { $gt: 0 } } },
        {
          $group: {
            _id: '$itemId',
            quantity: { $sum: '$remainingQty' },
            value: { $sum: { $multiply: ['$remainingQty', '$purchasePrice'] } },
          },
        },
      ])
      .toArray();
    const batchByItemId = new Map(batchStockRows.map(row => [row._id?.toString(), row]));

    const inventoryByItemId = new Map(inventories.map(row => [row.itemId?.toString(), row]));
    const itemIdById = new Map();
    inventories.forEach(row => row.itemId && itemIdById.set(row.itemId.toString(), row.itemId));
    batchStockRows.forEach(row => row._id && itemIdById.set(row._id.toString(), row._id));
    const itemIds = [...itemIdById.values()];
    if (!itemIds.length) {
      console.log('No items hold stock in this scope.\n');
      return;
    }

    const orphans = await db.booksCrm
      .collection('items')
      .find({
        _id: { $in: itemIds },
        $or: [{ 'itemClassification.inventoryItem': false }, { 'itemCategory.isService': true }],
      })
      .project({ itemNo: 1, itemName: 1, itemType: 1, itemCategory: 1, itemClassification: 1, companyId: 1, defaultPrice: 1 })
      .toArray();

    if (!orphans.length) {
      console.log('No orphan stock found — every item holding stock is a proper inventory item.\n');
      return;
    }

    const companies = await db.common
      .collection('companies')
      .find({
        _id: { $in: [...new Set(orphans.map(item => item.companyId?.toString()))].filter(Boolean).map(id => new ObjectId(id)) },
      })
      .project({ name: 1 })
      .toArray();
    const companyNameById = new Map(companies.map(company => [company._id.toString(), company.name]));

    const warehouses = await db.booksCrm
      .collection('warehouses')
      .find({ ...scope })
      .project({ name: 1 })
      .toArray();
    const warehouseNameById = new Map(warehouses.map(warehouse => [warehouse._id.toString(), warehouse.name]));

    let totalValue = 0;
    let index = 0;

    for (const item of orphans) {
      index += 1;
      const inventory = inventoryByItemId.get(item._id.toString());
      const batch = batchByItemId.get(item._id.toString());
      const reason = item.itemCategory?.isService ? 'SERVICE (can never hold stock)' : 'inventoryItem = false (not tracked)';
      // Value the batches when the inventory record has none: an item found only through its
      // batches would otherwise be reported as holding nothing, which is the opposite of true.
      const value = Number(inventory?.totalInventoryValue) || Math.round((Number(batch?.value) || 0) * 100) / 100;
      totalValue += value;

      console.log(`${index}. ${item.itemNo || '(no code)'}  —  ${item.itemName || '(no name)'}`);
      console.log(`   company   : ${companyNameById.get(item.companyId?.toString()) || item.companyId}`);
      console.log(`   why orphan: ${reason}`);
      console.log(`   item type : ${item.itemType || '-'}    default price: ${item.defaultPrice ?? '-'}`);
      console.log(`   opening   : ${inventory?.totalOpeningStock ?? 0}    stock value: ${value}`);
      if (batch) console.log(`   in batches: qty ${batch.quantity}, value ${Math.round((Number(batch.value) || 0) * 100) / 100}`);

      const stocked = (inventory?.warehouses || []).filter(warehouse => Number(warehouse.openingStock) > 0);
      for (const warehouse of stocked) {
        const name = warehouseNameById.get(warehouse.warehouseId?.toString()) || warehouse.warehouseId;
        console.log(`     - ${name}: opening ${warehouse.openingStock}, value ${warehouse.inventoryValue ?? 0}`);
      }
      console.log('');
    }

    console.log('SUMMARY');
    console.log(`   orphan items      : ${orphans.length}`);
    console.log(`   services          : ${orphans.filter(item => item.itemCategory?.isService).length}`);
    console.log(`   untracked goods   : ${orphans.filter(item => !item.itemCategory?.isService).length}`);
    console.log(`   total stock value : ${Math.round(totalValue * 100) / 100}`);
    console.log('\nFor each item decide: mark it tracked (genuine stock item), or adjust the stock out (consumable).');
    console.log('Nothing was written.\n');
  } catch (error) {
    console.error('Report failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

report();
