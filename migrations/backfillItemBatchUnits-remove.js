/**
 * Backfills the unit / conversion fields on OLD item batches, which only carry the root level
 * `itemUnit` string. Old batches have no other unit, so everything is in the item's main unit and
 * every conversion factor is 1 (same as resolveUnitConversion() returns for the main unit).
 *
 * The main unit is resolved in this order (batches always hold the item's main unit):
 *   1. `items.itemUnitId`
 *   2. the company's ItemUnit named like the batch's `itemUnit` string
 *   3. the company's ItemUnit named like the item's `itemUnit` string
 * A batch whose unit cannot be resolved by any of them is skipped completely and reported.
 *
 * Only unset values are filled — anything already present (e.g. a batch written by the new code) is
 * left untouched:
 *   itemUnitId            <- main unit                       when null / missing
 *   purchaseUnitId        <- main unit                       when null / missing
 *   conversionFactor      <- 1                               when missing
 *   purchaseQuantity      <- quantity / conversionFactor     when missing, or 0 while quantity > 0
 *   deductions[].sellingUnitId     <- batch main unit        when null / missing
 *   deductions[].conversionFactor  <- 1                      when missing
 *   deductions[].sellingQuantity   <- quantityDeducted / conversionFactor   when missing
 *   documentUnitRate      <- item purchaseInformation.costPrice   when missing (0 if the item has none)
 *   deductions[].documentUnitRate  <- item salesInformation.sellingPrice   when missing (0 if the item has none)
 * quantity, remainingQty and quantityDeducted are never changed.
 *
 * Re-running is safe: only batches that still have an unset field are picked up.
 *
 * Run: node migrations/backfillItemBatchUnits-remove.js                      (report, all companies)
 *      node migrations/backfillItemBatchUnits-remove.js <companyId>           (report, one company)
 *      node migrations/backfillItemBatchUnits-remove.js --apply               (write, all companies)
 *      node migrations/backfillItemBatchUnits-remove.js <companyId> --apply   (write, one company)
 *      add --all to list every skipped batch instead of the first 20
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const CHUNK_SIZE = 500;

const round = value => Math.round((Number(value) || 0) * 1e6) / 1e6;
const isUnset = value => value === null || value === undefined;

const buildCandidateFilter = companyId => ({
  ...(companyId ? { companyId } : {}),
  $or: [
    { itemUnitId: null },
    { purchaseUnitId: null },
    { conversionFactor: { $exists: false } },
    { purchaseQuantity: { $exists: false } },
    { purchaseQuantity: 0, quantity: { $gt: 0 } },
    { documentUnitRate: { $exists: false } },
    {
      deductions: {
        $elemMatch: {
          $or: [
            { sellingUnitId: null },
            { conversionFactor: { $exists: false } },
            { sellingQuantity: { $exists: false } },
            { documentUnitRate: { $exists: false } },
          ],
        },
      },
    },
  ],
});

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const printAll = args.includes('--all');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    const itemBatches = db.booksCrm.collection('itembatches');
    const items = db.booksCrm.collection('items');
    const itemUnits = db.booksCrm.collection('itemunits');

    const itemUnitByItemId = new Map(); // itemId string -> { itemUnitId, itemUnit } | null
    const unitsByCompany = new Map(); // companyId string -> Map(NAME -> _id)

    const loadItemUnits = async chunk => {
      const missingIds = [
        ...new Set(
          chunk.filter(batch => batch.itemId && !itemUnitByItemId.has(batch.itemId.toString())).map(b => b.itemId.toString()),
        ),
      ].map(id => new ObjectId(id));
      if (!missingIds.length) return;
      const found = await items
        .find({ _id: { $in: missingIds } })
        .project({ itemUnitId: 1, itemUnit: 1, 'purchaseInformation.costPrice': 1, 'salesInformation.sellingPrice': 1 })
        .toArray();
      missingIds.forEach(id => itemUnitByItemId.set(id.toString(), null));
      found.forEach(item =>
        itemUnitByItemId.set(item._id.toString(), {
          itemUnitId: item.itemUnitId || null,
          itemUnit: item.itemUnit || null,
          costPrice: item.purchaseInformation?.costPrice || 0,
          sellingPrice: item.salesInformation?.sellingPrice || 0,
        }),
      );
    };

    const getCompanyUnits = async companyId => {
      const key = companyId.toString();
      if (!unitsByCompany.has(key)) {
        const units = await itemUnits.find({ companyId }).project({ name: 1 }).toArray();
        unitsByCompany.set(key, new Map(units.map(unit => [unit.name.trim().toUpperCase(), unit._id])));
      }
      return unitsByCompany.get(key);
    };

    // 1. item.itemUnitId  2. ItemUnit named like batch.itemUnit  3. ItemUnit named like item.itemUnit
    const resolveMainUnit = async batch => {
      const item = batch.itemId ? itemUnitByItemId.get(batch.itemId.toString()) : null;
      if (item?.itemUnitId) return item.itemUnitId;
      if (!batch.companyId) return null;
      const companyUnits = await getCompanyUnits(batch.companyId);
      const lookup = name => (name ? companyUnits.get(String(name).trim().toUpperCase()) : null) || null;
      return lookup(batch.itemUnit) || lookup(item?.itemUnit);
    };

    // Builds the $set for one batch; returns null when nothing needs to change.
    const buildSet = (batch, mainUnitId) => {
      const set = {};

      if (isUnset(batch.itemUnitId)) set.itemUnitId = mainUnitId;
      if (isUnset(batch.purchaseUnitId)) set.purchaseUnitId = mainUnitId;

      const conversionFactor = isUnset(batch.conversionFactor) ? 1 : batch.conversionFactor || 1;
      if (isUnset(batch.conversionFactor)) set.conversionFactor = 1;

      const purchaseQtyUnset = isUnset(batch.purchaseQuantity) || (batch.purchaseQuantity === 0 && batch.quantity > 0);
      if (purchaseQtyUnset) set.purchaseQuantity = round(batch.quantity / conversionFactor);

      const item = batch.itemId ? itemUnitByItemId.get(batch.itemId.toString()) : null;
      if (isUnset(batch.documentUnitRate)) set.documentUnitRate = item?.costPrice || 0;

      (batch.deductions || []).forEach((deduction, index) => {
        const prefix = `deductions.${index}`;
        if (isUnset(deduction.sellingUnitId)) set[`${prefix}.sellingUnitId`] = batch.itemUnitId || mainUnitId;
        const deductionFactor = isUnset(deduction.conversionFactor) ? 1 : deduction.conversionFactor || 1;
        if (isUnset(deduction.conversionFactor)) set[`${prefix}.conversionFactor`] = 1;
        if (isUnset(deduction.sellingQuantity)) {
          set[`${prefix}.sellingQuantity`] = round((deduction.quantityDeducted || 0) / deductionFactor);
        }
        if (isUnset(deduction.documentUnitRate)) set[`${prefix}.documentUnitRate`] = item?.sellingPrice || 0;
      });

      return Object.keys(set).length ? set : null;
    };

    const stats = { scanned: 0, toUpdate: 0, updated: 0, unresolved: 0, deductionsFilled: 0 };
    const unresolvedSamples = [];
    const unresolvedByItem = new Map(); // "companyId | itemId" -> skipped batch count
    const unresolvedBySource = new Map(); // sourceType -> skipped batch count
    const exampleShown = { done: false };

    const flush = async operations => {
      if (!operations.length) return;
      const result = await itemBatches.bulkWrite(operations, { ordered: false });
      stats.updated += result.modifiedCount;
    };

    const cursor = itemBatches.find(buildCandidateFilter(targetCompanyId)).project({
      itemId: 1,
      companyId: 1,
      batchNo: 1,
      itemUnit: 1,
      itemUnitId: 1,
      purchaseUnitId: 1,
      purchaseQuantity: 1,
      conversionFactor: 1,
      documentUnitRate: 1,
      quantity: 1,
      sourceType: 1,
      seedTag: 1,
      deductions: 1,
    });

    let chunk = [];
    const processChunk = async () => {
      if (!chunk.length) return;
      await loadItemUnits(chunk);
      const operations = [];

      for (const batch of chunk) {
        stats.scanned += 1;
        // eslint-disable-next-line no-await-in-loop
        const mainUnitId = await resolveMainUnit(batch);
        if (!mainUnitId) {
          stats.unresolved += 1;
          if (printAll || unresolvedSamples.length < 20) {
            unresolvedSamples.push(
              `${batch._id} (company ${batch.companyId}, item ${batch.itemId}, sourceType ${batch.sourceType}, seedTag ${batch.seedTag || '-'}, unit "${batch.itemUnit}")`,
            );
          }
          unresolvedBySource.set(batch.sourceType, (unresolvedBySource.get(batch.sourceType) || 0) + 1);
          const itemKey = `${batch.companyId} | ${batch.itemId}`;
          unresolvedByItem.set(itemKey, (unresolvedByItem.get(itemKey) || 0) + 1);
          continue;
        }

        const set = buildSet(batch, mainUnitId);
        if (!set) continue;

        stats.toUpdate += 1;
        stats.deductionsFilled += Object.keys(set).filter(key => key.endsWith('.sellingUnitId')).length;
        if (!exampleShown.done) {
          exampleShown.done = true;
          console.log('Example update (batch', String(batch._id), '):');
          console.log(JSON.stringify(set, null, 2), '\n');
        }
        if (apply) operations.push({ updateOne: { filter: { _id: batch._id }, update: { $set: set } } });
      }

      // eslint-disable-next-line no-await-in-loop
      await flush(operations);
      chunk = [];
    };

    for await (const batch of cursor) {
      chunk.push(batch);
      if (chunk.length >= CHUNK_SIZE) await processChunk();
    }
    await processChunk();

    console.log('ITEM BATCHES');
    console.log(`   candidates scanned          : ${stats.scanned}`);
    console.log(`   batches to update           : ${stats.toUpdate}`);
    console.log(`   deductions getting a unit   : ${stats.deductionsFilled}`);
    console.log(`   skipped, unit unresolved    : ${stats.unresolved}`);
    if (unresolvedSamples.length) {
      console.log('\nSKIPPED BATCHES PER SOURCE TYPE');
      [...unresolvedBySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .forEach(([type, count]) => console.log(`   ${type} -> ${count}`));

      console.log(
        `\nSKIPPED BATCHES PER ITEM (companyId | itemId -> batches): ${unresolvedByItem.size} items, ${stats.unresolved} batches in total`,
      );
      [...unresolvedByItem.entries()].sort((a, b) => b[1] - a[1]).forEach(([key, count]) => console.log(`   ${key} -> ${count}`));

      console.log(
        `\nUNRESOLVED BATCHES (${printAll ? 'all' : `first ${unresolvedSamples.length} of ${stats.unresolved}, pass --all for every one`}) — unit could not be resolved from the item itemUnitId, batch itemUnit or item itemUnit`,
      );
      unresolvedSamples.forEach(sample => console.log(`   ${sample}`));
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    console.log('\nWRITTEN');
    console.log(`   batches modified : ${stats.updated}`);
    console.log('\nItem batch unit backfill complete.\n');
  } catch (error) {
    console.error('Item batch unit backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
