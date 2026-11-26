/**
 * Sets isSellable / isPurchasable from document usage. Sales-module lines prove sellable;
 * purchase-module lines prove purchasable. Usage wins over a false flag — legacy invoices were
 * never blocked by the API, and false often means "hidden from picker" not "never sold".
 *
 * trackInventory is NOT set here. Production and inventory screens filter trackInventory: true;
 * use reportItemTrackInventory.js (batch/opening evidence) for that flag.
 *
 * Run BEFORE backfillItemPricing.js, then backfillItemAccounts.js for prices and ledger accounts.
 *
 * Run: node migrations/backfillItemRoles.js                      (dry run, all companies)
 *      node migrations/backfillItemRoles.js <companyId>           (dry run, one company)
 *      node migrations/backfillItemRoles.js <companyId> --apply (write)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

const LIST_LIMIT = 25;

const SALES_COLLECTIONS = [
  { name: 'invoices', db: 'books' },
  { name: 'creditnotes', db: 'books' },
  { name: 'quotes', db: 'booksCrm' },
  { name: 'salesorders', db: 'booksCrm' },
  { name: 'deliverychallans', db: 'books' },
  { name: 'recurringinvoices', db: 'books' },
];
const PURCHASE_COLLECTIONS = [
  { name: 'bills', db: 'books' },
  { name: 'debitnotes', db: 'books' },
  { name: 'purchaseorders', db: 'books' },
  { name: 'grpoorders', db: 'books' },
  { name: 'recurringbills', db: 'books' },
];

// Document counts, distinct item ids per collection, and which collections each item appears on.
const collectDocumentUsage = async (db, collections, scope) => {
  const used = new Set();
  const byCollection = [];
  const itemOnCollections = new Map();

  for (const { name, db: dbKey } of collections) {
    const docCount = await db[dbKey].collection(name).countDocuments(scope);
    const ids = (await db[dbKey].collection(name).distinct('items.itemId', scope)).filter(Boolean);
    ids.forEach(id => {
      const key = id.toString();
      used.add(key);
      if (!itemOnCollections.has(key)) itemOnCollections.set(key, new Set());
      itemOnCollections.get(key).add(name);
    });
    byCollection.push({ name, docCount, itemIdCount: ids.length });
  }

  return { used, byCollection, itemOnCollections };
};

const logDocumentUsage = (label, { used, byCollection }) => {
  console.log(`   ${label}`);
  byCollection.forEach(({ name, docCount, itemIdCount }) =>
    console.log(`      ${name.padEnd(20)} docs ${String(docCount).padStart(6)}   item ids ${String(itemIdCount).padStart(6)}`),
  );
  console.log(`      ${'distinct items'.padEnd(20)} ${String(used.size).padStart(6)}`);
};

const formatFlag = value => {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'missing';
};

const sellableFilter = (scope, soldItemIds) => ({
  ...scope,
  _id: { $in: [...soldItemIds].map(id => new ObjectId(id)) },
  'salesInformation.isSellable': { $ne: true },
});

const purchasableFilter = (scope, boughtItemIds) => ({
  ...scope,
  _id: { $in: [...boughtItemIds].map(id => new ObjectId(id)) },
  'purchaseInformation.isPurchasable': { $ne: true },
});

// Lists items that will be updated, with current flag and which old documents reference them.
const logItemsToUpdate = async (items, filter, itemOnCollections, roleLabel, flagKey) => {
  const total = await items.countDocuments(filter);
  console.log(`\n${roleLabel} (${total})`);
  if (!total) return total;

  const rows = await items
    .find(filter)
    .project({ itemNo: 1, itemName: 1, salesInformation: 1, purchaseInformation: 1 })
    .limit(LIST_LIMIT)
    .toArray();

  for (const item of rows) {
    const id = item._id.toString();
    const flag = flagKey === 'isSellable' ? item.salesInformation?.isSellable : item.purchaseInformation?.isPurchasable;
    const onDocs = [...(itemOnCollections.get(id) || [])].sort().join(', ') || '?';
    console.log(
      `   ${(item.itemNo || '?').padEnd(12)} ${(item.itemName || '').slice(0, 32).padEnd(34)} ${flagKey}=${formatFlag(flag)}  docs: ${onDocs}`,
    );
  }
  if (total > LIST_LIMIT) console.log(`   ... and ${total - LIST_LIMIT} more`);

  return total;
};

// Sales document usage → isSellable true (dry run counts, --apply writes).
const applySellableFromUsage = async (items, scope, soldItemIds, apply) => {
  if (!soldItemIds.size) {
    console.log(`\n1 isSellable ${apply ? 'set' : 'would set'}             : 0`);
    return 0;
  }
  const filter = sellableFilter(scope, soldItemIds);
  if (!apply) {
    const count = await items.countDocuments(filter);
    console.log(`\n1 isSellable would set             : ${count}`);
    return count;
  }
  const result = await items.updateMany(filter, { $set: { 'salesInformation.isSellable': true } });
  console.log(`\n1 isSellable set                   : ${result.modifiedCount}`);
  return result.modifiedCount;
};

// Purchase document usage → isPurchasable true (dry run counts, --apply writes).
const applyPurchasableFromUsage = async (items, scope, boughtItemIds, apply) => {
  if (!boughtItemIds.size) {
    console.log(`2 isPurchasable ${apply ? 'set' : 'would set'}           : 0`);
    return 0;
  }
  const filter = purchasableFilter(scope, boughtItemIds);
  if (!apply) {
    const count = await items.countDocuments(filter);
    console.log(`2 isPurchasable would set           : ${count}`);
    return count;
  }
  const result = await items.updateMany(filter, { $set: { 'purchaseInformation.isPurchasable': true } });
  console.log(`2 isPurchasable set                 : ${result.modifiedCount}`);
  return result.modifiedCount;
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
    console.log(apply ? 'Mode: APPLY' : 'Mode: dry run — pass --apply to write');
    if (!targetCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}`);
    }

    const items = db.booksCrm.collection('items');
    const sold = await collectDocumentUsage(db, SALES_COLLECTIONS, scope);
    const bought = await collectDocumentUsage(db, PURCHASE_COLLECTIONS, scope);
    const soldItemIds = sold.used;
    const boughtItemIds = bought.used;

    console.log('\nOLD DOCUMENTS (docs = row count, item ids = distinct lines in that collection)');
    logDocumentUsage('SALES', sold);
    logDocumentUsage('PURCHASE', bought);

    if (soldItemIds.size) {
      await logItemsToUpdate(
        items,
        sellableFilter(scope, soldItemIds),
        sold.itemOnCollections,
        'ITEMS ON SALES DOCS → isSellable true',
        'isSellable',
      );
    }

    if (boughtItemIds.size) {
      await logItemsToUpdate(
        items,
        purchasableFilter(scope, boughtItemIds),
        bought.itemOnCollections,
        'ITEMS ON PURCHASE DOCS → isPurchasable true',
        'isPurchasable',
      );
    }

    await applySellableFromUsage(items, scope, soldItemIds, apply);
    await applyPurchasableFromUsage(items, scope, boughtItemIds, apply);

    if (!apply) console.log('\nNothing written. Re-run with --apply to backfill.');
  } catch (error) {
    console.error('Role backfill failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
