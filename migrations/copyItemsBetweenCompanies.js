/**
 * Copy item groups and items from one company to another in `booksCrm`.
 *
 * - **Item groups** (`itemgroups`): all documents for the source `companyId` are copied with new `_id`s
 *   and `companyId` set to the target company.
 * - **Items** (`items`): nested refs to **Item** and **ItemGroup** ids from this migration are rewritten.
 * - **Item inventories** (`iteminventories`): one row per copied item when the source has an inventory doc.
 *   `itemId` is mapped to the **new** item `_id`. Stock/value fields are reset to defaults; `warehouses` is `[]`.
 *   `backOrderOnly` and `inventorySalesMethod` are copied from the source.
 *
 * Other refs (Customer, Warehouse, User, Recipe, …) on items are not remapped.
 *
 * Usage: from abss-books-backend root:
 *   node migrations/copyItemsBetweenCompanies.js
 *
 * Edit SOURCE_COMPANY_ID and TARGET_COMPANY_ID before running.
 */

const { getConnection } = require('../config/db');
const { ObjectId } = require('mongodb');

/** @type {string} Hex ObjectId */
const SOURCE_COMPANY_ID = '67820c82e091a00003276a4a';
/** @type {string} Hex ObjectId */
const TARGET_COMPANY_ID = '69ce44823382b6f6ae0975e5';

const COLLECTION_ITEM_GROUPS = 'itemgroups';
const COLLECTION_ITEMS = 'items';
const COLLECTION_ITEM_INVENTORIES = 'iteminventories';

/**
 * Deep clone document values; ObjectIds become new ObjectId(...) copies.
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneDeep(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof ObjectId) return new ObjectId(value);
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = cloneDeep(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Replace any ObjectId whose string key exists in `idMap`.
 * @param {unknown} value
 * @param {Map<string, ObjectId>} idMap
 * @returns {unknown}
 */
function remapIdsInObject(value, idMap) {
  if (value === null || value === undefined) return value;
  if (value instanceof ObjectId) {
    const key = value.toString();
    return idMap.has(key) ? idMap.get(key) : value;
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(v => remapIdsInObject(v, idMap));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = remapIdsInObject(value[k], idMap);
    }
    return out;
  }
  return value;
}

/**
 * @param {Map<string, ObjectId>[]} maps
 * @returns {Map<string, ObjectId>}
 */
function mergeIdMaps(...maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [k, v] of m) {
      out.set(k, v);
    }
  }
  return out;
}

/**
 * @param {import('mongodb').Db} booksCrm
 * @param {ObjectId} sourceCompanyId
 * @param {ObjectId} targetCompanyId
 * @returns {Promise<Map<string, ObjectId>>}
 */
async function copyItemGroupsAndBuildMap(booksCrm, sourceCompanyId, targetCompanyId) {
  const coll = booksCrm.collection(COLLECTION_ITEM_GROUPS);
  const oldGroups = await coll.find({ companyId: sourceCompanyId }).sort({ _id: 1 }).toArray();

  console.log(`Found ${oldGroups.length} item groups for source company`);

  /** @type {Map<string, ObjectId>} */
  const itemGroupIdMap = new Map();
  for (const row of oldGroups) {
    itemGroupIdMap.set(row._id.toString(), new ObjectId());
  }

  if (oldGroups.length === 0) {
    return itemGroupIdMap;
  }

  const newDocs = [];
  for (const row of oldGroups) {
    const newId = itemGroupIdMap.get(row._id.toString());
    const cloned = cloneDeep(row);
    delete cloned._id;
    cloned._id = newId;
    cloned.companyId = targetCompanyId;
    newDocs.push(cloned);
  }

  await coll.insertMany(newDocs, { ordered: true });
  console.log(`Inserted ${newDocs.length} item groups for target company`);

  return itemGroupIdMap;
}

/**
 * Copy ItemInventory rows for the source company, aligned to migrated items only.
 * Does not copy warehouse rows or stock figures — resets those to schema defaults.
 *
 * @param {import('mongodb').Db} booksCrm
 * @param {ObjectId} sourceCompanyId
 * @param {ObjectId} targetCompanyId
 * @param {Map<string, ObjectId>} itemIdMap old item _id -> new item _id
 */
async function copyItemInventoriesForMigratedItems(booksCrm, sourceCompanyId, targetCompanyId, itemIdMap) {
  const coll = booksCrm.collection(COLLECTION_ITEM_INVENTORIES);
  const oldRows = await coll.find({ companyId: sourceCompanyId }).sort({ _id: 1 }).toArray();

  console.log(`Found ${oldRows.length} item inventory rows for source company`);

  const now = new Date();
  const newDocs = [];
  let skipped = 0;

  for (const row of oldRows) {
    const oldItemIdStr = row.itemId ? row.itemId.toString() : null;
    if (!oldItemIdStr || !itemIdMap.has(oldItemIdStr)) {
      skipped += 1;
      continue;
    }

    const newItemId = itemIdMap.get(oldItemIdStr);

    newDocs.push({
      _id: new ObjectId(),
      itemId: newItemId,
      companyId: targetCompanyId,
      backOrderOnly: Boolean(row.backOrderOnly),
      totalOpeningStock: 0,
      totalAvailableStock: 0,
      totalInventoryValue: 0,
      inventorySalesMethod:
        row.inventorySalesMethod !== undefined && row.inventorySalesMethod !== null ? row.inventorySalesMethod : null,
      warehouses: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  if (skipped > 0) {
    console.log(`Skipped ${skipped} item inventory row(s) whose itemId was not in the migrated items set (orphan or mismatch).`);
  }

  if (newDocs.length === 0) {
    console.log('No item inventory documents to insert.');
    return;
  }

  await coll.insertMany(newDocs, { ordered: true });
  console.log(
    `Inserted ${newDocs.length} item inventory document(s) for target company (itemId matches new items; warehouses cleared)`,
  );
}

/**
 * @param {{ sourceCompanyId?: string, targetCompanyId?: string }} [options] Override constants when calling programmatically.
 */
const copyItemsBetweenCompanies = async (options = {}) => {
  let client;
  const sourceHex = options.sourceCompanyId || SOURCE_COMPANY_ID;
  const targetHex = options.targetCompanyId || TARGET_COMPANY_ID;
  const sourceCompanyId = new ObjectId(sourceHex);
  const targetCompanyId = new ObjectId(targetHex);

  try {
    const db = await getConnection();
    client = db.client;
    const { booksCrm } = db;

    const itemGroupIdMap = await copyItemGroupsAndBuildMap(booksCrm, sourceCompanyId, targetCompanyId);

    const coll = booksCrm.collection(COLLECTION_ITEMS);

    const oldItems = await coll.find({ companyId: sourceCompanyId }).sort({ _id: 1 }).toArray();

    console.log(`Found ${oldItems.length} items for source company ${sourceHex}`);

    if (oldItems.length === 0) {
      console.log('No items to copy (item groups were still copied if any existed).');
      return;
    }

    /** @type {Map<string, ObjectId>} old item _id -> new _id */
    const itemIdMap = new Map();
    for (const row of oldItems) {
      itemIdMap.set(row._id.toString(), new ObjectId());
    }

    const combinedMap = mergeIdMaps(itemGroupIdMap, itemIdMap);

    const newDocs = [];

    for (const row of oldItems) {
      const oldIdStr = row._id.toString();
      const newId = itemIdMap.get(oldIdStr);

      const cloned = cloneDeep(row);
      delete cloned._id;

      const remapped = remapIdsInObject(cloned, combinedMap);

      remapped._id = newId;
      remapped.companyId = targetCompanyId;

      newDocs.push(remapped);
    }

    await coll.insertMany(newDocs, { ordered: true });

    console.log(`Inserted ${newDocs.length} items into target company ${targetHex}`);
    console.log(
      'ItemGroup and Item references from this copy were remapped. Other refs (customer, warehouse, users, …) unchanged.',
    );

    await copyItemInventoriesForMigratedItems(booksCrm, sourceCompanyId, targetCompanyId, itemIdMap);
  } catch (error) {
    console.error('Error copying item groups / items / item inventories:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

if (require.main === module) {
  copyItemsBetweenCompanies()
    .then(() => {
      console.log('Migration completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

module.exports = {
  copyItemsBetweenCompanies,
  cloneDeep,
  remapIdsInObject,
  mergeIdMaps,
  copyItemGroupsAndBuildMap,
  copyItemInventoriesForMigratedItems,
};
