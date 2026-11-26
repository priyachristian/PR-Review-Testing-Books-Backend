const { getBooksModels, getBooksCrmModels } = require('./model.service');
const { roundQty } = require('./warehouseBatch.service');
const {
  summarizeProcessRouteCost,
  computeBomBasedCostToDate,
} = require('../modules/production/addProduction/productionOrder.service');

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const sumBatches = (batches = []) => {
  let qty = 0;
  let cost = 0;
  for (const batch of batches) {
    const bQty = Number(batch?.quantity) || 0;
    qty += bQty;
    cost += bQty * (Number(batch?.purchasePrice) || 0);
  }
  return { qty, cost };
};

const collectRawMaterialItemIds = (order, method, itemIds) => {
  if (method === 'PROCESS_ROUTE') {
    for (const process of order.processBased?.processes || []) {
      for (const input of process.processRawMaterialInput || []) if (input.item) itemIds.add(String(input.item));
    }
  } else {
    for (const rm of order.rawMaterials || []) if (rm.rawMaterialId) itemIds.add(String(rm.rawMaterialId));
  }
};

const getProductionCostBreakdown = async ({ companyId, productionOrderId }) => {
  if (!companyId || !productionOrderId) return { hasData: false };

  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();

  const order = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).lean();
  if (!order) return { hasData: false };

  const method = order.productionManageMethod || null;
  const isProcessRoute = method === 'PROCESS_ROUTE';

  // The same cost figures the journal posts, so the screen and the books cannot drift apart.
  const costSummary = isProcessRoute ? summarizeProcessRouteCost(order) : computeBomBasedCostToDate(order);

  const itemIds = new Set();
  if (order.itemId) itemIds.add(String(order.itemId));
  collectRawMaterialItemIds(order, method, itemIds);

  const itemDocs = itemIds.size
    ? await Item.find({ _id: { $in: [...itemIds] } })
        .select('itemName itemNo itemUnit')
        .lean()
    : [];
  const itemMap = new Map(itemDocs.map(doc => [String(doc._id), doc]));
  const itemInfo = id => itemMap.get(String(id)) || {};

  const rmMap = new Map();
  const accumulate = (itemId, batches) => {
    const { qty, cost } = sumBatches(batches);
    if (qty === 0 && cost === 0) return;
    const key = String(itemId || 'unknown');
    if (!rmMap.has(key)) {
      const info = itemInfo(itemId);
      rmMap.set(key, { itemName: info.itemName || null, itemNo: info.itemNo || null, qty: 0, cost: 0 });
    }
    const entry = rmMap.get(key);
    entry.qty += qty;
    entry.cost += cost;
  };

  let scrapRecovered = 0;
  if (isProcessRoute) {
    for (const process of order.processBased?.processes || []) {
      for (const submission of process.submissionHistory || []) {
        for (const input of submission.processRawMaterialInput || []) accumulate(input.item, input.batches);
        for (const scrap of submission.scrapOutProcess || []) scrapRecovered += sumBatches(scrap.batches).cost;
      }
    }
  } else {
    for (const rm of order.rawMaterials || []) accumulate(rm.rawMaterialId, rm.batches);
  }

  // Each item is rounded once and the total is the sum of the rounded items - the same way the journal credits them.
  const rawMaterialItems = [...rmMap.values()].map(item => ({ ...item, qty: roundQty(item.qty), cost: round2(item.cost) }));
  const rawMaterialTotal = round2(rawMaterialItems.reduce((sum, item) => sum + item.cost, 0));
  const labour = round2(costSummary.labourCost);
  const overhead = round2(costSummary.overheadCost);
  scrapRecovered = round2(scrapRecovered);

  // Scrap is recognised as recovered stock value, not deducted from production cost.
  const totalCost = round2(rawMaterialTotal + labour + overhead);

  // Each FG batch is stored on the submission that made it (BOM: the order's submissions, process
  // route: the last process's), so the batch can say which submission it came from.
  const processList = order.processBased?.processes || [];
  const finishingSubmissions = isProcessRoute
    ? processList[processList.length - 1]?.submissionHistory || []
    : order.submissionHistory || [];
  const batches = (order.batches || []).map(batch => ({
    itemBatchId: batch?.itemBatchId,
    batchNo: batch?.batchNo ?? null,
    quantity: roundQty(batch?.quantity || 0),
    purchasePrice: round2(batch?.purchasePrice),
    submissionNo:
      finishingSubmissions.findIndex(sub => (sub.batches || []).some(b => String(b.itemBatchId) === String(batch.itemBatchId))) +
        1 || null,
  }));
  const outputQty = roundQty(batches.reduce((sum, batch) => sum + (Number(batch.quantity) || 0), 0));

  // Older orders were saved without these totals.
  const producedQty = roundQty(order.totalFgSubmittedQty || 0);
  const finishedCost = round2(costSummary.finishedGoodsCost);
  const unitCost = producedQty > 0 ? round2(finishedCost / producedQty) : 0;
  // Stock value from the stored batch figures, not the rounded ones shown above.
  const recordedTotal = round2(
    (order.batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0), 0),
  );

  // Where the total production cost went - the same split the journal books: finished goods,
  // production loss, and the rest still in progress (work in progress). Units not yet started at the
  // first step carry no cost.
  const rejectedQty = roundQty(order.totalFgRejectedQty || 0);
  const rejectedCost = round2(costSummary.productionLoss);

  // What the rejected cost was spent on; each part is already rounded at the source, so the rows add up exactly.
  const rejectedSplit = costSummary.rejectedCostSplit;
  const rejectedItems = rejectedSplit.materials.map(material => {
    const info = itemInfo(material.itemId);
    return {
      itemName: info.itemName || null,
      itemNo: info.itemNo || null,
      writtenOffQty: material.writtenOffQty,
      returnedQty: material.returnedQty,
      cost: round2(material.cost),
    };
  });
  const rejectedDetails = {
    items: rejectedItems,
    labour: round2(rejectedSplit.labourCost),
    overhead: round2(rejectedSplit.overheadCost),
  };

  const unitsLeft = process => roundQty((process.processIN || 0) - (process.processOUT || 0) - (process.processRejection || 0));
  const inProgressQty = roundQty(processList.slice(1).reduce((sum, process) => sum + unitsLeft(process), 0));
  const leftoverCost = round2(totalCost - finishedCost - rejectedCost);
  const costSplit = {
    finished: { qty: producedQty, cost: finishedCost },
    rejected: { qty: rejectedQty, cost: rejectedCost, details: rejectedDetails },
    inProgress: { qty: inProgressQty, cost: inProgressQty > 0 ? leftoverCost : 0 },
    notStarted: {
      qty: isProcessRoute ? unitsLeft(processList[0] || {}) : roundQty(order.quantity - producedQty - rejectedQty),
      cost: 0,
    },
  };

  const outputItem = itemInfo(order.itemId);

  return {
    hasData: batches.length > 0 || totalCost > 0,
    method,
    outputItem: {
      itemName: outputItem.itemName || null,
      itemNo: outputItem.itemNo || null,
      itemUnit: outputItem.itemUnit || null,
    },
    outputQty,
    rawMaterials: { total: rawMaterialTotal, items: rawMaterialItems },
    labour: { total: labour },
    overhead: { total: overhead },
    scrapRecovered: isProcessRoute ? { total: scrapRecovered } : null,
    returnedMaterial: isProcessRoute
      ? null
      : { total: round2(rejectedSplit.materials.reduce((sum, material) => sum + material.returnedValue, 0)) },
    totalCost,
    unitCost,
    recorded: { total: recordedTotal, unit: outputQty > 0 ? round2(recordedTotal / outputQty) : 0 },
    costSplit,
    batches,
  };
};

module.exports = { getProductionCostBreakdown };
