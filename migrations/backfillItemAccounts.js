/**
 * Fills missing ledger accounts on items from company system accounts.
 * Each account is set only when that role is explicitly ON on the item:
 *   isSellable true     -> salesAccountId = SALES
 *   trackInventory true -> inventoryAccountId = INVENTORY_ASSET (goods with stock evidence)
 *   isPurchasable true (goods) -> purchaseAccountId = COST_OF_GOODS_SOLD
 * Purchasable services are listed for manual expense account choice (not auto-filled).
 * Only missing values are written; existing choices are never replaced.
 *
 * Run AFTER seedMissingSystemAccounts.js, reportItemTrackInventory.js, and backfillItemRoles.js.
 *
 * Run: node migrations/backfillItemAccounts.js                      (dry run, all companies)
 *      node migrations/backfillItemAccounts.js <companyId>           (dry run, one company)
 *      node migrations/backfillItemAccounts.js <companyId> --apply   (write)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId, '6a6736d07e304779a015d7ff'];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

const LIST_LIMIT = 25;

const missingAccount = field => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }] });

// Role flags must be explicitly true — missing/false means that section is off on the item.
const sellableOn = { 'salesInformation.isSellable': true };
const purchasableOn = { 'purchaseInformation.isPurchasable': true };
const trackOn = { trackInventory: true };
const goodsOn = { 'itemCategory.isGoods': true };

// Stock evidence: any batch or opening figure — item needs an inventory account when it holds stock.
const itemsHoldingStock = async (db, companyScope) => {
  const [batched, opening] = await Promise.all([
    db.booksCrm
      .collection('itembatches')
      .aggregate([{ $match: companyScope }, { $group: { _id: '$itemId' } }])
      .toArray(),
    db.booksCrm
      .collection('iteminventories')
      .find({
        ...companyScope,
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

const salesFilter = scope => ({
  ...scope,
  ...sellableOn,
  ...missingAccount('salesInformation.salesAccountId'),
});

const inventoryFilter = async (db, scope) => {
  const holdingStock = await itemsHoldingStock(db, scope);
  if (!holdingStock.length) {
    return { ...scope, _id: { $in: [] }, ...missingAccount('inventoryAccountId') };
  }
  return {
    ...scope,
    ...goodsOn,
    ...trackOn,
    _id: { $in: holdingStock },
    ...missingAccount('inventoryAccountId'),
  };
};

// Purchasable goods (purchase information ON) -> COGS, whether or not track inventory is on.
const goodsPurchaseFilter = scope => ({
  ...scope,
  ...goodsOn,
  ...purchasableOn,
  ...missingAccount('purchaseInformation.purchaseAccountId'),
});

const servicePurchaseManualFilter = scope => ({
  ...scope,
  'itemCategory.isService': true,
  ...purchasableOn,
  ...missingAccount('purchaseInformation.purchaseAccountId'),
});

// Lists items that need an account filled (dry run preview or remaining after apply).
const logItemsNeedingAccount = async (items, filter, title, accountLabel, limit = LIST_LIMIT, companyNameById = new Map()) => {
  const total = await items.countDocuments(filter);
  console.log(`\n${title} (${total})`);
  if (!total) return total;

  const rows = await items.find(filter).project({ itemNo: 1, itemName: 1, companyId: 1 }).limit(limit).toArray();

  for (const item of rows) {
    const company = companyNameById.size ? `  [${companyNameById.get(String(item.companyId)) || '?'} (${item.companyId})]` : '';
    console.log(
      `   ${String(item._id).padEnd(26)} ${(item.itemNo || '?').padEnd(12)} ${(item.itemName || '').slice(0, 36).padEnd(38)} -> ${accountLabel}${company}`,
    );
  }
  if (limit > 0 && total > limit) console.log(`   ... and ${total - limit} more`);

  return total;
};

// Sellable (sales information ON) missing sales account -> SALES.
const fillSalesAccounts = async (items, accounts, companyScope, apply) => {
  const filter = salesFilter(companyScope);
  const needs = await items.countDocuments(filter);
  if (!needs) return { written: 0, skipped: null, needs: 0 };

  const salesAccount = await accounts.findOne({ ...companyScope, systemAccountKey: 'SALES' });
  if (!salesAccount) return { written: 0, skipped: 'SALES', needs };

  if (!apply) return { written: 0, skipped: null, needs };

  const result = await items.updateMany(filter, { $set: { 'salesInformation.salesAccountId': salesAccount._id } });
  return { written: result.modifiedCount, skipped: null, needs: 0 };
};

// trackInventory ON + goods with stock evidence -> INVENTORY_ASSET.
const fillInventoryAccounts = async (items, accounts, companyScope, db, apply) => {
  const filter = await inventoryFilter(db, companyScope);
  const needs = await items.countDocuments(filter);
  if (!needs) return { written: 0, skipped: null, needs: 0 };

  const inventoryAccount = await accounts.findOne({ ...companyScope, systemAccountKey: 'INVENTORY_ASSET' });
  if (!inventoryAccount) return { written: 0, skipped: 'INVENTORY_ASSET', needs };

  if (!apply) return { written: 0, skipped: null, needs };

  const result = await items.updateMany(filter, { $set: { inventoryAccountId: inventoryAccount._id } });
  return { written: result.modifiedCount, skipped: null, needs: 0 };
};

// Purchasable goods (purchase information ON) -> COST_OF_GOODS_SOLD.
const fillGoodsPurchaseAccounts = async (items, accounts, companyScope, apply) => {
  const filter = goodsPurchaseFilter(companyScope);
  const needs = await items.countDocuments(filter);
  if (!needs) return { written: 0, skipped: null, needs: 0 };

  const cogsAccount = await accounts.findOne({ ...companyScope, systemAccountKey: 'COST_OF_GOODS_SOLD' });
  if (!cogsAccount) return { written: 0, skipped: 'COST_OF_GOODS_SOLD', needs };

  if (!apply) return { written: 0, skipped: null, needs };

  const result = await items.updateMany(filter, { $set: { 'purchaseInformation.purchaseAccountId': cogsAccount._id } });
  return { written: result.modifiedCount, skipped: null, needs: 0 };
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
    const accounts = db.books.collection('accounts');
    const companyMatch = targetCompanyId
      ? { _id: targetCompanyId }
      : excludedObjectIds.length
        ? { _id: { $nin: excludedObjectIds } }
        : {};
    const companies = await db.common.collection('companies').find(companyMatch).project({ name: 1 }).toArray();
    const companyNameById = new Map(companies.map(company => [String(company._id), company.name]));

    let salesWouldFill = 0;
    let inventoryWouldFill = 0;
    let purchaseWouldFill = 0;
    let salesFilled = 0;
    let inventoryFilled = 0;
    let purchaseFilled = 0;
    const blocked = [];

    for (const company of companies) {
      const companyScope = { companyId: company._id };
      const label = company.name || String(company._id);

      const sales = await fillSalesAccounts(items, accounts, companyScope, apply);
      if (sales.skipped) {
        blocked.push({ name: label, missing: sales.skipped, count: sales.needs });
      } else if (apply) {
        salesFilled += sales.written;
      } else {
        salesWouldFill += sales.needs;
      }

      const inventory = await fillInventoryAccounts(items, accounts, companyScope, db, apply);
      if (inventory.skipped) {
        blocked.push({ name: label, missing: inventory.skipped, count: inventory.needs });
      } else if (apply) {
        inventoryFilled += inventory.written;
      } else {
        inventoryWouldFill += inventory.needs;
      }

      const purchase = await fillGoodsPurchaseAccounts(items, accounts, companyScope, apply);
      if (purchase.skipped) {
        blocked.push({ name: label, missing: purchase.skipped, count: purchase.needs });
      } else if (apply) {
        purchaseFilled += purchase.written;
      } else {
        purchaseWouldFill += purchase.needs;
      }
    }

    if (apply) {
      console.log(`\n1 sales accounts set        : ${salesFilled}`);
      console.log(`2 inventory accounts set    : ${inventoryFilled}`);
      console.log(`3 goods purchase -> COGS   : ${purchaseFilled}`);
    } else {
      console.log(`\n1 sales accounts would set        : ${salesWouldFill}`);
      console.log(`2 inventory accounts would set    : ${inventoryWouldFill}`);
      console.log(`3 goods purchase -> COGS would set: ${purchaseWouldFill}`);
    }

    if (blocked.length) {
      console.log('\nBLOCKED — seed system accounts first (seedMissingSystemAccounts.js --apply)');
      blocked.forEach(row => console.log(`   ${row.name}: ${row.count} items need ${row.missing}`));
    }

    const salesListFilter = salesFilter(scope);
    const inventoryListFilter = await inventoryFilter(db, scope);
    const goodsPurchaseListFilter = goodsPurchaseFilter(scope);
    const servicePurchaseListFilter = servicePurchaseManualFilter(scope);

    const servicePurchaseManual = await items.countDocuments(servicePurchaseListFilter);
    if (servicePurchaseManual) {
      console.log(`\n4 service purchasable — manual expense account: ${servicePurchaseManual} (not auto-filled)`);
    }

    if (!apply) {
      if (salesWouldFill) {
        await logItemsNeedingAccount(
          items,
          salesListFilter,
          'ITEMS NEEDING SALES ACCOUNT (sellable, no salesAccountId)',
          'SALES system account',
        );
      }
      if (inventoryWouldFill) {
        await logItemsNeedingAccount(
          items,
          inventoryListFilter,
          'ITEMS NEEDING INVENTORY ACCOUNT (goods, trackInventory + stock, no inventoryAccountId)',
          'INVENTORY_ASSET system account',
        );
      }
      if (purchaseWouldFill) {
        await logItemsNeedingAccount(
          items,
          goodsPurchaseListFilter,
          'ITEMS NEEDING PURCHASE ACCOUNT (goods, isPurchasable, no purchaseAccountId)',
          'COST_OF_GOODS_SOLD system account',
        );
      }
      if (servicePurchaseManual) {
        await logItemsNeedingAccount(
          items,
          servicePurchaseListFilter,
          'SERVICE PURCHASABLE — set purchase account manually (expense)',
          'pick expense account in item master',
          0,
          companyNameById,
        );
      }
      console.log('\nNothing written. Re-run with --apply to backfill.');
    } else {
      const salesLeft = await items.countDocuments(salesListFilter);
      const inventoryLeft = await items.countDocuments(inventoryListFilter);
      const purchaseLeft = await items.countDocuments(goodsPurchaseListFilter);
      if (salesLeft) {
        await logItemsNeedingAccount(items, salesListFilter, 'STILL NEED SALES ACCOUNT', 'manual / seed SALES');
      }
      if (inventoryLeft) {
        await logItemsNeedingAccount(items, inventoryListFilter, 'STILL NEED INVENTORY ACCOUNT', 'manual / seed INVENTORY_ASSET');
      }
      if (purchaseLeft) {
        await logItemsNeedingAccount(
          items,
          goodsPurchaseListFilter,
          'STILL NEED PURCHASE ACCOUNT (goods, isPurchasable)',
          'manual / seed COST_OF_GOODS_SOLD',
        );
      }
      if (servicePurchaseManual) {
        await logItemsNeedingAccount(
          items,
          servicePurchaseListFilter,
          'SERVICE PURCHASABLE — still need purchase account',
          'manual expense account',
          0,
          companyNameById,
        );
      }
      if (!salesLeft && !inventoryLeft && !purchaseLeft && !servicePurchaseManual) {
        console.log('\nAll auto-fillable item accounts set.');
      }
    }
  } catch (error) {
    console.error('Account backfill failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
