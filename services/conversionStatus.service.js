const mongoose = require('mongoose');
const { getBooksModels, getBooksCrmModels } = require('./model.service');
const { roundQty, resolveUnitConversion } = require('./warehouseBatch.service');
const {
  PO_STATUSES,
  GRPO_STATUSES,
  BILL_STATUSES,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  INVOICE_STATUS,
} = require('../utils/enum');

const QTY_EPSILON = 0.001;

const toObjectId = value => (value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(value));

const itemKeyOf = value => value?._id?.toString?.() || value?.toString?.();

// Line quantities are entered in a unit (itemUnitId) that may differ between an order and the documents
// converted from it, so fulfilment is always compared in the item's main unit. Read-time maths must not
// throw on legacy rows: an unknown item/unit falls back to factor 1.
const loadUnitItemMap = async (itemIds, session = null) => {
  const ids = [...new Set((itemIds || []).map(itemKeyOf).filter(Boolean))];
  if (!ids.length) return new Map();
  const { Item } = getBooksCrmModels();
  const items = await Item.find({ _id: { $in: ids } })
    .select('itemName itemUnitId unitConversions')
    .session(session || null)
    .lean();
  return new Map(items.map(item => [String(item._id), item]));
};

const getUnitFactor = (unitItemMap, itemId, unitId) => {
  const item = unitItemMap?.get(itemKeyOf(itemId));
  if (!item || !unitId) return 1;
  try {
    const factor = resolveUnitConversion(item, itemKeyOf(unitId));
    return factor > 0 ? factor : 1;
  } catch (error) {
    return 1;
  }
};

// Aggregation rows grouped by { itemId, itemUnitId } -> Map(itemId -> quantity in the main unit).
const sumConvertedToMainUnit = (rows, unitItemMap, field = 'qty') => {
  const map = new Map();
  for (const row of rows || []) {
    const key = itemKeyOf(row._id?.itemId);
    if (!key) continue;
    const base = (row[field] || 0) * getUnitFactor(unitItemMap, key, row._id?.itemUnitId);
    map.set(key, roundQty((map.get(key) || 0) + base));
  }
  return map;
};

const orderedQtyByItem = (items, unitItemMap = null) => {
  const map = new Map();
  for (const item of items || []) {
    const key = itemKeyOf(item.itemId);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + (item.quantity || 0) * getUnitFactor(unitItemMap, key, item.itemUnitId));
  }
  return map;
};

// Sum non-cancelled child (GRPO/Bill/DeliveryChallan/Invoice) quantities per itemId, in the main unit, that
// reference the given parent order. Mirrors the read-time aggregation in
// purchaseOrder.service.js / salesOrder.service.js so status and displayed remaining agree.
const convertedQtyByItem = async (Model, parentField, parentId, cancelledStatus, session, unitItemMap = null) => {
  const rows = await Model.aggregate([
    {
      $match: {
        [`${parentField}.${parentField === 'purchaseOrders' ? 'purchaseOrderId' : 'salesOrderId'}`]: parentId,
        'items.referenceId': parentId,
        status: { $ne: cancelledStatus },
      },
    },
    { $unwind: '$items' },
    { $match: { 'items.referenceId': parentId } },
    { $group: { _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' }, qty: { $sum: '$items.quantity' } } },
  ]).session(session);

  return sumConvertedToMainUnit(rows, unitItemMap);
};

// The conversion-derived status. `none` when nothing is converted, `full` when every item is
// fully covered, `partial` otherwise. These three statuses are always automatic (the only manual
// completion is CLOSED, which callers guard separately), so this tracks documents both ways -
// a status goes back down to `none`/`partial` when documents are deleted or cancelled.
const resolveStatus = (orderedMap, convertedMap, { none, partial, full }) => {
  let totalConverted = 0;
  let allCovered = true;
  for (const [itemId, ordered] of orderedMap) {
    const converted = convertedMap.get(itemId) || 0;
    totalConverted += converted;
    if (converted < ordered - QTY_EPSILON) allCovered = false;
  }
  if (totalConverted <= QTY_EPSILON) return none;
  return allCovered ? full : partial;
};

// Recompute and persist a Purchase Order's status from the authoritative non-cancelled
// GRPO + Bill quantities. Call AFTER the triggering child change is applied in `session`.
const recomputePurchaseOrderStatus = async (purchaseOrderId, session) => {
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();
  const poId = toObjectId(purchaseOrderId);
  const po = await PurchaseOrder.findById(poId).session(session);
  // CLOSED is a manual "close" the user set deliberately (a partially-recorded PO they chose to
  // stop). CANCELLED is terminal. Neither is conversion-derived, so leave them untouched.
  if (!po || po.status === PO_STATUSES.CANCELLED || po.status === PO_STATUSES.CLOSED) {
    return po ? po.status : null;
  }

  const unitItemMap = await loadUnitItemMap(
    po.items.map(item => item.itemId),
    session,
  );
  const orderedMap = orderedQtyByItem(po.items, unitItemMap);
  const [grpoMap, billMap] = await Promise.all([
    convertedQtyByItem(GrpoOrder, 'purchaseOrders', poId, GRPO_STATUSES.CANCELLED, session, unitItemMap),
    convertedQtyByItem(Bill, 'purchaseOrders', poId, BILL_STATUSES.CANCELLED, session, unitItemMap),
  ]);
  const convertedMap = new Map();
  for (const map of [grpoMap, billMap]) {
    for (const [itemId, qty] of map) convertedMap.set(itemId, (convertedMap.get(itemId) || 0) + qty);
  }

  const newStatus = resolveStatus(orderedMap, convertedMap, {
    none: PO_STATUSES.ACCEPTED,
    partial: PO_STATUSES.PARTIALLY_RECORDED,
    full: PO_STATUSES.CONVERTED,
  });

  if (newStatus !== po.status) {
    await PurchaseOrder.updateOne({ _id: poId }, { $set: { status: newStatus } }).session(session);
  }
  return newStatus;
};

// Recompute and persist a Sales Order's status from the authoritative non-cancelled
// Delivery Challan + Invoice quantities. Call AFTER the triggering child change is applied.
// The conversion-derived status for a Sales Order (OPEN / PARTIALLY_RECORDED / COMPLETED), computed
// from current non-cancelled Delivery Challan + Invoice quantities. Ignores any manual CLOSED/CANCELLED
// override — used both by the auto recompute (guarded below) and by the "revert close" flow.
const computeSalesOrderConversionStatus = async (so, session) => {
  const { DeliveryChallan, Invoice } = getBooksModels();
  const soId = toObjectId(so._id);
  const unitItemMap = await loadUnitItemMap(
    so.items.map(item => item.itemId),
    session,
  );
  const orderedMap = orderedQtyByItem(so.items, unitItemMap);
  const [dcMap, invoiceMap] = await Promise.all([
    convertedQtyByItem(DeliveryChallan, 'salesOrders', soId, DELIVERY_CHALLAN_STATUS.CANCELLED, session, unitItemMap),
    convertedQtyByItem(Invoice, 'salesOrders', soId, INVOICE_STATUS.CANCELLED, session, unitItemMap),
  ]);
  const convertedMap = new Map();
  for (const map of [dcMap, invoiceMap]) {
    for (const [itemId, qty] of map) convertedMap.set(itemId, (convertedMap.get(itemId) || 0) + qty);
  }
  return resolveStatus(orderedMap, convertedMap, {
    none: SALES_ORDER_STATUS.OPEN,
    partial: SALES_ORDER_STATUS.PARTIALLY_RECORDED,
    full: SALES_ORDER_STATUS.COMPLETED,
  });
};

const recomputeSalesOrderStatus = async (salesOrderId, session) => {
  const { SalesOrder } = getBooksCrmModels();
  const soId = toObjectId(salesOrderId);
  const so = await SalesOrder.findById(soId).session(session);
  // CLOSED is a manual "close" the user set deliberately. CANCELLED is terminal. Neither is
  // conversion-derived, so leave them untouched.
  if (!so || so.status === SALES_ORDER_STATUS.CANCELLED || so.status === SALES_ORDER_STATUS.CLOSED) {
    return so ? so.status : null;
  }

  const newStatus = await computeSalesOrderConversionStatus(so, session);

  if (newStatus !== so.status) {
    await SalesOrder.updateOne({ _id: soId }, { $set: { status: newStatus } }).session(session);
  }
  return newStatus;
};

// Distribute an item-level converted total across the parent order's line items (in order),
// so duplicate lines of the same item don't each subtract the full item total. `convertedByItemId` holds
// main-unit quantities: each line is compared in the main unit, and its remaining/excess come back in the
// line's own unit. Returns the line's remaining (clamped at 0) and any excess landing on the last line of that item.
const distributeRemainingAcrossLines = (items, convertedByItemId, unitItemMap = null) => {
  const pools = new Map(convertedByItemId);
  const lastLineIndexByItem = new Map();
  (items || []).forEach((item, index) => {
    const key = itemKeyOf(item.itemId);
    if (key) lastLineIndexByItem.set(key, index);
  });

  return (items || []).map((item, index) => {
    const key = itemKeyOf(item.itemId);
    const factor = getUnitFactor(unitItemMap, key, item.itemUnitId);
    const ordered = (item.quantity || 0) * factor;
    const pool = key ? pools.get(key) || 0 : 0;
    const consumed = Math.min(ordered, pool);
    const remainingPool = pool - consumed;
    if (key) pools.set(key, remainingPool);

    const remainingQty = roundQty(Math.max(0, ordered - consumed) / factor);
    // Excess (converted beyond ordered) is attributed to the item's final line only.
    const excessQty = key && lastLineIndexByItem.get(key) === index ? roundQty(Math.max(0, remainingPool) / factor) : 0;
    return { ...item, remainingQty, excessQty };
  });
};

// What each sales-order line still has to put into production. A production order holds its planned
// quantity against its sales-order item whatever its status, until the production order is deleted.
const getPendingProductionByLine = async (salesOrders, session) => {
  const { ProductionOrder } = getBooksModels();
  const planned = await ProductionOrder.aggregate([
    { $match: { salesOrderId: { $in: salesOrders.map(order => order._id) } } },
    {
      $group: {
        _id: { salesOrderId: '$salesOrderId', itemId: '$itemId', itemUnitId: '$itemUnitId' },
        quantity: { $sum: '$quantity' },
      },
    },
  ]).session(session);

  const unitItemMap = await loadUnitItemMap(
    [...salesOrders.flatMap(order => (order.items || []).map(item => item.itemId)), ...planned.map(row => row._id.itemId)],
    session,
  );

  const plannedBySalesOrder = new Map();
  for (const row of planned) {
    const salesOrderKey = row._id.salesOrderId.toString();
    if (!plannedBySalesOrder.has(salesOrderKey)) plannedBySalesOrder.set(salesOrderKey, []);
    plannedBySalesOrder.get(salesOrderKey).push({
      _id: { itemId: row._id.itemId, itemUnitId: row._id.itemUnitId },
      quantity: row.quantity,
    });
  }

  return new Map(
    salesOrders.map(order => [
      order._id.toString(),
      distributeRemainingAcrossLines(
        order.items,
        sumConvertedToMainUnit(plannedBySalesOrder.get(order._id.toString()), unitItemMap, 'quantity'),
        unitItemMap,
      ).map(line => roundQty(line.remainingQty)),
    ]),
  );
};

module.exports = {
  recomputePurchaseOrderStatus,
  recomputeSalesOrderStatus,
  computeSalesOrderConversionStatus,
  distributeRemainingAcrossLines,
  getPendingProductionByLine,
  loadUnitItemMap,
  getUnitFactor,
  sumConvertedToMainUnit,
};
