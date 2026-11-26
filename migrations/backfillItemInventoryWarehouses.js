/**
 * Migration: Backfill `warehouses` array in `itemInventory`.
 *
 * Backfills every active warehouse of the company (with default/zero values) into
 * ItemInventory documents where ALL of the following hold:
 *   1. warehouses array has 0 length (or is missing)
 *   2. the linked item has trackInventory === true
 *   3. the linked item is a goods item (itemCategory.isGoods === true)
 *
 * Runs as a DRY RUN by default — pass --apply to actually write.
 *
 * NOTE: `iteminventories` has no index leading with `companyId` (only {itemId} and
 * {itemId, companyId}), so the candidate scan is a collection scan. It is therefore done
 * ONCE for all tenants rather than once per tenant, with warehouses pre-grouped in memory.
 *
 * Usage:
 *   node migrations/backfillItemInventoryWarehouses.js up                    # dry run
 *   node migrations/backfillItemInventoryWarehouses.js up --apply
 *   node migrations/backfillItemInventoryWarehouses.js up --companyId=<id>
 *   node migrations/backfillItemInventoryWarehouses.js down                  # dry run
 *   node migrations/backfillItemInventoryWarehouses.js down --apply
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

const INVENTORY_COLLECTION = 'iteminventories';
const ITEM_COLLECTION = 'items';
const WAREHOUSE_COLLECTION = 'warehouses';
const COMPANY_COLLECTION = 'companies';

const BATCH_SIZE = 500;

function parseArgs(argv) {
  const hit = argv.find(a => a.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { companyId: companyArg ? new ObjectId(companyArg) : null };
}

/** Default warehouse sub-document for an inventory row. */
const buildWarehouseEntry = warehouse => ({
  // Mongoose generates _id for these subdocs; the native driver does not, so do it explicitly
  // to keep backfilled rows shaped identically to app-created ones.
  _id: new ObjectId(),
  divisionId: warehouse.divisionId ?? null,
  branchId: warehouse.branchId ?? null,
  warehouseId: warehouse._id,
  isActive: true,
  openingStock: 0,
  availableStock: 0,
  inventoryValue: 0,
});

/** Condition 1. Conditions 2 (trackInventory) and 3 (goods item) need the $lookup below. */
const buildCandidateMatch = companyId => ({
  ...(companyId ? { companyId } : excludedObjectIds.length ? { companyId: { $nin: excludedObjectIds } } : {}),
  $or: [{ warehouses: { $size: 0 } }, { warehouses: { $exists: false } }, { warehouses: null }],
});

async function up(apply = false) {
  const { companyId: onlyCompanyId } = parseArgs(process.argv);

  if (onlyCompanyId && isCompanyExcluded(onlyCompanyId)) {
    console.log(`Company ${onlyCompanyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
    return;
  }

  const { client, booksCrm, common } = await getConnection();

  const stats = { candidates: 0, updated: 0, skippedNoWarehouse: 0 };
  /** companyId -> { candidates, updated, skipped, details[] } */
  const byCompany = new Map();

  try {
    const inventoryCol = booksCrm.collection(INVENTORY_COLLECTION);
    const warehouseCol = booksCrm.collection(WAREHOUSE_COLLECTION);

    console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);
    if (!onlyCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}`);
    }

    // Warehouses are a small collection — load once and group, so the inventory scan
    // below can run as a single pass over every tenant.
    const warehouseFilter = {
      isActive: { $ne: false },
      ...(onlyCompanyId
        ? { companyId: onlyCompanyId }
        : excludedObjectIds.length
          ? { companyId: { $nin: excludedObjectIds } }
          : {}),
    };
    const warehousesByCompany = new Map();
    for (const wh of await warehouseCol.find(warehouseFilter).toArray()) {
      const key = String(wh.companyId);
      if (!warehousesByCompany.has(key)) warehousesByCompany.set(key, []);
      warehousesByCompany.get(key).push(buildWarehouseEntry(wh));
    }
    console.log(`Companies with active warehouses: ${warehousesByCompany.size}`);

    const bucket = key => {
      if (!byCompany.has(key)) byCompany.set(key, { candidates: 0, updated: 0, skipped: 0, details: [] });
      return byCompany.get(key);
    };

    // Single pass. Conditions 2 and 3 resolved via $lookup — no per-item query.
    const cursor = inventoryCol.aggregate(
      [
        { $match: buildCandidateMatch(onlyCompanyId) },
        {
          $lookup: {
            from: ITEM_COLLECTION,
            let: { itemId: '$itemId', companyId: '$companyId' },
            pipeline: [
              {
                $match: {
                  $expr: { $and: [{ $eq: ['$_id', '$$itemId'] }, { $eq: ['$companyId', '$$companyId'] }] },
                  'itemCategory.isGoods': true,
                  trackInventory: true,
                },
              },
              { $project: { _id: 1, itemNo: 1, itemName: 1, itemType: 1 } },
            ],
            as: 'item',
          },
        },
        { $match: { 'item.0': { $exists: true } } },
        // $arrayElemAt rather than $first — $first as an array operator needs MongoDB 4.4+.
        { $project: { _id: 1, itemId: 1, companyId: 1, item: { $arrayElemAt: ['$item', 0] } } },
      ],
      { allowDiskUse: true },
    );

    let buffer = [];

    const flush = async () => {
      if (!buffer.length) return;

      // Group the batch by company so each doc gets its own tenant's warehouse list.
      const grouped = new Map();
      for (const doc of buffer) {
        const key = String(doc.companyId);
        const entries = warehousesByCompany.get(key);

        if (!entries?.length) {
          stats.skippedNoWarehouse += 1;
          bucket(key).skipped += 1;
          continue;
        }

        stats.candidates += 1;
        const b = bucket(key);
        b.candidates += 1;

        b.details.push({
          itemInventoryId: String(doc._id),
          itemId: String(doc.itemId),
          itemNo: doc.item?.itemNo ?? '',
          itemName: doc.item?.itemName ?? '',
          itemType: doc.item?.itemType ?? '',
          warehousesToAdd: entries.length,
        });

        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(doc);
      }

      if (apply) {
        for (const [key, docs] of grouped) {
          const entries = warehousesByCompany.get(key);
          const companyObjectId = docs[0].companyId;

          const res = await inventoryCol.bulkWrite(
            docs.map(doc => ({
              updateOne: {
                // Re-assert the full guard so a concurrent write between read and update is not clobbered.
                filter: { _id: doc._id, ...buildCandidateMatch(companyObjectId) },
                // Fresh _ids per document — subdoc _ids must not be shared across docs.
                update: {
                  $set: { warehouses: entries.map(e => ({ ...e, _id: new ObjectId() })), updatedAt: new Date() },
                },
              },
            })),
            { ordered: false },
          );

          stats.updated += res.modifiedCount;
          bucket(key).updated += res.modifiedCount;
        }
      }

      buffer = [];
    };

    for await (const doc of cursor) {
      buffer.push(doc);
      if (buffer.length >= BATCH_SIZE) await flush();
    }
    await flush();

    // Resolve company names in one query purely for readable output.
    const companyIds = [...byCompany.keys()].map(k => new ObjectId(k));
    const names = new Map(
      (
        await common
          .collection(COMPANY_COLLECTION)
          .find({ _id: { $in: companyIds } }, { projection: { name: 1 } })
          .toArray()
      ).map(c => [String(c._id), c.name || '']),
    );

    const report = [...byCompany.entries()]
      .map(([key, v]) => ({
        companyId: key,
        company: names.get(key) || '(unknown)',
        warehouses: warehousesByCompany.get(key)?.length ?? 0,
        candidates: v.candidates,
        updated: v.updated,
        status:
          v.candidates === 0
            ? `SKIPPED — no active warehouses (${v.skipped} doc(s))`
            : apply
              ? 'BACKFILLED'
              : 'PENDING (dry run)',
        details: v.details,
      }))
      .sort((a, b) => b.candidates - a.candidates);

    console.log('\nPer-company breakdown:');
    if (report.length) {
      console.table(report.map(({ details, ...row }) => row));
    } else {
      console.log('  (no companies matched)');
    }

    const affected = report.filter(r => r.candidates > 0);
    if (affected.length) {
      console.log('\nAffected inventory documents (grouped by company):');
      for (const row of affected) {
        console.log(
          `\n▸ ${row.company} [${row.companyId}] — ${row.candidates} inventory doc(s), ${row.warehouses} warehouse(s) each`,
        );
        console.table(row.details);
      }
    }

    console.log('\nSummary:');
    console.table([
      { metric: 'Companies affected', value: affected.length },
      { metric: 'Docs skipped (company has no active warehouse)', value: stats.skippedNoWarehouse },
      { metric: 'Inventory docs matching all 3 conditions', value: stats.candidates },
      {
        metric: apply ? 'Inventory docs updated' : 'Inventory docs that would be updated',
        value: apply ? stats.updated : stats.candidates,
      },
    ]);

    console.log(apply ? '\n✅ Migration up completed' : '\nDry run — no changes written. Re-run with --apply to persist.');
  } catch (err) {
    console.error('❌ Migration up failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

/**
 * Revert: empty the `warehouses` array again.
 *
 * Only touches rows that are still entirely untouched — every entry zero stock, zero value,
 * isActive true — so any inventory that has since received real stock is left alone.
 */
async function down(apply = false) {
  const { companyId: onlyCompanyId } = parseArgs(process.argv);

  if (onlyCompanyId && isCompanyExcluded(onlyCompanyId)) {
    console.log(`Company ${onlyCompanyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
    return;
  }

  const { client, booksCrm } = await getConnection();

  try {
    const inventoryCol = booksCrm.collection(INVENTORY_COLLECTION);

    const filter = {
      ...(onlyCompanyId
        ? { companyId: onlyCompanyId }
        : excludedObjectIds.length
          ? { companyId: { $nin: excludedObjectIds } }
          : {}),
      warehouses: {
        $exists: true,
        $ne: [],
        // no entry may carry stock/value or be deactivated
        $not: {
          $elemMatch: {
            $or: [
              { openingStock: { $nin: [0, null] } },
              { availableStock: { $nin: [0, null] } },
              { inventoryValue: { $nin: [0, null] } },
              { isActive: { $ne: true } },
            ],
          },
        },
      },
    };

    console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);
    if (!onlyCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}`);
    }

    const matched = await inventoryCol.countDocuments(filter);
    let reverted = 0;

    if (apply && matched) {
      const res = await inventoryCol.updateMany(filter, { $set: { warehouses: [], updatedAt: new Date() } });
      reverted = res.modifiedCount;
    }

    console.log('\nSummary:');
    console.table([
      { metric: 'Inventory docs with only zero-stock warehouses', value: matched },
      { metric: apply ? 'Inventory docs reverted' : 'Inventory docs that would be reverted', value: apply ? reverted : matched },
    ]);

    console.log(apply ? '\n✅ Migration down completed' : '\nDry run — no changes written. Re-run with --apply to revert.');
  } catch (err) {
    console.error('❌ Migration down failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { up, down };

if (require.main === module) {
  const direction = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!['up', 'down'].includes(direction)) {
    console.error('Usage: node <file> [up|down] [--apply] [--companyId=<id>]');
    process.exit(1);
  }

  module.exports[direction](apply)
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
