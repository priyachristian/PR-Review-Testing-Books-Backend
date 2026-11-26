/**
 * Audit: Find duplicate warehouseId entries inside iteminventories.warehouses[]
 *
 * Some iteminventories documents have the same warehouseId appearing more than once
 * in their `warehouses` array, as separate array elements (often with different
 * branchId/divisionId/stock values on each occurrence). Because most lookup code reads
 * a warehouse's stock via `warehouses.find(w => w.warehouseId === id)` (which only ever
 * returns the FIRST matching element), any stock sitting in a later duplicate entry
 * becomes invisible to normal stock displays/aggregations — this is why stock for that
 * warehouse stops matching what's actually in the array.
 *
 * This script is READ-ONLY — it does not modify any data. It reports what it finds so
 * the right fix (merge duplicates, reassign branch/division, etc.) can be decided on a
 * case-by-case basis.
 *
 * Usage:
 *   node migrations/findDuplicateWarehouseEntries.js              # print report to console
 *   node migrations/findDuplicateWarehouseEntries.js --export      # also write a JSON file
 */

const fs = require('fs');
const path = require('path');
const { getConnection } = require('../config/db');

function isMissing(v) {
  return v === null || v === undefined;
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

// Are the stock/branch fields identical across every occurrence in this group,
// or do they actually disagree (the more dangerous case)?
function groupHasConflict(occurrences) {
  const keys = ['branchId', 'divisionId', 'isActive', 'openingStock', 'availableStock', 'inventoryValue'];
  return keys.some(key => {
    const values = new Set(occurrences.map(o => (isMissing(o[key]) ? '—' : o[key].toString())));
    return values.size > 1;
  });
}

async function run(shouldExport) {
  const { client, booksCrm } = await getConnection();

  try {
    const itemInventories = booksCrm.collection('iteminventories');

    // Push duplicate-detection into the DB: a doc is affected if the number of
    // non-null warehouseIds in its `warehouses` array doesn't match the number of
    // DISTINCT non-null warehouseIds — i.e. at least one warehouseId repeats.
    const affectedCursor = itemInventories.aggregate([
      {
        $project: {
          itemId: 1,
          companyId: 1,
          warehouses: 1,
          warehouseIds: {
            $filter: {
              // $ifNull guards docs where `warehouses` is missing or null (not just []),
              // otherwise $size below would throw and abort the whole aggregation.
              input: { $map: { input: { $ifNull: ['$warehouses', []] }, as: 'w', in: '$$w.warehouseId' } },
              as: 'id',
              cond: { $ne: ['$$id', null] },
            },
          },
        },
      },
      {
        $addFields: {
          uniqueWarehouseIds: { $setUnion: ['$warehouseIds', []] },
        },
      },
      {
        $match: {
          $expr: { $gt: [{ $size: '$warehouseIds' }, { $size: '$uniqueWarehouseIds' }] },
        },
      },
    ]);

    const stats = {
      affectedDocs: 0,
      duplicateGroups: 0,
      conflictingGroups: 0,
      duplicateEntries: 0,
      stockInDuplicateEntries: 0,
    };

    const detailRows = [];
    const exportRecords = [];

    while (await affectedCursor.hasNext()) {
      const inv = await affectedCursor.next();
      stats.affectedDocs++;

      // Group this doc's warehouse entries by warehouseId.
      const byWarehouseId = new Map();
      (inv.warehouses ?? []).forEach((wh, index) => {
        if (!wh.warehouseId) return;
        const key = wh.warehouseId.toString();
        if (!byWarehouseId.has(key)) byWarehouseId.set(key, []);
        byWarehouseId.get(key).push({ ...wh, _index: index });
      });

      for (const [warehouseId, occurrences] of byWarehouseId.entries()) {
        if (occurrences.length < 2) continue;

        stats.duplicateGroups++;
        stats.duplicateEntries += occurrences.length;

        const hasConflict = groupHasConflict(occurrences);
        if (hasConflict) stats.conflictingGroups++;

        const combinedAvailableStock = occurrences.reduce((sum, o) => sum + (o.availableStock || 0), 0);
        stats.stockInDuplicateEntries += combinedAvailableStock;

        const groupRecord = {
          inventoryId: inv._id?.toString(),
          itemId: inv.itemId?.toString() ?? '—',
          companyId: inv.companyId?.toString() ?? '—',
          warehouseId,
          occurrenceCount: occurrences.length,
          conflicting: hasConflict,
          combinedAvailableStock,
          occurrences: occurrences.map(o => ({
            arrayIndex: o._index,
            branchId: o.branchId?.toString() ?? '—',
            divisionId: o.divisionId?.toString() ?? '—',
            isActive: o.isActive ?? '—',
            openingStock: o.openingStock ?? 0,
            availableStock: o.availableStock ?? 0,
            inventoryValue: o.inventoryValue ?? 0,
          })),
        };

        exportRecords.push(groupRecord);

        occurrences.forEach((o, i) => {
          detailRows.push({
            'Inventory ID': inv._id?.toString(),
            'Item ID': inv.itemId?.toString() ?? '—',
            'Warehouse ID': warehouseId,
            '#': `${i + 1}/${occurrences.length}`,
            'Array Idx': o._index,
            'Branch ID': o.branchId?.toString() ?? '—',
            'Division ID': o.divisionId?.toString() ?? '—',
            Active: o.isActive ?? '—',
            'Available Stock': o.availableStock ?? 0,
            Conflict: hasConflict ? '⚠️ yes' : 'no (identical)',
          });
        });
      }
    }

    // ── Output ────────────────────────────────────────────────────────────
    printSection('findDuplicateWarehouseEntries', '═');

    if (!detailRows.length) {
      console.log('\n  ✅ No duplicate warehouseId entries found in iteminventories.warehouses[].\n');
      return;
    }

    console.log(`\n🔁  Duplicate warehouse entries found (${detailRows.length} rows across ${stats.duplicateGroups} groups):`);
    console.table(detailRows);

    printSection('Summary', '─');
    console.table([
      { Metric: 'Affected documents', Value: stats.affectedDocs },
      { Metric: 'Duplicate warehouseId groups', Value: stats.duplicateGroups },
      { Metric: 'Total duplicate array entries', Value: stats.duplicateEntries },
      { Metric: 'Groups with conflicting field values (different stock/branch/division)', Value: stats.conflictingGroups },
      { Metric: 'Groups that are exact duplicates (identical values)', Value: stats.duplicateGroups - stats.conflictingGroups },
      { Metric: 'Combined availableStock sitting in duplicate entries', Value: stats.stockInDuplicateEntries },
    ]);

    console.log(
      '\n  ⚠  This is a READ-ONLY report — nothing was modified.' +
        '\n     "Conflicting" groups have different branch/division/stock values per occurrence and need a manual decision' +
        ' on how to reconcile them before any merge.' +
        '\n     "Exact duplicate" groups are safe candidates for a follow-up script that collapses them into one entry.\n',
    );

    if (shouldExport) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = path.join(__dirname, `duplicate-warehouse-entries-${timestamp}.json`);
      fs.writeFileSync(outputFile, JSON.stringify({ summary: stats, groups: exportRecords }, null, 2));
      console.log(`  📄 Full detail exported to: ${outputFile}\n`);
    }
  } catch (err) {
    console.error('❌ Audit failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

// ─── entry point ────────────────────────────────────────────────────────────

const shouldExport = process.argv.includes('--export');
run(shouldExport).catch(() => process.exit(1));
