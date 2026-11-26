/**
 * Sets trackInventory from legacy itemClassification.inventoryItem and removes itemClassification.
 * Services are always untracked. Goods with batch or opening-stock evidence become tracked even
 * when the old flag was false. Idempotent: rows that already have trackInventory are not changed.
 *
 * Run reportOrphanStockItems.js first and fix stranded stock before this script.
 * Then backfillItemRoles.js and backfillItemAccounts.js for sellable flags and ledger accounts.
 *
 * Run: node migrations/reportItemTrackInventory.js                  # dry run report
 *      node migrations/reportItemTrackInventory.js --apply          # all companies
 *      node migrations/reportItemTrackInventory.js <companyId> --apply
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

// Item ids with any batch history or opening stock — stronger evidence than the old flag.
const inventoryEvidenceItemIds = async (db, scope) => {
  const [batched, opening] = await Promise.all([
    db.booksCrm
      .collection('itembatches')
      .aggregate([{ $match: scope }, { $group: { _id: '$itemId' } }])
      .toArray(),
    db.booksCrm
      .collection('iteminventories')
      .find({
        ...scope,
        $or: [{ totalOpeningStock: { $gt: 0 } }, { warehouses: { $elemMatch: { openingStock: { $gt: 0 } } } }],
      })
      .project({ itemId: 1 })
      .toArray(),
  ]);

  const byId = new Map();
  batched.forEach(row => row._id && byId.set(String(row._id), row._id));
  opening.forEach(row => row.itemId && byId.set(String(row.itemId), row.itemId));
  return [...byId.values()];
};

const applyOrCount = async (items, filter, update, apply) =>
  apply ? (await items.updateMany(filter, update)).modifiedCount : items.countDocuments(filter);

// Services can never hold stock — force untracked while itemClassification is still readable.
const setServicesUntracked = async (items, scope, apply) => {
  const filter = { ...scope, trackInventory: { $exists: false }, 'itemCategory.isService': true };
  const count = await applyOrCount(items, filter, { $set: { trackInventory: false } }, apply);
  console.log(`1 services -> trackInventory false : ${count}${apply ? '' : ' (would set)'}`);
  return count;
};

// Goods tracked when the old flag said so or stock evidence proves inventory history.
const setTrackedGoods = async (items, scope, evidenceIds, apply) => {
  const filter = {
    ...scope,
    trackInventory: { $exists: false },
    'itemCategory.isService': { $ne: true },
    $or: [{ 'itemClassification.inventoryItem': true }, { _id: { $in: evidenceIds } }],
  };
  const count = await applyOrCount(items, filter, { $set: { trackInventory: true } }, apply);
  console.log(`2 goods    -> trackInventory true  : ${count}${apply ? '' : ' (would set)'}`);
  return count;
};

// Remaining goods without stock evidence stay untracked.
const setUntrackedGoods = async (items, scope, evidenceIds, apply) => {
  const filter = {
    ...scope,
    trackInventory: { $exists: false },
    'itemCategory.isService': { $ne: true },
    'itemClassification.inventoryItem': { $ne: true },
    _id: { $nin: evidenceIds },
  };
  const count = await applyOrCount(items, filter, { $set: { trackInventory: false } }, apply);
  console.log(`3 goods    -> trackInventory false : ${count}${apply ? '' : ' (would set)'}`);
  return count;
};

// Drop legacy classification after trackInventory is set — never before steps 1–3.
const removeItemClassification = async (items, scope, apply) => {
  const filter = { ...scope, itemClassification: { $exists: true } };
  const count = await applyOrCount(items, filter, { $unset: { itemClassification: '' } }, apply);
  console.log(`4 itemClassification ${apply ? 'removed' : 'to remove'}     : ${count}`);
  return count;
};

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const apply = process.argv.slice(2).includes('--apply');
    const companyArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    if (targetCompanyId && isCompanyExcluded(targetCompanyId)) {
      console.log(`Company ${targetCompanyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
      return;
    }

    const scope = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludedObjectIds.length
        ? { companyId: { $nin: excludedObjectIds } }
        : {};

    console.log(`Scope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode : APPLYING CHANGES\n' : 'Mode : dry run — pass --apply to write\n');
    if (!targetCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}`);
    }

    const items = db.booksCrm.collection('items');
    const evidenceIds = await inventoryEvidenceItemIds(db, scope);

    await setServicesUntracked(items, scope, apply);
    await setTrackedGoods(items, scope, evidenceIds, apply);
    await setUntrackedGoods(items, scope, evidenceIds, apply);
    await removeItemClassification(items, scope, apply);

    const missingFlag = await items.countDocuments({ ...scope, trackInventory: { $exists: false } });
    const oldFieldLeft = await items.countDocuments({ ...scope, itemClassification: { $exists: true } });
    console.log(
      apply
        ? `\nPost-check — without trackInventory: ${missingFlag}, with itemClassification: ${oldFieldLeft} (both should be 0)`
        : `\nCurrent state — without trackInventory: ${missingFlag}, with itemClassification: ${oldFieldLeft}`,
    );
    if (!apply) {
      console.log('\nDry run only. Re-run with --apply to write.');
    }
  } catch (error) {
    console.error('trackInventory migration failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
