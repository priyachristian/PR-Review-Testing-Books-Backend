const { getConnection } = require('../config/db');
const fs = require('fs');
const { ObjectId } = require('mongoose').Types;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FIX_NO_BATCH = args.includes('--fix-no-batch');
const ONLY_NO_BATCH = args.includes('--only-no-batch');
const INCLUDE_STOCK = args.includes('--include-stock');
const getArg = name => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : null;
};
const COMPANY = getArg('company');
const ITEM = getArg('item');
const VALUE_TOLERANCE = Number(getArg('tolerance')) || 0.01;
const STOCK_TOLERANCE = 0.001;

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const buildWarehouseLedger = batches => {
  const map = new Map();
  for (const b of batches) {
    if (!b.warehouseId) continue;
    const key = String(b.warehouseId);
    const qty = Number(b.remainingQty) || 0;
    const price = Number(b.purchasePrice) || 0;
    const entry = map.get(key) || {
      warehouseId: b.warehouseId,
      branchId: b.branchId,
      divisionId: b.divisionId,
      availableStock: 0,
      inventoryValue: 0,
    };
    entry.availableStock += qty;
    entry.inventoryValue += qty * price;
    map.set(key, entry);
  }
  for (const entry of map.values()) {
    entry.availableStock = round2(entry.availableStock);
    entry.inventoryValue = round2(entry.inventoryValue);
  }
  return map;
};

async function verifyItemValuation() {
  const connection = await getConnection();
  const client = connection.client;

  try {
    const crm = connection.booksCrm;
    const ItemBatch = crm.collection('itembatches');
    const ItemInventory = crm.collection('iteminventories');
    const Item = crm.collection('items');

    const filter = {};
    if (COMPANY) filter.companyId = new ObjectId(COMPANY);
    if (ITEM) filter.itemId = new ObjectId(ITEM);

    const inventories = await ItemInventory.find(filter).toArray();

    console.log('Item Valuation Verification (batch ledger = source of truth)');
    console.log(`Mode:  ${APPLY ? 'APPLY (writing value fixes)' : 'DRY RUN (no changes)'}`);
    console.log(`Scope: ${COMPANY ? 'company=' + COMPANY : 'all companies'}${ITEM ? ', item=' + ITEM : ''}`);
    console.log(`Also fixing stock: ${INCLUDE_STOCK ? 'yes' : 'no (value only)'}`);
    console.log(`Value tolerance: ${VALUE_TOLERANCE}\n`);

    const mismatches = [];
    const noBatchWithValue = [];
    let checked = 0;
    let applied = 0;

    for (const inv of inventories) {
      checked++;
      const batches = await ItemBatch.find({ itemId: inv.itemId, companyId: inv.companyId }).toArray();
      const ledger = buildWarehouseLedger(batches);
      const ledgerTotalValue = round2([...ledger.values()].reduce((s, w) => s + w.inventoryValue, 0));
      const ledgerTotalStock = round2([...ledger.values()].reduce((s, w) => s + w.availableStock, 0));
      const storedTotalValue = round2(inv.totalInventoryValue);

      const storedWarehouses = inv.warehouses || [];
      const seen = new Set();
      const warehouseDiffs = [];
      let warehouseMismatch = false;

      const fixedWarehouses = storedWarehouses.map(wh => {
        const key = wh.warehouseId ? String(wh.warehouseId) : null;
        const target = key && ledger.has(key) ? ledger.get(key) : { availableStock: 0, inventoryValue: 0 };
        if (key) seen.add(key);
        const storedValue = round2(wh.inventoryValue);
        const storedStock = Number(wh.availableStock) || 0;
        const valueOff = Math.abs(target.inventoryValue - storedValue) > VALUE_TOLERANCE;
        const stockOff = INCLUDE_STOCK && Math.abs(target.availableStock - storedStock) > STOCK_TOLERANCE;
        if (valueOff || stockOff) {
          warehouseMismatch = true;
          warehouseDiffs.push({
            warehouseId: key,
            storedValue,
            ledgerValue: target.inventoryValue,
            valueDiff: round2(storedValue - target.inventoryValue),
            storedStock,
            ledgerStock: target.availableStock,
          });
        }
        const next = { ...wh, inventoryValue: target.inventoryValue };
        if (INCLUDE_STOCK) next.availableStock = target.availableStock;
        return next;
      });

      for (const [key, info] of ledger.entries()) {
        if (seen.has(key)) continue;
        warehouseMismatch = true;
        warehouseDiffs.push({
          warehouseId: key,
          storedValue: 'missing',
          ledgerValue: info.inventoryValue,
          valueDiff: null,
          storedStock: 'missing',
          ledgerStock: info.availableStock,
        });
        fixedWarehouses.push({
          divisionId: info.divisionId,
          branchId: info.branchId,
          warehouseId: info.warehouseId,
          isActive: true,
          openingStock: 0,
          availableStock: info.availableStock,
          inventoryValue: info.inventoryValue,
        });
      }

      if (!batches.length) {
        const hasStoredValue =
          Math.abs(storedTotalValue) > VALUE_TOLERANCE ||
          storedWarehouses.some(w => Math.abs(round2(w.inventoryValue)) > VALUE_TOLERANCE);
        if (hasStoredValue) {
          noBatchWithValue.push({
            companyId: String(inv.companyId),
            itemId: String(inv.itemId),
            itemInventoryId: String(inv._id),
            storedTotalValue,
            storedTotalStock: round2(inv.totalAvailableStock),
          });
          if (APPLY && FIX_NO_BATCH) {
            const zeroed = storedWarehouses.map(w => ({
              ...w,
              inventoryValue: 0,
              ...(INCLUDE_STOCK ? { availableStock: 0 } : {}),
            }));
            const set = { warehouses: zeroed, totalInventoryValue: 0 };
            if (INCLUDE_STOCK) set.totalAvailableStock = 0;
            await ItemInventory.updateOne({ _id: inv._id }, { $set: set });
            applied++;
          }
        }
        continue;
      }

      const totalMismatch = Math.abs(ledgerTotalValue - storedTotalValue) > VALUE_TOLERANCE;

      if (warehouseMismatch || totalMismatch) {
        mismatches.push({
          companyId: String(inv.companyId),
          itemId: String(inv.itemId),
          itemInventoryId: String(inv._id),
          totalValue: { stored: storedTotalValue, ledger: ledgerTotalValue, diff: round2(storedTotalValue - ledgerTotalValue) },
          warehouseDiffs,
        });
        if (APPLY && !ONLY_NO_BATCH) {
          const set = { warehouses: fixedWarehouses, totalInventoryValue: ledgerTotalValue };
          if (INCLUDE_STOCK) set.totalAvailableStock = ledgerTotalStock;
          await ItemInventory.updateOne({ _id: inv._id }, { $set: set });
          applied++;
        }
      }
    }

    const idsForNames = [...new Set([...mismatches, ...noBatchWithValue].map(m => m.itemId))].map(id => new ObjectId(id));
    const itemDocs = idsForNames.length
      ? await Item.find({ _id: { $in: idsForNames } }, { projection: { itemName: 1, itemNo: 1 } }).toArray()
      : [];
    const nameById = new Map(
      itemDocs.map(d => [String(d._id), `${d.itemName || ''}${d.itemNo ? ' (' + d.itemNo + ')' : ''}`.trim()]),
    );
    const label = id => nameById.get(id) || id;

    if (mismatches.length) {
      console.log('Value mismatches (item has batches):');
      console.table(
        mismatches.map(m => ({
          item: label(m.itemId),
          storedValue: m.totalValue.stored,
          ledgerValue: m.totalValue.ledger,
          diff: m.totalValue.diff,
          warehouses: m.warehouseDiffs.length,
        })),
      );
    }

    if (noBatchWithValue.length) {
      console.log('\nItems with stored value but NO batches (value should be 0 — likely need batch backfill;');
      console.log('not auto-zeroed unless you pass --fix-no-batch):');
      console.table(
        noBatchWithValue.map(m => ({
          item: label(m.itemId),
          storedTotalValue: m.storedTotalValue,
          storedTotalStock: m.storedTotalStock,
        })),
      );
    }

    console.log(`\nChecked item-inventories: ${checked}`);
    console.log(`Value mismatches (with batches): ${mismatches.length}`);
    console.log(`No-batch-but-has-value: ${noBatchWithValue.length}`);
    if (APPLY) console.log(`Applied value fixes: ${applied}`);
    else console.log('Dry run — re-run with --apply to write these fixes.');

    fs.writeFileSync('valuation-mismatches.json', JSON.stringify({ mismatches, noBatchWithValue }, null, 2));
    console.log('Detailed report written to valuation-mismatches.json');
  } catch (error) {
    console.error('verifyItemValuation error:', error);
  } finally {
    await client.close();
  }
}

verifyItemValuation();
