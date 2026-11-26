/**
 * Flatten Books/Books-CRM/CRM `updatedBy` history arrays to a scalar User ObjectId.
 *
 * Only collections whose Mongoose models use scalar `updatedBy` (ObjectId ref User).
 * Skips CustomerOrder / CustomerPayment (still array / polymorphic by design).
 * Skips deleted BusinessAccountLedger collections.
 *
 * For each document where `updatedBy` is still an array, or a single embedded entry
 * object (e.g. productionorders `{ _id, updatedAt }`):
 * - Sets `updatedBy` to the latest entry's user id when present
 * - Copies the latest entry `updatedAt` onto the document only when the document
 *   has no valid `updatedAt`
 * - Never overwrites an already-scalar ObjectId `updatedBy` with null
 * - Empty arrays AND unusable entries -> `updatedBy: null`
 *   (an array breaks scalar-schema saves with CastError; an object is read as its
 *   embedded `_id`, which is not a user)
 *
 * Does NOT touch common Company / CompanySettings collections.
 *
 * Backup affected collections before running with --apply.
 *
 * Run:
 *   node migrations/flattenUpdatedByHistory-remove.js
 *   node migrations/flattenUpdatedByHistory-remove.js <companyId>
 *   node migrations/flattenUpdatedByHistory-remove.js --apply
 *   node migrations/flattenUpdatedByHistory-remove.js <companyId> --apply
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const TARGETS = [
  // booksCrm: scalar updatedBy models
  { db: 'booksCrm', collection: 'quotes' },
  { db: 'booksCrm', collection: 'salesorders' },
  { db: 'booksCrm', collection: 'customers' },
  { db: 'booksCrm', collection: 'items' },
  { db: 'booksCrm', collection: 'iteminventories' },
  { db: 'booksCrm', collection: 'itembatches' },
  { db: 'booksCrm', collection: 'itemunits' },
  { db: 'booksCrm', collection: 'paymentreceiveds' },
  { db: 'booksCrm', collection: 'warehouses' },
  { db: 'booksCrm', collection: 'branches' },
  { db: 'booksCrm', collection: 'divisions' },
  // books: scalar updatedBy models
  { db: 'books', collection: 'invoices' },
  { db: 'books', collection: 'deliverychallans' },
  { db: 'books', collection: 'creditnotes' },
  { db: 'books', collection: 'purchaseorders' },
  { db: 'books', collection: 'grpoorders' },
  { db: 'books', collection: 'bills' },
  { db: 'books', collection: 'debitnotes' },
  { db: 'books', collection: 'recurringbills' },
  { db: 'books', collection: 'recurringinvoices' },
  { db: 'books', collection: 'recurringexpenses' },
  { db: 'books', collection: 'paymentmades' },
  { db: 'books', collection: 'manualjournals' },
  { db: 'books', collection: 'expenses' },
  { db: 'books', collection: 'inventorytransferrequests' },
  { db: 'books', collection: 'inventoryadjustments' },
  { db: 'books', collection: 'productionorders' },
  { db: 'books', collection: 'rejectionorders' },
  { db: 'books', collection: 'invoicedispatches' },
  { db: 'books', collection: 'accounts' },
  // AccountLedger model uses collection: 'accountledger' (not accountledger2)
  { db: 'books', collection: 'accountledger' },
  { db: 'books', collection: 'accountopeningbalances' },
  { db: 'books', collection: 'recipes' },
  { db: 'books', collection: 'processes' },
  { db: 'books', collection: 'qualitymasters' },
  { db: 'books', collection: 'rejectionreasons' },
  { db: 'books', collection: 'transportcouriers' },
  { db: 'books', collection: 'gsts' },
  { db: 'books', collection: 'developmentupdates' },
  { db: 'books', collection: 'complaints' },
  { db: 'books', collection: 'problemlists' },
  // crm: models changed to scalar in the same refactor. developmentupdates has no companyId,
  // so the CRM backend's per-company script never reaches it.
  { db: 'crm', collection: 'leads' },
  { db: 'crm', collection: 'campaigns' },
  { db: 'crm', collection: 'visits' },
  { db: 'crm', collection: 'tasks' },
  { db: 'crm', collection: 'developmentupdates' },
];

// $type 'object' excludes ObjectId/Date, and $expr avoids matching arrays by their elements.
const misalignedFilter = { $expr: { $in: [{ $type: '$updatedBy' }, ['array', 'object']] } };

const isEntryObject = value =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !value._bsontype && !(value instanceof Date);

/**
 * Extract scalar user ObjectId + optional entry timestamp from the last history entry,
 * or from a single embedded entry object.
 * @returns {{ userId: ObjectId|null, entryUpdatedAt: Date|null, empty: boolean, unusable: boolean, skip: boolean }}
 */
function deriveFromHistory(updatedBy) {
  const isArray = Array.isArray(updatedBy);
  // Guard: never touch scalar ObjectId, null or other values even if the filter changes
  if (!isArray && !isEntryObject(updatedBy)) {
    return { userId: null, entryUpdatedAt: null, empty: false, unusable: false, skip: true };
  }
  if (isArray && updatedBy.length === 0) {
    return { userId: null, entryUpdatedAt: null, empty: true, unusable: false, skip: false };
  }

  const last = isArray ? updatedBy[updatedBy.length - 1] : updatedBy;
  if (!isEntryObject(last)) {
    return { userId: null, entryUpdatedAt: null, empty: false, unusable: true, skip: false };
  }

  let candidate = null;

  if (last.userId) {
    candidate = last.userId;
  } else if (last.updatedBy) {
    // Legacy polymorphic entry shape (e.g. { updatedByType, updatedBy })
    const type = last.updatedByType;
    if (!type || type === 'User') {
      candidate = last.updatedBy;
    }
  }

  const userId = candidate && ObjectId.isValid(candidate) ? new ObjectId(candidate) : null;
  const entryUpdatedAt = last.updatedAt ? new Date(last.updatedAt) : null;

  if (!userId) {
    return { userId: null, entryUpdatedAt, empty: false, unusable: true, skip: false };
  }

  return { userId, entryUpdatedAt, empty: false, unusable: false, skip: false };
}

function needsDocumentUpdatedAt(doc, entryUpdatedAt) {
  if (!entryUpdatedAt || Number.isNaN(entryUpdatedAt.getTime())) return false;
  if (!doc.updatedAt) return true;
  const existing = new Date(doc.updatedAt);
  return Number.isNaN(existing.getTime());
}

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`Scope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode: APPLY' : 'Mode: dry run, pass --apply to write');
    console.log('Empty / unusable arrays and entry objects will be set to null');

    const companyScope = targetCompanyId ? { companyId: targetCompanyId } : {};
    let totalWouldUpdate = 0;
    let totalUpdated = 0;
    let totalCleared = 0;
    let totalFlatten = 0;
    let totalObjects = 0;

    for (const target of TARGETS) {
      const collection = db[target.db].collection(target.collection);
      const filter = { ...companyScope, ...misalignedFilter };

      const cursor = collection.find(filter).project({ _id: 1, updatedBy: 1, updatedAt: 1 });
      const ops = [];
      let collCleared = 0;
      let collFlatten = 0;
      let collObjects = 0;

      // eslint-disable-next-line no-await-in-loop
      while (await cursor.hasNext()) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await cursor.next();
        const { userId, entryUpdatedAt, empty, unusable, skip } = deriveFromHistory(doc.updatedBy);
        if (skip) continue;
        if (!Array.isArray(doc.updatedBy)) collObjects += 1;

        // Empty or unusable entry: history is gone, leave a scalar-safe null
        if (empty || unusable || !userId) {
          collCleared += 1;
          ops.push({
            updateOne: {
              filter: { _id: doc._id, ...misalignedFilter },
              update: { $set: { updatedBy: null } },
            },
          });
          continue;
        }

        const $set = { updatedBy: userId };
        if (needsDocumentUpdatedAt(doc, entryUpdatedAt)) {
          $set.updatedAt = entryUpdatedAt;
        }

        ops.push({
          updateOne: {
            filter: { _id: doc._id, ...misalignedFilter },
            update: { $set },
          },
        });
        collFlatten += 1;
      }

      totalWouldUpdate += ops.length;
      totalCleared += collCleared;
      totalFlatten += collFlatten;
      totalObjects += collObjects;

      console.log(
        `${target.db}.${target.collection}: flatten=${collFlatten}, clearedNull=${collCleared}, fromObject=${collObjects}, ops=${ops.length}`,
      );

      if (apply && ops.length) {
        const BATCH = 500;
        for (let i = 0; i < ops.length; i += BATCH) {
          const slice = ops.slice(i, i + BATCH);
          // eslint-disable-next-line no-await-in-loop
          const result = await collection.bulkWrite(slice, { ordered: false });
          totalUpdated += result.modifiedCount + (result.upsertedCount || 0);
        }
      }
    }

    console.log('\n--- Summary ---');
    console.log(`Ops prepared: ${totalWouldUpdate}`);
    console.log(`Flattened to user ObjectId: ${totalFlatten}`);
    console.log(`Cleared to null (empty/unusable): ${totalCleared}`);
    console.log(`Of which were entry objects: ${totalObjects}`);
    if (apply) {
      console.log(`Documents modified: ${totalUpdated}`);
    } else {
      console.log('Nothing written. Re-run with --apply after backing up collections.');
    }
  } catch (error) {
    console.error('flattenUpdatedByHistory-remove failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
