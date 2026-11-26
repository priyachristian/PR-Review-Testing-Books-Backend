/**
 * Fills the item prices that defaultPrice has been standing in for.
 *
 * A sellable item needs its own selling price and a purchasable item needs its own cost
 * price. Only missing values are written.
 *
 * Cost-price candidates are discovered broadly (isPurchasable OR tracked-inventory, so a
 * tracked item missing cost still shows up for visibility), but the write itself is gated
 * a second time on `purchaseInformation.isPurchasable === true` — trackInventory alone must
 * never cause a cost price to be written on an item that isn't actually purchasable.
 * Selling price is gated the same way on `salesInformation.isSellable === true`.
 *
 *   selling price  <- defaultPrice
 *   cost price     <- the newest batch bought on a BILL/GRPO/SPLIT_BILL, else defaultPrice
 *
 * Batch cost is preferred because it is the price really paid on a purchase document.
 * Batches from non-purchase sources (production output, opening stock, manual stock add,
 * adjustments, returns, transfers, the EXISTING_INVENTORY migration seed) are excluded —
 * per AS 2 / Ind AS 2, cost price must reflect actual cost of purchase, and defaultPrice
 * is usually a selling price and would overstate stock value.
 *
 * Reports by default and writes only with --apply. Idempotent: an item that already has a
 * price is skipped, so it can be re-run safely.
 *
 * Run: node migrations/backfillItemPricing.js                      (report, all companies)
 *      node migrations/backfillItemPricing.js <companyId>           (report, one company)
 *      node migrations/backfillItemPricing.js <companyId> --apply   (write)
 *
 * Items still without a price afterwards need one entered by hand; list them with
 * node migrations/reportItemPricing.js <companyId> --list
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

// A price counts as missing when it is absent, null, empty or zero.
const missingPrice = field => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }, { [field]: 0 }] });

// Tracked either by the new flag or, before that migration runs, by the old one.
const TRACKED = {
  $or: [{ trackInventory: true }, { trackInventory: { $exists: false }, 'itemClassification.inventoryItem': true }],
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

    console.log(`\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(`Cluster: ${(process.env.ABSS_CLUSTER || '').replace(/\/\/.*@/, '//***@').split('/?')[0]}`);
    console.log(apply ? 'Mode: APPLYING CHANGES\n' : 'Mode: report only — pass --apply to write\n');
    if (!targetCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}\n`);
    }

    const items = db.booksCrm.collection('items');

    // --- selling price for sellable items ---
    const needsSellingPrice = await items
      .find({ ...scope, 'salesInformation.isSellable': true, ...missingPrice('salesInformation.sellingPrice') })
      .project({ itemNo: 1, itemName: 1, defaultPrice: 1, 'salesInformation.isSellable': 1 })
      .toArray();

    // Gated again on isSellable, in addition to the query filter above — a selling price
    // must never be written for an item that isn't actually flagged sellable.
    const sellingToFill = needsSellingPrice.filter(
      item => item.salesInformation?.isSellable === true && Number(item.defaultPrice) > 0,
    );

    // --- cost price for purchasable or tracked items ---
    const needsCostPrice = await items
      .find({
        ...scope,
        $and: [{ $or: [{ 'purchaseInformation.isPurchasable': true }, TRACKED] }, missingPrice('purchaseInformation.costPrice')],
      })
      .project({ itemNo: 1, itemName: 1, defaultPrice: 1, 'purchaseInformation.isPurchasable': 1 })
      .toArray();

    // Newest batch price per item — the cost actually paid on a purchase document.
    // Restricted to purchase sourceTypes: other batch sources (production output, opening
    // stock, manual add, adjustments, returns, transfers, the EXISTING_INVENTORY migration
    // seed) don't represent a real purchase cost and must not be reported as one.
    const PURCHASE_SOURCE_TYPES = ['BILL', 'GRPO', 'SPLIT_BILL'];
    const batchCostByItemId = new Map();
    if (needsCostPrice.length) {
      const batches = await db.booksCrm
        .collection('itembatches')
        .find({
          ...scope,
          itemId: { $in: needsCostPrice.map(item => item._id) },
          purchasePrice: { $gt: 0 },
          sourceType: { $in: PURCHASE_SOURCE_TYPES },
        })
        .project({ itemId: 1, purchasePrice: 1, createdAt: 1 })
        .sort({ createdAt: 1 })
        .toArray();
      // Sorted oldest first, so the last write per item leaves the newest price.
      batches.forEach(batch => batchCostByItemId.set(batch.itemId?.toString(), batch.purchasePrice));
    }

    // Gated again on isPurchasable — a tracked-inventory item that isn't purchasable is a
    // valid discovery-query match (for visibility) but must never get a cost price written.
    const purchasableCandidates = needsCostPrice.filter(item => item.purchaseInformation?.isPurchasable === true);
    const trackedNotPurchasable = needsCostPrice.length - purchasableCandidates.length;

    const costToFill = purchasableCandidates
      .map(item => {
        const batchCost = batchCostByItemId.get(item._id.toString());
        const cost = batchCost || (Number(item.defaultPrice) > 0 ? item.defaultPrice : null);
        return cost ? { ...item, cost, source: batchCost ? 'batch' : 'defaultPrice' } : null;
      })
      .filter(Boolean);

    console.log('SELLING PRICE');
    console.log(`   sellable items missing a price : ${needsSellingPrice.length}`);
    console.log(`   fillable from defaultPrice      : ${sellingToFill.length}`);
    console.log(`   left for manual pricing         : ${needsSellingPrice.length - sellingToFill.length}`);

    console.log('\nCOST PRICE');
    console.log(`   purchasable/tracked missing cost: ${needsCostPrice.length}`);
    console.log(`   skipped — tracked, not purchasable: ${trackedNotPurchasable} (no cost price written)`);
    console.log(`   fillable from batch cost        : ${costToFill.filter(item => item.source === 'batch').length}`);
    console.log(`   fillable from defaultPrice      : ${costToFill.filter(item => item.source === 'defaultPrice').length}`);
    console.log(`   left for manual pricing         : ${purchasableCandidates.length - costToFill.length}`);

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    let sellingWritten = 0;
    for (const item of sellingToFill) {
      const result = await items.updateOne({ _id: item._id }, { $set: { 'salesInformation.sellingPrice': item.defaultPrice } });
      sellingWritten += result.modifiedCount;
    }

    let costWritten = 0;
    for (const item of costToFill) {
      const result = await items.updateOne({ _id: item._id }, { $set: { 'purchaseInformation.costPrice': item.cost } });
      costWritten += result.modifiedCount;
    }

    console.log('\nWRITTEN');
    console.log(`   selling prices filled : ${sellingWritten}`);
    console.log(`   cost prices filled    : ${costWritten}`);

    const sellingLeft = await items.countDocuments({
      ...scope,
      'salesInformation.isSellable': true,
      ...missingPrice('salesInformation.sellingPrice'),
    });
    const costLeft = await items.countDocuments({
      ...scope,
      $and: [{ $or: [{ 'purchaseInformation.isPurchasable': true }, TRACKED] }, missingPrice('purchaseInformation.costPrice')],
    });

    console.log(`\n   still missing a selling price : ${sellingLeft}`);
    console.log(`   still missing a cost price    : ${costLeft}`);
    console.log('\nBackfill completed. Remaining items need a price entered by hand.\n');
  } catch (error) {
    console.error('Backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
