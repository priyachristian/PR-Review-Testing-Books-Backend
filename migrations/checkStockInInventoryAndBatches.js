const { getConnection } = require('../config/db');
const fs = require('fs');
const { ObjectId } = require('mongoose').Types;

const APPLY = process.argv.includes('--apply');
const STOCK_TOLERANCE = 0.001;
const VALUE_TOLERANCE = 0.01;

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const buildWarehouseMap = itemBatches => {
  const map = new Map();
  for (const batch of itemBatches) {
    if (!batch.warehouseId) continue;
    const key = String(batch.warehouseId);
    const qty = Number(batch.remainingQty) || 0;
    const price = Number(batch.purchasePrice) || 0;
    const existing = map.get(key) || {
      warehouseId: batch.warehouseId,
      branchId: batch.branchId,
      divisionId: batch.divisionId,
      availableStock: 0,
      inventoryValue: 0,
    };
    existing.availableStock += qty;
    existing.inventoryValue += qty * price;
    map.set(key, existing);
  }
  for (const entry of map.values()) {
    entry.inventoryValue = round2(entry.inventoryValue);
  }
  return map;
};

async function checkStockInInventoryAndBatches() {
  const connection = await getConnection();
  const client = connection.client;

  try {
    const booksCrmDb = connection.booksCrm;
    const ItemBatch = booksCrmDb.collection('itembatches');
    const ItemInventory = booksCrmDb.collection('iteminventories');
    const itemInventories = await ItemInventory.find({}).toArray();

    console.log(`Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}\n`);

    const items = [];
    const companySummaryMap = new Map();
    let counter = 0;
    let appliedCount = 0;
    let skippedNoBatch = 0;

    for (const item of itemInventories) {
      const itemBatches = await ItemBatch.find({ itemId: item.itemId, companyId: item.companyId }).toArray();

      if (!itemBatches.length) {
        skippedNoBatch++;
        continue;
      }

      const warehouseMap = buildWarehouseMap(itemBatches);
      const totalStockFromBatches = [...warehouseMap.values()].reduce((sum, w) => sum + w.availableStock, 0);
      const totalValueFromBatches = round2([...warehouseMap.values()].reduce((sum, w) => sum + w.inventoryValue, 0));
      const totalStockInInventory = Number(item.totalAvailableStock) || 0;
      const totalValueInInventory = Number(item.totalInventoryValue) || 0;

      const existingWarehouses = item.warehouses || [];
      const seenWarehouseIds = new Set();
      const warehouseDiffs = [];
      let warehouseMismatch = false;

      const updatedWarehouses = existingWarehouses.map(wh => {
        const key = wh.warehouseId ? String(wh.warehouseId) : null;
        const target = key && warehouseMap.has(key) ? warehouseMap.get(key) : { availableStock: 0, inventoryValue: 0 };
        const currentStock = Number(wh.availableStock) || 0;
        const currentValue = Number(wh.inventoryValue) || 0;
        if (key) seenWarehouseIds.add(key);
        if (
          Math.abs(target.availableStock - currentStock) > STOCK_TOLERANCE ||
          Math.abs(target.inventoryValue - currentValue) > VALUE_TOLERANCE
        ) {
          warehouseMismatch = true;
          warehouseDiffs.push({
            warehouseId: key,
            stock: { from: currentStock, to: target.availableStock },
            value: { from: currentValue, to: target.inventoryValue },
          });
        }
        return { ...wh, availableStock: target.availableStock, inventoryValue: target.inventoryValue };
      });

      for (const [key, info] of warehouseMap.entries()) {
        if (seenWarehouseIds.has(key)) continue;
        warehouseMismatch = true;
        warehouseDiffs.push({
          warehouseId: key,
          stock: { from: 'missing', to: info.availableStock },
          value: { from: 'missing', to: info.inventoryValue },
        });
        updatedWarehouses.push({
          divisionId: info.divisionId,
          branchId: info.branchId,
          warehouseId: info.warehouseId,
          isActive: true,
          openingStock: 0,
          availableStock: info.availableStock,
          inventoryValue: info.inventoryValue,
        });
      }

      const totalStockMismatch = Math.abs(totalStockFromBatches - totalStockInInventory) > STOCK_TOLERANCE;
      const totalValueMismatch = Math.abs(totalValueFromBatches - totalValueInInventory) > VALUE_TOLERANCE;

      if (totalStockMismatch || totalValueMismatch || warehouseMismatch) {
        counter++;
        const companyId = item.companyId ? String(item.companyId) : 'Unknown';
        companySummaryMap.set(companyId, (companySummaryMap.get(companyId) || 0) + 1);

        items.push({
          companyId,
          itemId: String(item.itemId),
          itemInventoryId: String(item._id),
          totalStock: { batches: totalStockFromBatches, inventory: totalStockInInventory },
          totalValue: { batches: totalValueFromBatches, inventory: totalValueInInventory },
          warehouseDiffs,
        });

        if (APPLY) {
          const newTotalStock = updatedWarehouses.reduce((sum, w) => sum + (Number(w.availableStock) || 0), 0);
          const newTotalValue = round2(updatedWarehouses.reduce((sum, w) => sum + (Number(w.inventoryValue) || 0), 0));
          await ItemInventory.updateOne(
            { _id: item._id },
            { $set: { warehouses: updatedWarehouses, totalAvailableStock: newTotalStock, totalInventoryValue: newTotalValue } },
          );
          appliedCount++;
        }
      }
    }

    if (items.length > 0) {
      console.table(
        items.map(({ companyId, itemId, totalStock, totalValue, warehouseDiffs }) => ({
          companyId,
          itemId,
          stockBatches: totalStock.batches,
          stockInventory: totalStock.inventory,
          valueBatches: totalValue.batches,
          valueInventory: totalValue.inventory,
          warehousesFixed: warehouseDiffs.length,
        })),
      );
    }

    const companyIds = [...companySummaryMap.keys()]
      .filter(companyId => companyId !== 'Unknown')
      .map(companyId => new ObjectId(companyId));
    const companies = await connection.common
      .collection('companies')
      .find({ _id: { $in: companyIds } })
      .toArray();
    const companyNameById = new Map(companies.map(company => [String(company._id), company.name || '']));

    const companySummary = [...companySummaryMap.entries()]
      .map(([companyId, mismatchCount]) => ({
        companyId,
        companyName: companyNameById.get(companyId) || (companyId === 'Unknown' ? 'Unknown' : ''),
        mismatchCount,
      }))
      .sort((a, b) => b.mismatchCount - a.mismatchCount);

    console.log('\nCompany-wise mismatch summary:');
    console.table(companySummary);
    console.log(`Skipped (no batch document): ${skippedNoBatch}`);
    console.log(`Total items with mismatch: ${counter}`);
    if (APPLY) {
      console.log(`Applied fixes (stock + valuation, total + warehouse-wise, synced to batches): ${appliedCount}`);
    } else {
      console.log('Dry run — re-run with --apply to write these fixes.');
    }
    fs.writeFileSync('items.json', JSON.stringify(items, null, 2));
  } catch (error) {
    console.error('Error checking stock in inventory and batches:', error);
  } finally {
    await client.close();
  }
}

checkStockInInventoryAndBatches();
