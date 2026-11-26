/**
 * Backfills `itemUnitId` from the legacy `itemUnit` string (NOS, PCS, KGS, ...).
 *
 * For every line (or top-level doc for items / itembatches) that has an `itemUnit` string but no
 * `itemUnitId`, the company's ItemUnit (booksCrm.itemunits, matched by name, case-insensitive) is
 * looked up and its _id written to `itemUnitId`. Lines that already have an `itemUnitId` are never
 * touched, and the `itemUnit` string is left as is.
 *
 * If the unit name has no matching ItemUnit for the company, the main unit of the line's item
 * (items.itemUnitId, looked up by the line's itemId) is used instead. Only when that is missing too
 * (or the doc is an item itself) is the line left untouched and reported, so the unit can be seeded
 * (see seedSystemItemUnits-remove.js) and this migration re-run.
 *
 * Re-running is safe: only lines still missing `itemUnitId` are considered.
 *
 * Collections covered:
 *   booksCrm : items, itembatches (top level), salesorders, quotes (items[])
 *   books    : deliverychallans, invoices, creditnotes, recurringinvoices, bills, debitnotes,
 *              grpoorders, purchaseorders, recurringbills, customerorders (items[])
 * Collections with no legacy `itemUnit` string (inventoryadjustments, inventorytransferrequests,
 * productionorders, and items' productionData.bomBased / productionScrapOutInventory rows) are filled straight from the main unit of the line's item — the TARGETS entries with `lines`.
 * (pricelists only carry `itemUnitId` already, so they are not part of this migration.)
 *
 * Run: node migrations/backfillItemUnitId-remove.js                      (report, all companies)
 *      node migrations/backfillItemUnitId-remove.js <companyId>           (report, one company)
 *      node migrations/backfillItemUnitId-remove.js --apply               (write, all companies)
 *      node migrations/backfillItemUnitId-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

// `path: null` means the unit fields live on the document itself.
const TARGETS = [
  { db: 'booksCrm', collection: 'items', path: null },
  { db: 'booksCrm', collection: 'itembatches', path: null },
  { db: 'booksCrm', collection: 'salesorders', path: 'items' },
  { db: 'booksCrm', collection: 'quotes', path: 'items' },
  { db: 'books', collection: 'deliverychallans', path: 'items' },
  { db: 'books', collection: 'invoices', path: 'items' },
  { db: 'books', collection: 'creditnotes', path: 'items' },
  { db: 'books', collection: 'recurringinvoices', path: 'items' },
  { db: 'books', collection: 'bills', path: 'items' },
  { db: 'books', collection: 'debitnotes', path: 'items' },
  { db: 'books', collection: 'grpoorders', path: 'items' },
  { db: 'books', collection: 'purchaseorders', path: 'items' },
  { db: 'books', collection: 'recurringbills', path: 'items' },
  { db: 'books', collection: 'customerorders', path: 'items' },
  // No legacy `itemUnit` string on these, so itemUnitId comes from the main unit of the line's item.
  // `lines` paths are dotted, "[]" marks an array, `itemKey` is the field on the line holding the item id.
  {
    db: 'booksCrm',
    collection: 'items',
    lines: [
      { path: 'productionData.bomBased[]', itemKey: 'item' },
      { path: 'productionData.productionScrapOutInventory[]', itemKey: 'scrapItemName' },
    ],
  },
  { db: 'books', collection: 'inventoryadjustments', lines: [{ path: 'items[]', itemKey: 'itemId' }] },
  {
    db: 'books',
    collection: 'inventorytransferrequests',
    lines: [
      { path: '', itemKey: 'itemId' },
      { path: 'rawMaterials[]', itemKey: 'rawMaterialId' },
    ],
  },
  {
    db: 'books',
    collection: 'productionorders',
    lines: [
      { path: '', itemKey: 'itemId' },
      { path: 'rawMaterials[]', itemKey: 'rawMaterialId' },
      { path: 'scrapOut[]', itemKey: 'item' },
      { path: 'submissionHistory[].rawMaterialsConsumed[]', itemKey: 'rawMaterialId' },
      { path: 'submissionHistory[].scrapOut[]', itemKey: 'item' },
      { path: 'inventoryImpactLog[]', itemKey: 'item' },
      { path: 'processBased.processes[].processRawMaterialInput[]', itemKey: 'item' },
      { path: 'processBased.processes[].scrapOutProcess[]', itemKey: 'item' },
      { path: 'processBased.processes[].submissionHistory[].processRawMaterialInput[]', itemKey: 'item' },
      { path: 'processBased.processes[].submissionHistory[].scrapOutProcess[]', itemKey: 'item' },
    ],
  },
];

// Finds every line at the path that is missing itemUnitId, with the dotted field to write.
const collectLines = (node, segments, prefix, itemKey, found = []) => {
  if (!node) return found;
  if (!segments.length) {
    if (node.itemUnitId == null && node[itemKey]) found.push({ itemId: node[itemKey], field: `${prefix}itemUnitId` });
    return found;
  }
  const [segment, ...rest] = segments;
  const isArray = segment.endsWith('[]');
  const key = isArray ? segment.slice(0, -2) : segment;
  if (isArray) {
    (node[key] || []).forEach((entry, index) => collectLines(entry, rest, `${prefix}${key}.${index}.`, itemKey, found));
  } else {
    collectLines(node[key], rest, `${prefix}${key}.`, itemKey, found);
  }
  return found;
};

const hasUnitNameNoId = prefix => ({
  [`${prefix}itemUnit`]: { $type: 'string', $ne: '' },
  [`${prefix}itemUnitId`]: null, // matches null and missing
});

// Aggregation-pipeline expression: does this line still need itemUnitId for this unit name?
const lineNeedsUnit = (ref, name) => ({
  $and: [
    { $eq: [{ $ifNull: [`${ref}.itemUnitId`, null] }, null] },
    { $eq: [{ $toUpper: { $trim: { input: { $ifNull: [`${ref}.itemUnit`, ''] } } } }, name] },
  ],
});

const buildUpdatePipeline = (path, unitIdByName) => {
  const names = [...unitIdByName.keys()];

  if (!path) {
    return [
      {
        $set: {
          itemUnitId: {
            $switch: {
              branches: names.map(name => ({ case: lineNeedsUnit('$$ROOT', name), then: unitIdByName.get(name) })),
              default: '$itemUnitId',
            },
          },
        },
      },
    ];
  }

  return [
    {
      $set: {
        [path]: {
          $map: {
            input: `$${path}`,
            as: 'line',
            in: {
              $switch: {
                branches: names.map(name => ({
                  case: lineNeedsUnit('$$line', name),
                  then: { $mergeObjects: ['$$line', { itemUnitId: unitIdByName.get(name) }] },
                })),
                default: '$$line',
              },
            },
          },
        },
      },
    },
  ];
};

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    const itemUnits = db.booksCrm.collection('itemunits');
    const unitCache = new Map(); // companyId string -> Map(NAME -> ObjectId)
    const getCompanyUnits = async companyId => {
      const key = companyId.toString();
      if (!unitCache.has(key)) {
        const units = await itemUnits.find({ companyId }).project({ name: 1 }).toArray();
        unitCache.set(key, new Map(units.map(unit => [unit.name.trim().toUpperCase(), unit._id])));
      }
      return unitCache.get(key);
    };

    const items = db.booksCrm.collection('items');
    const mainUnitByItemId = new Map(); // itemId string -> itemUnitId | null
    const loadMainUnits = async itemIds => {
      const missing = [...new Set(itemIds.filter(id => id && !mainUnitByItemId.has(id.toString())).map(id => id.toString()))];
      if (!missing.length) return;
      const found = await items
        .find({ _id: { $in: missing.map(id => new ObjectId(id)) } })
        .project({ itemUnitId: 1 })
        .toArray();
      missing.forEach(id => mainUnitByItemId.set(id, null));
      found.forEach(item => mainUnitByItemId.set(item._id.toString(), item.itemUnitId || null));
    };

    const totals = { lines: 0, resolvable: 0, viaItem: 0, unresolved: 0, docsModified: 0 };
    const unresolvedSummary = new Map(); // "companyId | NAME" -> line count

    for (const { db: dbKey, collection, path, lines: lineSpecs } of TARGETS) {
      const col = db[dbKey].collection(collection);

      // Collections with no legacy unit name: fill from the line's item main unit.
      if (lineSpecs) {
        let missing = 0;
        let filled = 0;
        let pending = [];

        const flush = async () => {
          if (!pending.length) return;
          await loadMainUnits(pending.map(entry => entry.itemId));
          const operations = [];
          for (const entry of pending) {
            const unitId = mainUnitByItemId.get(entry.itemId.toString());
            if (unitId) {
              filled += 1;
              operations.push({
                updateOne: { filter: { _id: entry.docId, [entry.field]: null }, update: { $set: { [entry.field]: unitId } } },
              });
            } else {
              totals.unresolved += 1;
              const key = `${entry.companyId || '(no companyId)'} | ${collection} (item has no itemUnitId)`;
              unresolvedSummary.set(key, (unresolvedSummary.get(key) || 0) + 1);
            }
          }
          if (apply && operations.length) {
            const result = await col.bulkWrite(operations, { ordered: false });
            totals.docsModified += result.modifiedCount;
          }
          pending = [];
        };

        for await (const doc of col.find(targetCompanyId ? { companyId: targetCompanyId } : {})) {
          for (const { path: linePath, itemKey } of lineSpecs) {
            const found = collectLines(doc, linePath ? linePath.split('.') : [], '', itemKey);
            missing += found.length;
            found.forEach(entry => pending.push({ ...entry, docId: doc._id, companyId: doc.companyId }));
          }
          // eslint-disable-next-line no-await-in-loop
          if (pending.length >= 1000) await flush();
        }
        await flush();

        totals.lines += missing;
        totals.viaItem += filled;
        console.log(`${dbKey}.${collection}: lines missing itemUnitId ${missing} (taken from item main unit ${filled})`);
        continue;
      }

      const prefix = path ? 'line.' : '';
      const companyScope = targetCompanyId ? { companyId: targetCompanyId } : {};

      const pipeline = [
        { $match: { ...companyScope, ...(path ? { [path]: { $elemMatch: hasUnitNameNoId('') } } : hasUnitNameNoId('')) } },
      ];
      if (path) {
        pipeline.push({ $unwind: `$${path}` }, { $set: { line: `$${path}` } });
        pipeline.push({ $match: hasUnitNameNoId(prefix) });
      }
      pipeline.push({
        $group: {
          _id: { companyId: '$companyId', name: { $toUpper: { $trim: { input: `$${prefix}itemUnit` } } } },
          lines: { $sum: 1 },
        },
      });

      // eslint-disable-next-line no-await-in-loop
      const groups = await col.aggregate(pipeline, { allowDiskUse: true }).toArray();
      if (!groups.length) {
        console.log(`${dbKey}.${collection}: nothing to backfill`);
        continue;
      }

      const unitsByCompany = new Map(); // companyId string -> { companyId, unitIdByName }
      const noMatchPairs = new Map(); // "companyId|NAME" -> { companyId, name, lines }
      let lines = 0;
      let resolvable = 0;

      for (const { _id, lines: count } of groups) {
        lines += count;
        // eslint-disable-next-line no-await-in-loop
        const companyUnits = _id.companyId ? await getCompanyUnits(_id.companyId) : new Map();
        const unitId = companyUnits.get(_id.name);
        if (!unitId) {
          noMatchPairs.set(`${_id.companyId}|${_id.name}`, { companyId: _id.companyId, name: _id.name, lines: count });
          continue;
        }
        resolvable += count;
        const companyKey = _id.companyId.toString();
        if (!unitsByCompany.has(companyKey))
          unitsByCompany.set(companyKey, { companyId: _id.companyId, unitIdByName: new Map() });
        unitsByCompany.get(companyKey).unitIdByName.set(_id.name, unitId);
      }

      const noMatchLines = [...noMatchPairs.values()].reduce((sum, pair) => sum + pair.lines, 0);
      totals.lines += lines;
      totals.resolvable += resolvable;
      console.log(
        `${dbKey}.${collection}: lines missing itemUnitId ${lines} (matched by unit name ${resolvable}, no matching unit ${noMatchLines})`,
      );

      if (apply) {
        for (const { companyId, unitIdByName } of unitsByCompany.values()) {
          // eslint-disable-next-line no-await-in-loop
          const result = await col.updateMany(
            { companyId, ...(path ? { [path]: { $elemMatch: hasUnitNameNoId('') } } : hasUnitNameNoId('')) },
            buildUpdatePipeline(path, unitIdByName),
          );
          totals.docsModified += result.modifiedCount;
        }
      }

      if (!noMatchPairs.size) continue;

      // An item has no other item to fall back to — its own itemUnitId is the field being filled.
      if (collection === 'items') {
        noMatchPairs.forEach(({ companyId, name, lines: count }) => {
          totals.unresolved += count;
          const key = `${companyId || '(no companyId)'} | ${name}`;
          unresolvedSummary.set(key, (unresolvedSummary.get(key) || 0) + count);
        });
        continue;
      }

      // Fallback: use the main unit of the line's item for lines whose unit name has no ItemUnit.
      const candidateFilter = {
        ...companyScope,
        ...(path ? { [path]: { $elemMatch: hasUnitNameNoId('') } } : hasUnitNameNoId('')),
      };
      const cursor = col.find(candidateFilter).project({
        companyId: 1,
        ...(path
          ? { [`${path}.itemId`]: 1, [`${path}.itemUnit`]: 1, [`${path}.itemUnitId`]: 1 }
          : { itemId: 1, itemUnit: 1, itemUnitId: 1 }),
      });

      let pending = [];
      let viaItem = 0;
      const flushPending = async () => {
        if (!pending.length) return;
        await loadMainUnits(pending.map(entry => entry.itemId));
        const operations = [];
        for (const entry of pending) {
          const unitId = entry.itemId ? mainUnitByItemId.get(entry.itemId.toString()) : null;
          if (unitId) {
            viaItem += 1;
            if (apply) {
              operations.push({
                updateOne: { filter: { _id: entry.docId, [entry.field]: null }, update: { $set: { [entry.field]: unitId } } },
              });
            }
          } else {
            totals.unresolved += 1;
            const key = `${entry.companyId || '(no companyId)'} | ${entry.name} (item has no itemUnitId)`;
            unresolvedSummary.set(key, (unresolvedSummary.get(key) || 0) + 1);
          }
        }
        if (operations.length) {
          const result = await col.bulkWrite(operations, { ordered: false });
          totals.docsModified += result.modifiedCount;
        }
        pending = [];
      };

      for await (const doc of cursor) {
        const docLines = path
          ? (doc[path] || []).map((line, index) => ({ line, field: `${path}.${index}.itemUnitId` }))
          : [{ line: doc, field: 'itemUnitId' }];
        for (const { line, field } of docLines) {
          const name = typeof line.itemUnit === 'string' ? line.itemUnit.trim().toUpperCase() : '';
          if (!name || (line.itemUnitId !== null && line.itemUnitId !== undefined)) continue;
          if (!noMatchPairs.has(`${doc.companyId}|${name}`)) continue;
          pending.push({ docId: doc._id, companyId: doc.companyId, itemId: line.itemId, name, field });
        }
        // eslint-disable-next-line no-await-in-loop
        if (pending.length >= 1000) await flushPending();
      }
      await flushPending();

      totals.viaItem += viaItem;
      console.log(`   fallback to item main unit: ${viaItem} of ${noMatchLines} unmatched lines`);
    }

    console.log('\nSUMMARY');
    console.log(`   lines missing itemUnitId      : ${totals.lines}`);
    console.log(`   matched by unit name          : ${totals.resolvable}`);
    console.log(`   taken from item main unit     : ${totals.viaItem}`);
    console.log(`   still unresolved (skipped)    : ${totals.unresolved}`);

    if (unresolvedSummary.size) {
      console.log('\nUNRESOLVED (companyId | unit name -> lines) — no ItemUnit for the name and no item main unit');
      for (const [key, count] of [...unresolvedSummary.entries()].sort()) console.log(`   ${key} -> ${count}`);
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    console.log('\nWRITTEN');
    console.log(`   documents modified : ${totals.docsModified}`);
    console.log('\nitemUnitId backfill complete.\n');
  } catch (error) {
    console.error('itemUnitId backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
