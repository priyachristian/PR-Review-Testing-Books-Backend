/**
 * Read-only worklist before defaultPrice is retired and ledger rules are enforced.
 * Mirrors backfillItemPricing.js and backfillItemAccounts.js — same role gates and fill rules.
 *
 * Prices:
 *   isSellable true  -> needs sellingPrice (fill from defaultPrice when > 0)
 *   isPurchasable true -> needs costPrice (fill from BILL/GRPO/SPLIT_BILL batch, else defaultPrice)
 *   trackInventory true but not purchasable -> missing cost reported for visibility; backfill skips write
 *
 * Accounts (see backfillItemAccounts.js):
 *   isSellable true  -> salesAccountId (SALES)
 *   isPurchasable goods -> purchaseAccountId (COGS)
 *   isPurchasable services -> purchaseAccountId manual
 *   trackInventory goods with stock -> inventoryAccountId (INVENTORY_ASSET)
 *
 * Run: node migrations/reportItemPricing.js
 *      node migrations/reportItemPricing.js <companyId>
 *      node migrations/reportItemPricing.js <companyId> --list
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

const LIST_LIMIT = 25;
const PURCHASE_SOURCE_TYPES = ['BILL', 'GRPO', 'SPLIT_BILL'];

const missingPrice = field => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }, { [field]: 0 }] });
const missingAccount = field => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }] });

const sellableOn = { 'salesInformation.isSellable': true };
const purchasableOn = { 'purchaseInformation.isPurchasable': true };
const trackOn = { trackInventory: true };
const goodsOn = { 'itemCategory.isGoods': true };
const serviceOn = { 'itemCategory.isService': true };

// Any batch or opening stock — same stock evidence as backfillItemAccounts inventory filter.
const itemsHoldingStockIds = async (db, scope) => {
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

// Purchase-document batch costs only — matches backfillItemPricing.js.
const purchaseBatchCostByItemId = async (db, scope, itemIds) => {
  if (!itemIds.length) return new Map();
  const batches = await db.booksCrm
    .collection('itembatches')
    .find({
      ...scope,
      itemId: { $in: itemIds },
      purchasePrice: { $gt: 0 },
      sourceType: { $in: PURCHASE_SOURCE_TYPES },
    })
    .project({ itemId: 1, purchasePrice: 1, createdAt: 1 })
    .sort({ createdAt: 1 })
    .toArray();

  const byItem = new Map();
  batches.forEach(batch => byItem.set(batch.itemId?.toString(), batch.purchasePrice));
  return byItem;
};

const itemIdsHoldingStockNow = async (db, scope) => {
  const inventories = db.booksCrm.collection('iteminventories');
  const stockRows = await inventories
    .find({
      ...scope,
      $or: [{ totalOpeningStock: { $gt: 0 } }, { warehouses: { $elemMatch: { openingStock: { $gt: 0 } } } }],
    })
    .project({ itemId: 1 })
    .toArray();
  const batchStockRows = await db.booksCrm
    .collection('itembatches')
    .aggregate([{ $match: { ...scope, remainingQty: { $gt: 0 } } }, { $group: { _id: '$itemId' } }])
    .toArray();

  const ids = new Set(stockRows.map(row => row.itemId?.toString()));
  batchStockRows.forEach(row => row._id && ids.add(String(row._id)));
  return ids;
};

const logItemList = (title, list, companyName, extra = item => '') => {
  console.log(`\n${title} (${list.length})`);
  if (!list.length) {
    console.log('   none');
    return;
  }
  list.slice(0, LIST_LIMIT).forEach(item => {
    const company = companyName ? `  ${companyName(item.companyId)}` : '';
    console.log(
      `   ${(item.itemNo || '?').padEnd(12)} ${(item.itemName || '').slice(0, 38).padEnd(40)}` +
        `defaultPrice=${item.defaultPrice ?? '-'}${company}${extra(item)}`,
    );
  });
  if (list.length > LIST_LIMIT) console.log(`   ... and ${list.length - LIST_LIMIT} more`);
};

const report = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const showList = args.includes('--list');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    if (targetCompanyId && isCompanyExcluded(targetCompanyId)) {
      console.log(`Company ${targetCompanyId} is in EXCLUDED_COMPANY_IDS — nothing to report.`);
      return;
    }

    const scope = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludedObjectIds.length
        ? { companyId: { $nin: excludedObjectIds } }
        : {};

    console.log(`Scope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}   (read-only)`);
    if (!targetCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}`);
    }

    const items = db.booksCrm.collection('items');
    const accounts = db.books.collection('accounts');

    const total = await items.countDocuments(scope);
    const sellableCount = await items.countDocuments({ ...scope, ...sellableOn });
    const purchasableCount = await items.countDocuments({ ...scope, ...purchasableOn });
    const trackedCount = await items.countDocuments({ ...scope, ...trackOn });
    const goodsPurchasable = await items.countDocuments({ ...scope, ...goodsOn, ...purchasableOn });
    const servicePurchasable = await items.countDocuments({ ...scope, ...serviceOn, ...purchasableOn });

    console.log('\nITEMS BY ROLE (flag must be true)');
    console.log(`   total              : ${total}`);
    console.log(`   isSellable         : ${sellableCount}`);
    console.log(`   isPurchasable      : ${purchasableCount}`);
    console.log(`   trackInventory     : ${trackedCount}`);
    console.log(`   goods + purchasable: ${goodsPurchasable}`);
    console.log(`   service + purchasable: ${servicePurchasable}`);

    // --- pricing (backfillItemPricing.js) ---
    const needsSellingPrice = await items
      .find({ ...scope, ...sellableOn, ...missingPrice('salesInformation.sellingPrice') })
      .project({ itemNo: 1, itemName: 1, companyId: 1, defaultPrice: 1 })
      .toArray();

    const needsCostPriceBroad = await items
      .find({
        ...scope,
        $and: [{ $or: [{ ...purchasableOn }, { ...trackOn }] }, missingPrice('purchaseInformation.costPrice')],
      })
      .project({
        itemNo: 1,
        itemName: 1,
        companyId: 1,
        defaultPrice: 1,
        purchaseInformation: 1,
        trackInventory: 1,
        itemCategory: 1,
      })
      .toArray();

    const purchasableMissingCost = needsCostPriceBroad.filter(item => item.purchaseInformation?.isPurchasable === true);
    const trackedNotPurchasableMissingCost = needsCostPriceBroad.filter(item => item.purchaseInformation?.isPurchasable !== true);

    const batchCosts = await purchaseBatchCostByItemId(
      db,
      scope,
      purchasableMissingCost.map(item => item._id),
    );

    const sellingFromDefault = needsSellingPrice.filter(item => Number(item.defaultPrice) > 0);
    const costFromBatch = purchasableMissingCost.filter(item => batchCosts.has(item._id.toString()));
    const costFromDefault = purchasableMissingCost.filter(
      item => !batchCosts.has(item._id.toString()) && Number(item.defaultPrice) > 0,
    );
    const costManual = purchasableMissingCost.length - costFromBatch.length - costFromDefault.length;
    const sellingManual = needsSellingPrice.length - sellingFromDefault.length;
    const backfillPrices = sellingFromDefault.length + costFromBatch.length + costFromDefault.length;

    console.log('\nMISSING SELLING PRICE (isSellable true)');
    console.log(`   items missing sellingPrice     : ${needsSellingPrice.length}`);
    console.log(`     backfill from defaultPrice   : ${sellingFromDefault.length}`);
    console.log(`     manual                       : ${sellingManual}`);

    console.log('\nMISSING COST PRICE');
    console.log(`   isPurchasable true             : ${purchasableMissingCost.length}`);
    console.log(`     backfill from purchase batch : ${costFromBatch.length}`);
    console.log(`     backfill from defaultPrice   : ${costFromDefault.length}`);
    console.log(`     manual                       : ${costManual}`);
    console.log(`   trackInventory on, not purchasable: ${trackedNotPurchasableMissingCost.length}`);
    console.log('     (reported only — backfillItemPricing does not write cost for these)');

    const holdingStockIds = await itemIdsHoldingStockNow(db, scope);
    const holdingWithoutCost = purchasableMissingCost.filter(item => holdingStockIds.has(item._id.toString()));
    console.log('\nHOLDING STOCK NOW, PURCHASABLE, NO COST PRICE');
    console.log(`   items                        : ${holdingWithoutCost.length}`);
    console.log(
      `     no defaultPrice either       : ${holdingWithoutCost.filter(item => !(Number(item.defaultPrice) > 0)).length}`,
    );

    // --- accounts (backfillItemAccounts.js) ---
    const holdingStock = await itemsHoldingStockIds(db, scope);
    const missingSalesAccount = await items.countDocuments({
      ...scope,
      ...sellableOn,
      ...missingAccount('salesInformation.salesAccountId'),
    });
    const missingGoodsPurchaseAccount = await items.countDocuments({
      ...scope,
      ...goodsOn,
      ...purchasableOn,
      ...missingAccount('purchaseInformation.purchaseAccountId'),
    });
    const missingServicePurchaseAccount = await items.countDocuments({
      ...scope,
      ...serviceOn,
      ...purchasableOn,
      ...missingAccount('purchaseInformation.purchaseAccountId'),
    });
    const missingInventoryAccount = holdingStock.length
      ? await items.countDocuments({
          ...scope,
          ...goodsOn,
          ...trackOn,
          _id: { $in: holdingStock },
          ...missingAccount('inventoryAccountId'),
        })
      : 0;

    const hasSales = targetCompanyId ? await accounts.findOne({ ...scope, systemAccountKey: 'SALES' }) : true;
    const hasCogs = targetCompanyId ? await accounts.findOne({ ...scope, systemAccountKey: 'COST_OF_GOODS_SOLD' }) : true;
    const hasInventory = targetCompanyId ? await accounts.findOne({ ...scope, systemAccountKey: 'INVENTORY_ASSET' }) : true;

    console.log('\nMISSING LEDGER ACCOUNTS (backfillItemAccounts.js)');
    console.log(`   sellable, no salesAccountId       : ${missingSalesAccount}  -> SALES`);
    console.log(`   goods purchasable, no purchaseId  : ${missingGoodsPurchaseAccount}  -> COGS`);
    console.log(`   service purchasable, no purchaseId: ${missingServicePurchaseAccount}  -> manual expense`);
    console.log(`   tracked goods w stock, no inv acct: ${missingInventoryAccount}  -> INVENTORY_ASSET`);
    if (targetCompanyId && !hasSales) console.log('   WARN: SALES system account missing for this company');
    if (targetCompanyId && !hasCogs) console.log('   WARN: COST_OF_GOODS_SOLD system account missing');
    if (targetCompanyId && !hasInventory) console.log('   WARN: INVENTORY_ASSET system account missing');

    console.log('\nSUMMARY');
    console.log(`   ${backfillPrices} prices fillable by backfillItemPricing.js`);
    console.log(`   ${sellingManual + costManual} prices need manual entry`);
    console.log(
      `   ${missingSalesAccount + missingGoodsPurchaseAccount + missingInventoryAccount} accounts fillable by backfillItemAccounts.js`,
    );
    console.log(`   ${missingServicePurchaseAccount} service purchase accounts need manual pick`);

    if (showList) {
      const companies = targetCompanyId
        ? []
        : await db.common
            .collection('companies')
            .find(excludedObjectIds.length ? { _id: { $nin: excludedObjectIds } } : {})
            .project({ name: 1 })
            .toArray();
      const companyName = id => {
        if (!id) return '';
        if (targetCompanyId) return '';
        const row = companies.find(c => String(c._id) === String(id));
        return row?.name || String(id);
      };

      logItemList('ITEMS NEEDING SELLING PRICE', needsSellingPrice, companyName);
      logItemList('ITEMS NEEDING COST PRICE (isPurchasable)', purchasableMissingCost, companyName, item => {
        const src = batchCosts.has(item._id.toString())
          ? '  batch=yes'
          : Number(item.defaultPrice) > 0
            ? '  default=yes'
            : '  manual';
        return src;
      });
      if (trackedNotPurchasableMissingCost.length) {
        logItemList(
          'TRACKED NOT PURCHASABLE — MISSING COST (no backfill)',
          trackedNotPurchasableMissingCost,
          companyName,
          item => `  track=${item.trackInventory ? 'Y' : 'N'}`,
        );
      }
    }

    console.log('\nNothing written. Pass --list to see item names.\n');
  } catch (error) {
    console.error('Report failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

report();
