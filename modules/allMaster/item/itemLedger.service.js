const httpStatus = require('http-status');
const mongoose = require('mongoose');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { SOURCE_DOCUMENTS } = require('../../../utils/enum');

const { ObjectId } = mongoose.Types;

const toObjectIds = value =>
  value
    .split(',')
    .filter(Boolean)
    .map(id => new ObjectId(id));

const itemLedger = async (filter, options) => {
  const { ItemBatch, Warehouse, Branch, Division, Customer } = getBooksCrmModels();
  const booksModels = getBooksModels();
  const booksCrmModels = getBooksCrmModels();

  if (!filter.itemId || !mongoose.Types.ObjectId.isValid(filter.itemId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid itemId provided');
  }

  const batchMatch = { itemId: new ObjectId(filter.itemId), companyId: new ObjectId(filter.companyId) };
  if (filter.warehouseId) {
    const ids = toObjectIds(filter.warehouseId);
    if (ids.length) batchMatch.warehouseId = { $in: ids };
  }
  if (filter.branchId) {
    const ids = toObjectIds(filter.branchId);
    if (ids.length) batchMatch.branchId = { $in: ids };
  }
  if (filter.divisionId) {
    const ids = toObjectIds(filter.divisionId);
    if (ids.length) batchMatch.divisionId = { $in: ids };
  }

  const batches = await ItemBatch.find(batchMatch).lean();

  let events = [];
  for (const batch of batches) {
    const cost = Number(batch.purchasePrice) || 0;
    events.push({
      effectType: 'IN',
      quantity: Number(batch.quantity) || 0,
      rate: cost,
      amount: (Number(batch.quantity) || 0) * cost,
      sellingPrice: null,
      sourceType: batch.sourceType,
      sourceId: batch.sourceId,
      warehouseId: batch.warehouseId,
      branchId: batch.branchId,
      divisionId: batch.divisionId,
      movementTime: batch.createdAt,
    });
    for (const deduction of batch.deductions || []) {
      const qty = Number(deduction.quantityDeducted) || 0;
      events.push({
        effectType: 'OUT',
        quantity: qty,
        rate: cost,
        amount: qty * cost,
        sellingPrice: deduction.sellingPrice != null ? Number(deduction.sellingPrice) : null,
        sourceType: deduction.deductedSourceType,
        sourceId: deduction.deductedSourceId,
        warehouseId: batch.warehouseId,
        branchId: batch.branchId,
        divisionId: batch.divisionId,
        movementTime: deduction.deductedAt,
      });
    }
  }

  const SPLIT_SOURCE_TYPES = new Set(Object.keys(SOURCE_DOCUMENTS).filter(key => key.startsWith('SPLIT_')));
  if (filter.isSplit == null) {
    events = events.filter(event => !SPLIT_SOURCE_TYPES.has(event.sourceType));
  }

  const idsByType = {};
  for (const event of events) {
    if (!event.sourceId || !SOURCE_DOCUMENTS[event.sourceType]?.modelKey) continue;
    (idsByType[event.sourceType] = idsByType[event.sourceType] || new Set()).add(String(event.sourceId));
  }

  const docMap = new Map();
  await Promise.all(
    Object.entries(idsByType).map(async ([sourceType, idSet]) => {
      const ids = [...idSet].map(id => new ObjectId(id));

      if (sourceType === 'PRODUCTIONORDER_STOCK_TRANSFER') {
        const transfers = await booksModels.InventoryTransferRequest.find({ _id: { $in: ids } })
          .select('productionOrderId transferId referenceNumber date createdAt')
          .lean();
        const productionOrderIds = transfers.map(transfer => transfer.productionOrderId).filter(Boolean);
        const productionOrders = productionOrderIds.length
          ? await booksModels.ProductionOrder.find({ _id: { $in: productionOrderIds } })
              .select('productionDate productionOrderCode')
              .lean()
          : [];
        const productionOrderMap = new Map(productionOrders.map(order => [String(order._id), order]));
        for (const transfer of transfers) {
          const order = transfer.productionOrderId ? productionOrderMap.get(String(transfer.productionOrderId)) : null;
          docMap.set(`${sourceType}:${String(transfer._id)}`, {
            documentDate: order?.productionDate || transfer.date || transfer.createdAt || null,
            documentNo: order?.productionOrderCode || transfer.transferId || transfer.referenceNumber || null,
            partyId: null,
            navType: order ? 'ProductionOrder' : null,
            navId: order ? transfer.productionOrderId : null,
          });
        }
        return;
      }

      const config = SOURCE_DOCUMENTS[sourceType];
      const Model = (config.db === 'booksCrm' ? booksCrmModels : booksModels)[config.modelKey];
      if (!Model) return;
      const selectFields = [config.dateField, config.noField, ...config.partyFields].join(' ');
      const docs = await Model.find({ _id: { $in: ids } })
        .select(selectFields)
        .lean();
      for (const doc of docs) {
        const partyId = config.partyFields.map(field => doc[field]).find(Boolean) || null;
        docMap.set(`${sourceType}:${String(doc._id)}`, {
          documentDate: doc[config.dateField] || null,
          documentNo: doc[config.noField] || null,
          partyId,
        });
      }
    }),
  );

  const warehouseIds = new Set();
  const branchIds = new Set();
  const divisionIds = new Set();
  const customerIds = new Set();

  for (const event of events) {
    const info = event.sourceId ? docMap.get(`${event.sourceType}:${String(event.sourceId)}`) : null;
    event.date = info?.documentDate || event.movementTime;
    event.refNo = info?.documentNo || null;
    event.partyId = info?.partyId || null;
    event.navType = info?.navType || null;
    event.navId = info?.navId || null;

    if (event.warehouseId) warehouseIds.add(String(event.warehouseId));
    if (event.branchId) branchIds.add(String(event.branchId));
    if (event.divisionId) divisionIds.add(String(event.divisionId));
    if (event.partyId) customerIds.add(String(event.partyId));
  }

  const [warehouses, branches, divisions, customers] = await Promise.all([
    Warehouse.find({ _id: { $in: [...warehouseIds].map(id => new ObjectId(id)) } })
      .select('name')
      .lean(),
    Branch.find({ _id: { $in: [...branchIds].map(id => new ObjectId(id)) } })
      .select('name')
      .lean(),
    Division.find({ _id: { $in: [...divisionIds].map(id => new ObjectId(id)) } })
      .select('name')
      .lean(),
    Customer.find({ _id: { $in: [...customerIds].map(id => new ObjectId(id)) } })
      .select('customerDisplayName')
      .lean(),
  ]);

  const warehouseMap = new Map(warehouses.map(w => [String(w._id), w.name]));
  const branchMap = new Map(branches.map(b => [String(b._id), b.name]));
  const divisionMap = new Map(divisions.map(d => [String(d._id), d.name]));
  const customerMap = new Map(customers.map(c => [String(c._id), c.customerDisplayName]));

  const startTime = filter.startDate ? new Date(filter.startDate).getTime() : null;
  const endTime = filter.endDate ? new Date(filter.endDate).getTime() : null;

  const eventTime = event => {
    const time = event.date ? new Date(event.date).getTime() : NaN;
    return Number.isNaN(time) ? null : time;
  };

  // Document dates use IST; date-only fields (challanDate, billDate…) are stored at IST midnight,
  // while some sources (stock transfer) use a full createdAt timestamp. Grouping by the IST calendar
  // day lets same-day rows tie so the actual movement time can order them, instead of a date-only
  // document sorting ahead of a timestamped one it truly happened after.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const eventDayKey = event => {
    const time = eventTime(event);
    if (time === null) return null;
    const ist = new Date(time + IST_OFFSET_MS);
    return ist.getUTCFullYear() * 10000 + (ist.getUTCMonth() + 1) * 100 + ist.getUTCDate();
  };
  const movementTimeOf = event => (event.movementTime ? new Date(event.movementTime).getTime() : null);

  const historical = [];
  const inRange = [];
  for (const event of events) {
    const time = eventTime(event);
    if (startTime !== null && (time === null || time < startTime)) {
      historical.push(event);
      continue;
    }
    if (endTime !== null && time !== null && time > endTime) continue;
    inRange.push(event);
  }

  const netQuantity = list => list.reduce((sum, e) => sum + (e.effectType === 'IN' ? e.quantity : -e.quantity), 0);
  const netAmount = list => list.reduce((sum, e) => sum + (e.effectType === 'IN' ? e.amount : -e.amount), 0);

  const openingBalance = netQuantity(historical);
  const openingAmount = netAmount(historical);
  const netMovementsInRange = netQuantity(inRange);
  const closingBalance = openingBalance + netMovementsInRange;
  const closingAmount = openingAmount + netAmount(inRange);

  inRange.sort((a, b) => {
    // 1) By document day (IST) so backdated documents keep their date-column position.
    const dayA = eventDayKey(a) ?? -Infinity;
    const dayB = eventDayKey(b) ?? -Infinity;
    if (dayA !== dayB) return dayA - dayB;
    // 2) Within the same day, by the actual movement time (posting order).
    const movementA = movementTimeOf(a) ?? -Infinity;
    const movementB = movementTimeOf(b) ?? -Infinity;
    if (movementA !== movementB) return movementA - movementB;
    // 3) Stable fallback on the raw document timestamp.
    const timeA = eventTime(a) ?? -Infinity;
    const timeB = eventTime(b) ?? -Infinity;
    return timeA - timeB;
  });

  let runningBalance = openingBalance;
  let runningAmount = openingAmount;
  const results = inRange.map(event => {
    runningBalance += event.effectType === 'IN' ? event.quantity : -event.quantity;
    runningAmount += event.effectType === 'IN' ? event.amount : -event.amount;
    return {
      date: event.date,
      createdAt: event.movementTime,
      refType: event.navType || SOURCE_DOCUMENTS[event.sourceType]?.navType || event.sourceType,
      refId: event.navId || event.sourceId || null,
      referenceType: SOURCE_DOCUMENTS[event.sourceType]?.label || event.sourceType,
      referenceId: event.sourceId || null,
      refNo: event.refNo,
      effectType: event.effectType,
      quantity: event.quantity,
      rate: event.rate,
      amount: event.amount,
      sellingPrice: event.sellingPrice,
      warehouseId: event.warehouseId || null,
      warehouseName: event.warehouseId ? warehouseMap.get(String(event.warehouseId)) || null : null,
      branchId: event.branchId || null,
      branchName: event.branchId ? branchMap.get(String(event.branchId)) || null : null,
      divisionId: event.divisionId || null,
      divisionName: event.divisionId ? divisionMap.get(String(event.divisionId)) || null : null,
      partyName: event.partyId ? customerMap.get(String(event.partyId)) || '' : '',
      QuantityBalance: runningBalance,
      RunningAmount: runningAmount,
    };
  });

  const page = parseInt(options.page, 10) || 1;
  const limit = parseInt(options.limit, 10) || 10;
  const isPaginationEnabled = options.pagination !== 'false' && options.pagination !== false;
  const startIndex = isPaginationEnabled ? (page - 1) * limit : 0;
  const paginatedResults = isPaginationEnabled ? results.slice(startIndex, startIndex + limit) : results;

  let broughtForward = openingBalance;
  let broughtForwardAmount = openingAmount;
  if (page > 1 && startIndex > 0) {
    const previous = results[startIndex - 1];
    broughtForward = previous.QuantityBalance;
    broughtForwardAmount = previous.RunningAmount;
  }

  let carriedOver = broughtForward;
  let carriedOverAmount = broughtForwardAmount;
  if (paginatedResults.length > 0) {
    const lastRow = paginatedResults[paginatedResults.length - 1];
    carriedOver = lastRow.QuantityBalance;
    carriedOverAmount = lastRow.RunningAmount;
  }

  return {
    results: paginatedResults,
    page,
    limit: isPaginationEnabled ? limit : results.length,
    totalPages: isPaginationEnabled ? Math.ceil(results.length / limit) : 1,
    totalResults: results.length,
    openingBalance,
    closingBalance,
    broughtForward,
    carriedOver,
    netMovements: netMovementsInRange,
    openingAmount,
    closingAmount,
    broughtForwardAmount,
    carriedOverAmount,
  };
};

module.exports = { itemLedger };
