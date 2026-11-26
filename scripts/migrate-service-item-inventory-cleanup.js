/**
 * migrate-service-item-inventory-cleanup.js
 *
 * What this file is for
 * ----------------------
 * One-off data cleanup after BOOKS-678 (and related backend changes): service items must not
 * participate in inventory. Application code no longer creates or updates ItemInventory for
 * service items, but older databases can still have ItemInventory rows linked to those items.
 * This script finds those legacy rows and can remove them when it is safe to do so.
 *
 * What it changes in the database
 * ---------------------------------
 * - With --apply: deletes documents from booksCrm `iteminventories` only (ItemInventory), and only
 *   for items where `itemCategory.isService` is true on booksCrm `items`.
 * - It does NOT modify Item master rows, warehouse masters, or transactions. It does NOT delete
 *   `itembatches` in booksCrm or books; it only uses batch collections to decide whether an
 *   inventory row is safe to remove.
 *
 * Scope
 * -----
 * Runs across all companies (no per-company filter).
 *
 * Safety model
 * ------------
 * - Default: dry-run (no writes). Logs counts and, with --verbose, a sample of "risky" rows.
 * - With --apply: deletes ONLY inventory docs that are "safe":
 *     - all totals and per-warehouse stock/value fields are zero, and
 *     - no ItemBatch documents exist for that item in booksCrm or books `itembatches`.
 * - Anything else is listed as risky for manual review (not deleted).
 *
 * Batch counting (why it is written this way)
 * --------------------------------------------
 * Per batch document: if `branchDetails` is a non-empty array, nested batches are summed; otherwise
 * root-level `remainingQty` / `quantity` are used. That avoids wrong totals when tenants mix flat
 * and nested batch document shapes.
 *
 * Usage
 * -----
 *   node scripts/migrate-service-item-inventory-cleanup.js
 *   node scripts/migrate-service-item-inventory-cleanup.js --apply
 *   node scripts/migrate-service-item-inventory-cleanup.js --apply --verbose
 *
 * Reading the console summary (after a run)
 * ------------------------------------------
 * - Service items found: count of items in `items` with itemCategory.isService true (masters only).
 * - Service item inventories found: ItemInventory docs whose itemId is one of those service items.
 *   Can be less than service items (no inventory row) or equal; not every service item has a row.
 * - Safe inventory docs to delete: inventory rows that passed all checks (all stock/value zero,
 *   no batch docs). These are the only ones --apply will remove.
 * - Risky inventory docs (manual review): rows still linked to a service item but NOT safe—e.g.
 *   non-zero stock/value on totals or warehouses, or any ItemBatch in booksCrm/books. The script
 *   does not delete them; investigate in DB/UI and fix data or delete manually if appropriate.
 * - Deleted ItemInventory docs (with --apply only): how many safe rows MongoDB actually removed.
 *   Should match "Safe inventory docs to delete" unless something changed between dry-run and apply.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

function parseArgs() {
  const args = process.argv.slice(2);
  let apply = false;
  let verbose = false;

  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--verbose' || arg === '-v') verbose = true;
  }

  return { apply, verbose };
}

function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function inventoryHasNonZero(inv) {
  const totalOpeningStock = toNumber(inv?.totalOpeningStock);
  const totalAvailableStock = toNumber(inv?.totalAvailableStock);
  const totalInventoryValue = toNumber(inv?.totalInventoryValue);

  if (totalOpeningStock !== 0 || totalAvailableStock !== 0 || totalInventoryValue !== 0) {
    return true;
  }

  const warehouses = Array.isArray(inv?.warehouses) ? inv.warehouses : [];
  return warehouses.some(wh => {
    return toNumber(wh?.openingStock) !== 0 || toNumber(wh?.availableStock) !== 0 || toNumber(wh?.inventoryValue) !== 0;
  });
}

/**
 * Aggregate batch doc counts and quantities per itemId.
 * Supports flat docs (root remainingQty/quantity) and nested branchDetails in the same collection.
 */
async function buildBatchMapForItems(batchColl, itemIds) {
  if (!batchColl || !itemIds.length) return new Map();

  const docs = await batchColl
    .find({ itemId: { $in: itemIds } })
    .project({ itemId: 1, branchDetails: 1, remainingQty: 1, quantity: 1 })
    .toArray();

  const out = new Map();

  for (const doc of docs) {
    if (!doc.itemId) continue;
    const key = String(doc.itemId);
    const prev = out.get(key) || { batchDocCount: 0, totalRemainingQty: 0, totalQuantity: 0 };
    prev.batchDocCount += 1;

    const branches = Array.isArray(doc.branchDetails) ? doc.branchDetails : [];
    if (branches.length > 0) {
      for (const branch of branches) {
        for (const batch of branch.availableBatches || []) {
          prev.totalRemainingQty += toNumber(batch.remainingQty);
          prev.totalQuantity += toNumber(batch.quantity);
        }
        for (const batch of branch.completedBatches || []) {
          prev.totalRemainingQty += toNumber(batch.remainingQty);
          prev.totalQuantity += toNumber(batch.quantity);
        }
      }
    } else {
      prev.totalRemainingQty += toNumber(doc.remainingQty);
      prev.totalQuantity += toNumber(doc.quantity);
    }

    out.set(key, prev);
  }

  return out;
}

const DELETE_CHUNK_SIZE = 5000;

async function run() {
  const { apply, verbose } = parseArgs();

  let db;
  try {
    db = await getConnection();
    const booksCrmDb = db.booksCrm;
    const booksDb = db.books;

    const itemsColl = booksCrmDb.collection('items');
    const inventoryColl = booksCrmDb.collection('iteminventories');
    const batchCollCrm = booksCrmDb.collection('itembatches');
    const batchCollBooks = booksDb.collection('itembatches');

    const serviceItems = await itemsColl
      .find({ 'itemCategory.isService': true })
      .project({ _id: 1, itemName: 1, itemNo: 1, companyId: 1 })
      .toArray();

    if (serviceItems.length === 0) {
      console.log('No service items found. Nothing to migrate.');
      return;
    }

    const serviceItemIds = serviceItems.map(it => it._id);
    const serviceItemMap = new Map(serviceItems.map(it => [String(it._id), it]));

    const inventories = await inventoryColl
      .find({ itemId: { $in: serviceItemIds } })
      .project({
        _id: 1,
        itemId: 1,
        companyId: 1,
        totalOpeningStock: 1,
        totalAvailableStock: 1,
        totalInventoryValue: 1,
        warehouses: 1,
      })
      .toArray();

    const [crmBatchMap, booksBatchMap] = await Promise.all([
      buildBatchMapForItems(batchCollCrm, serviceItemIds),
      buildBatchMapForItems(batchCollBooks, serviceItemIds),
    ]);

    const safeToDeleteInventoryIds = [];
    const risky = [];

    for (const inv of inventories) {
      const itemKey = String(inv.itemId);
      const item = serviceItemMap.get(itemKey);
      const hasNonZeroInventory = inventoryHasNonZero(inv);
      const crmBatch = crmBatchMap.get(itemKey) || { batchDocCount: 0, totalRemainingQty: 0, totalQuantity: 0 };
      const booksBatch = booksBatchMap.get(itemKey) || { batchDocCount: 0, totalRemainingQty: 0, totalQuantity: 0 };

      const totalBatchDocs = crmBatch.batchDocCount + booksBatch.batchDocCount;
      const totalRemainingQty = crmBatch.totalRemainingQty + booksBatch.totalRemainingQty;
      const totalQuantity = crmBatch.totalQuantity + booksBatch.totalQuantity;

      const safe = !hasNonZeroInventory && totalBatchDocs === 0 && totalRemainingQty === 0 && totalQuantity === 0;

      if (safe) {
        safeToDeleteInventoryIds.push(inv._id);
      } else {
        risky.push({
          inventoryId: String(inv._id),
          itemId: itemKey,
          itemNo: item?.itemNo || null,
          itemName: item?.itemName || null,
          companyId: inv.companyId != null ? String(inv.companyId) : null,
          totalOpeningStock: toNumber(inv.totalOpeningStock),
          totalAvailableStock: toNumber(inv.totalAvailableStock),
          totalInventoryValue: toNumber(inv.totalInventoryValue),
          warehousesCount: Array.isArray(inv.warehouses) ? inv.warehouses.length : 0,
          hasNonZeroInventory,
          totalBatchDocs,
          totalRemainingQty,
          totalQuantity,
        });
      }
    }

    console.log('--- Service Item Inventory Cleanup ---');
    console.log('Scope: all companies');
    // See file header "Reading the console summary" for what each count means.
    console.log(`Service items found: ${serviceItems.length}`);
    console.log(`Service item inventories found: ${inventories.length}`);
    console.log(`Safe inventory docs to delete: ${safeToDeleteInventoryIds.length}`);
    console.log(`Risky inventory docs (manual review): ${risky.length}`);

    if (verbose && risky.length > 0) {
      console.log('\nRisky records (first 100):');
      risky.slice(0, 100).forEach((r, i) => {
        console.log(
          `${i + 1}. itemNo=${r.itemNo || '-'} itemName=${r.itemName || '-'} itemId=${r.itemId} invId=${r.inventoryId} ` +
            `companyId=${r.companyId || '-'} stock=${r.totalAvailableStock} opening=${r.totalOpeningStock} value=${r.totalInventoryValue} ` +
            `batches=${r.totalBatchDocs} remQty=${r.totalRemainingQty}`,
        );
      });
    }

    if (!apply) {
      console.log('\nDry-run only. Re-run with --apply to delete safe records.');
      return;
    }

    if (safeToDeleteInventoryIds.length === 0) {
      console.log('\n--apply set, but no safe records found to delete.');
      return;
    }

    let deleted = 0;
    for (let i = 0; i < safeToDeleteInventoryIds.length; i += DELETE_CHUNK_SIZE) {
      const chunk = safeToDeleteInventoryIds.slice(i, i + DELETE_CHUNK_SIZE);
      const deleteResult = await inventoryColl.deleteMany({ _id: { $in: chunk } });
      deleted += deleteResult.deletedCount;
    }
    // Count of safe ItemInventory documents removed (--apply only); see header "Reading the console summary".
    console.log(`\nDeleted ItemInventory docs: ${deleted}`);
    console.log('Done.');
  } finally {
    if (db?.client) {
      await db.client.close();
    }
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
