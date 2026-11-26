/**
 * REPORT ONLY - writes nothing.
 *
 * Lists, per company, the BOM production orders whose finished-goods (FG) batches went into stock at a price set
 * by an older costing rule, and shows how, why and how much.
 *
 * How it happened: under the old rules the cost of rejected units was loaded onto the good units (rejected units
 * carried nothing), or returned raw material was charged to the rejected units. Today each rejected unit carries
 * what was really spent on it (written-off material + its labour/overhead share) and the good units the rest
 * (computeBomSubmissionCost). The FG batch keeps the price it was stored with, so it can differ from today's price.
 *
 * For every BOM submission that has rejected units and its own FG batch:
 *   - Old / New price  price stored on the FG batch / good-unit cost under today's rule
 *   - Gap              qty x (new - old); split into still in stock and already sold
 *   - Why              which old rule gave the old price:
 *                        "No cost on rejects" - total cost / good qty
 *                        "Equal share"        - total cost / (good + rejected) qty
 *                        "Item master"        - the FG item's cost price
 *                        "Other"              - none of the above (e.g. edited later)
 *   - Gap in           where the old price sits:
 *                        Batch       - the stock batch (stock value off for units still in stock)
 *                        Production  - the order's stored batch (its Cost Breakdown already shows the new price)
 *                        Accounting  - the production journal booked finished goods at the old price
 *                                      ("no journal" = order has no production journal)
 *
 * Usage:
 *   node migrations/findBomFinishedBatchPriceGap.js                    (all companies)
 *   node migrations/findBomFinishedBatchPriceGap.js --companyId=<id>   (one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const parseArgs = argv => {
  const hit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { companyId: companyArg ? new ObjectId(companyArg) : null };
};

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const roundQty = value => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
const batchCost = batches => (batches || []).reduce((sum, batch) => sum + (batch.quantity || 0) * (batch.purchasePrice || 0), 0);
const batchQty = batches => (batches || []).reduce((sum, batch) => sum + (batch.quantity || 0), 0);
const isSamePrice = (price, candidate) => Math.abs(price - round2(candidate)) < 0.01;

// Same formula as productionOrder.service computeBomSubmissionCost (kept local so the report only needs
// getConnection - requiring the service boots Redis and the model layer).
const computeBomSubmissionCost = submission => {
  const goodQty = roundQty(submission.fgSubmittedQty || 0);
  const rejectedQty = roundQty(submission.fgRejectedQty || 0);
  const handledQty = roundQty(goodQty + rejectedQty);

  let materialCost = 0;
  let rejectedMaterialCost = 0;
  for (const rawMaterial of submission.rawMaterialsConsumed || []) {
    const cost = batchCost(rawMaterial.batches);
    const qty = batchQty(rawMaterial.batches);
    const writtenOffCost = qty > 0 ? round2((cost / qty) * (rawMaterial.rejectQty || 0)) : 0;
    materialCost += cost;
    rejectedMaterialCost += writtenOffCost;
  }

  const labourCost = (submission.manpowerCost || []).reduce((sum, worker) => sum + (worker.workerCost || 0), 0);
  const overheadCost = (submission.additionalCost || []).reduce((sum, cost) => sum + (cost.amount || 0), 0);
  const rejectedLabourCost = handledQty > 0 ? round2((labourCost / handledQty) * rejectedQty) : 0;
  const rejectedOverheadCost = handledQty > 0 ? round2((overheadCost / handledQty) * rejectedQty) : 0;

  const totalCost = materialCost + labourCost + overheadCost;
  const rejectedCost = round2(rejectedMaterialCost + rejectedLabourCost + rejectedOverheadCost);
  const goodUnitCost = goodQty > 0 ? (totalCost - rejectedCost) / goodQty : 0;

  return { goodQty, rejectedQty, handledQty, totalCost, goodUnitCost };
};

// Which old rule produced the stored price.
const findWhy = (oldPrice, submissionCost, itemCostPrice) => {
  if (submissionCost.goodQty > 0 && isSamePrice(oldPrice, submissionCost.totalCost / submissionCost.goodQty)) {
    return 'No cost on rejects';
  }
  if (submissionCost.handledQty > 0 && isSamePrice(oldPrice, submissionCost.totalCost / submissionCost.handledQty)) {
    return 'Equal share';
  }
  if (itemCostPrice && isSamePrice(oldPrice, itemCostPrice)) return 'Item master';
  return 'Other';
};

const run = async () => {
  let client;
  try {
    const { companyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;

    const orders = await db.books
      .collection('productionorders')
      .find({
        productionManageMethod: { $ne: 'PROCESS_ROUTE' },
        submissionHistory: { $elemMatch: { fgRejectedQty: { $gt: 0 } } },
        ...(companyId ? { companyId } : {}),
      })
      .project({ companyId: 1, productionOrderCode: 1, itemId: 1, batches: 1, submissionHistory: 1 })
      .toArray();

    // Step 1: every FG batch whose stored price differs from today's price
    const rows = [];
    for (const order of orders) {
      for (const [submissionIndex, submission] of (order.submissionHistory || []).entries()) {
        if (!(submission.fgRejectedQty > 0)) continue;
        const batchUse = submission.batches?.[0];
        if (!batchUse?.itemBatchId) continue;

        const submissionCost = computeBomSubmissionCost(submission);
        const todayPrice = round2(submissionCost.goodUnitCost);
        if (!todayPrice || Math.abs(todayPrice - batchUse.purchasePrice) < 0.01) continue;

        rows.push({ order, submissionNo: submissionIndex + 1, submissionCost, batchUse, todayPrice });
      }
    }

    // Step 2: the stock batches, the FG items' master price and the production journals - one query each
    const itemBatches = await db.booksCrm
      .collection('itembatches')
      .find({ _id: { $in: rows.map(row => row.batchUse.itemBatchId) } })
      .project({ remainingQty: 1, purchasePrice: 1 })
      .toArray();
    const batchById = new Map(itemBatches.map(batch => [String(batch._id), batch]));
    const items = await db.booksCrm
      .collection('items')
      .find({ _id: { $in: [...new Set(rows.map(row => String(row.order.itemId)))].map(id => new ObjectId(id)) } })
      .project({ 'purchaseInformation.costPrice': 1 })
      .toArray();
    const itemById = new Map(items.map(item => [String(item._id), item]));
    const fgEntries = await db.books
      .collection('ledgerentries')
      .find({
        sourceModule: 'PRODUCTION',
        sourceId: { $in: rows.map(row => row.order._id) },
        narration: 'Finished goods capitalized',
      })
      .project({ sourceId: 1, debit: 1 })
      .toArray();
    const fgDebitByOrder = new Map();
    for (const entry of fgEntries) {
      fgDebitByOrder.set(String(entry.sourceId), (fgDebitByOrder.get(String(entry.sourceId)) || 0) + entry.debit);
    }

    // Step 3: one report line per FG batch
    const report = rows.map(({ order, submissionNo, submissionCost, batchUse, todayPrice }) => {
      const batch = batchById.get(String(batchUse.itemBatchId));
      const priceGap = todayPrice - batchUse.purchasePrice;
      const inStockQty = roundQty(batch ? batch.remainingQty : 0);
      const fgDebit = fgDebitByOrder.get(String(order._id));
      const gapIn = ['Production'];
      if (batch && Math.abs(batch.purchasePrice - batchUse.purchasePrice) < 0.01) gapIn.unshift('Batch');
      if (fgDebit === undefined) gapIn.push('no journal');
      else if (Math.abs(fgDebit - batchCost(order.batches)) <= batchQty(order.batches) * 0.005 + 0.05) gapIn.push('Accounting');
      return {
        companyId: String(order.companyId),
        Order: `${order.productionOrderCode} S${submissionNo}`,
        Qty: batchUse.quantity,
        'In stock': inStockQty,
        'Old price': round2(batchUse.purchasePrice),
        'New price': todayPrice,
        Gap: round2(batchUse.quantity * priceGap),
        gapInStock: round2(inStockQty * priceGap),
        Why: findWhy(batchUse.purchasePrice, submissionCost, itemById.get(String(order.itemId))?.purchaseInformation?.costPrice),
        'Gap in': gapIn.join(' + '),
      };
    });

    console.log(`\nREPORT ONLY - nothing is written. BOM orders with rejects checked: ${orders.length}`);
    console.log(
      'Gap = qty x (new price - old price).  Gap in: Batch = stock batch, Production = order record, Accounting = production journal\n',
    );

    if (!report.length) {
      console.log('No mismatch found.\n');
      return;
    }

    const companyIds = [...new Set(report.map(line => line.companyId))];
    const companies = await db.common
      .collection('companies')
      .find({ _id: { $in: companyIds.map(id => new ObjectId(id)) } })
      .project({ name: 1 })
      .toArray();
    const companyName = new Map(companies.map(company => [String(company._id), company.name]));

    console.table(
      companyIds.map(reportCompanyId => {
        const lines = report.filter(line => line.companyId === reportCompanyId);
        const gap = round2(lines.reduce((sum, line) => sum + line.Gap, 0));
        const gapInStock = round2(lines.reduce((sum, line) => sum + line.gapInStock, 0));
        return {
          Company: companyName.get(reportCompanyId) || '-',
          'Company ID': reportCompanyId,
          Batches: lines.length,
          Gap: gap,
          'In stock': gapInStock,
          Sold: round2(gap - gapInStock),
        };
      }),
    );

    for (const reportCompanyId of companyIds) {
      console.log(`\n${companyName.get(reportCompanyId) || '-'} (${reportCompanyId})`);
      console.table(
        report
          .filter(line => line.companyId === reportCompanyId)
          .map(({ companyId: lineCompanyId, gapInStock, ...line }) => line),
      );
    }
    console.log('');
  } finally {
    if (client) await client.close();
  }
};

/*
 * Parked: re-pricing unsold batches (--apply). Kept for reference; the script is report-only for now.
 *
 *   For an order whose old-rate batches are all unsold, inside one transaction:
 *     ItemBatch.updateOne({ _id: itemBatchId }, { $set: { purchasePrice: todayPrice } })
 *     set the same price on the order's submission.batches[0] and order.batches copy, save the order
 *     postBomBasedProductionLedger(orderDoc, orderDoc.companyId, orderDoc.createdBy, session)
 *   then run `node migrations/verifyItemValuation.js --apply` so item stock value follows the new prices.
 *   Needs the mongoose model layer booted (getModelsAndConnections + modelService.setApp) for the journal.
 */

run()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
