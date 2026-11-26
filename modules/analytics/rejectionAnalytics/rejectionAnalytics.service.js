const mongoose = require('mongoose');
const moment = require('moment');
const { getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const { PRODUCTION_MANAGE_METHOD, PRODUCTION_ORDER_STATUS } = require('../../../utils/enum');

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Build the base $match stage shared by all aggregation pipelines.
 * Filters out INVENTORY_REJECTED status (those orders never produced anything meaningful).
 */
const buildBaseMatch = filter => {
  const { companyId, startDate, endDate, branchId, divisionId, itemId, productionManageMethod } = filter;

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    isActive: true,
    status: { $nin: [PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED] },
  };

  if (startDate && endDate) {
    match.productionDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const arr = branchId.split(',').filter(Boolean);
    if (arr.length) match.branchId = { $in: arr.map(id => new mongoose.Types.ObjectId(id)) };
  }

  if (divisionId) {
    const arr = divisionId.split(',').filter(Boolean);
    if (arr.length) match.divisionId = { $in: arr.map(id => new mongoose.Types.ObjectId(id)) };
  }

  if (itemId) {
    match.itemId = new mongoose.Types.ObjectId(itemId);
  }

  if (productionManageMethod) {
    match.productionManageMethod = productionManageMethod;
  }

  return match;
};

// ─── 1. Summary (KPI cards) ──────────────────────────────────────────────────

/**
 * Returns overall rejection KPIs for the given filters.
 * { totalOrders, totalPlanned, totalSubmitted, totalRejected,
 *   rejectionRate, yieldRate, totalRawMaterialRejected, totalRawMaterialReturned,
 *   byMethod: [{ method, totalOrders, totalPlanned, totalRejected, rejectionRate }] }
 */
const getRejectionSummary = async filter => {
  const { ProductionOrder } = getBooksModels();
  const match = buildBaseMatch(filter);

  const [agg] = await ProductionOrder.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalPlanned: { $sum: '$quantity' },
        totalSubmitted: { $sum: '$totalFgSubmittedQty' },
        totalRejected: { $sum: '$totalFgRejectedQty' },
        totalRawMaterialRejected: { $sum: { $sum: '$rawMaterials.rejectQty' } },
        totalRawMaterialReturned: { $sum: { $sum: '$rawMaterials.returnQty' } },
      },
    },
    {
      $project: {
        _id: 0,
        totalOrders: 1,
        totalPlanned: 1,
        totalSubmitted: 1,
        totalRejected: 1,
        totalRawMaterialRejected: 1,
        totalRawMaterialReturned: 1,
        rejectionRate: {
          $cond: [
            { $gt: ['$totalPlanned', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalRejected', '$totalPlanned'] }, 100] }, 2] },
            0,
          ],
        },
        yieldRate: {
          $cond: [
            { $gt: ['$totalPlanned', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalSubmitted', '$totalPlanned'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
  ]);

  // Breakdown by production method
  const byMethod = await ProductionOrder.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$productionManageMethod',
        totalOrders: { $sum: 1 },
        totalPlanned: { $sum: '$quantity' },
        totalRejected: { $sum: '$totalFgRejectedQty' },
      },
    },
    {
      $project: {
        _id: 0,
        method: '$_id',
        totalOrders: 1,
        totalPlanned: 1,
        totalRejected: 1,
        rejectionRate: {
          $cond: [
            { $gt: ['$totalPlanned', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalRejected', '$totalPlanned'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
  ]);

  const result = agg || {
    totalOrders: 0,
    totalPlanned: 0,
    totalSubmitted: 0,
    totalRejected: 0,
    totalRawMaterialRejected: 0,
    totalRawMaterialReturned: 0,
    rejectionRate: 0,
    yieldRate: 0,
  };

  result.byMethod = byMethod;

  return { result };
};

// ─── 2. Rejection trend (time series) ────────────────────────────────────────

/**
 * Returns daily/weekly/monthly rejection data from submissionHistory.
 * Each entry: { period, rejectedQty, submittedQty, rejectionRate }
 */
const getRejectionTrend = async filter => {
  const { ProductionOrder } = getBooksModels();
  const match = buildBaseMatch(filter);
  const groupBy = filter.groupBy || 'month';

  const dateFormat = groupBy === 'day' ? '%Y-%m-%d' : groupBy === 'week' ? '%Y-W%V' : '%Y-%m';

  const { productionDate: _ignored, ...trendMatch } = match;

  const result = await ProductionOrder.aggregate([
    { $match: trendMatch },
    { $unwind: { path: '$submissionHistory', preserveNullAndEmptyArrays: false } },
    ...(filter.startDate && filter.endDate
      ? [
          {
            $match: {
              'submissionHistory.submissionDate': {
                $gte: new Date(filter.startDate),
                $lte: new Date(filter.endDate),
              },
            },
          },
        ]
      : []),
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: '$submissionHistory.submissionDate' } },
        rejectedQty: { $sum: '$submissionHistory.fgRejectedQty' },
        submittedQty: { $sum: '$submissionHistory.fgSubmittedQty' },
        submissionCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        period: '$_id',
        rejectedQty: 1,
        submittedQty: 1,
        submissionCount: 1,
        rejectionRate: {
          $cond: [
            { $gt: [{ $add: ['$submittedQty', '$rejectedQty'] }, 0] },
            {
              $round: [
                {
                  $multiply: [{ $divide: ['$rejectedQty', { $add: ['$submittedQty', '$rejectedQty'] }] }, 100],
                },
                2,
              ],
            },
            0,
          ],
        },
      },
    },
  ]);

  return { result };
};

// ─── 3. Top 5 rejection by finished-goods item ───────────────────────────────

/**
 * Which finished goods get rejected the most (top 5).
 * NOTE: Item lives in booksCrm DB — cannot use $lookup; fetch manually.
 * Each entry: { itemId, itemName, itemCode, totalPlanned, totalSubmitted, totalRejected, rejectionRate }
 */
const getRejectionByItem = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const match = buildBaseMatch(filter);

  const data = await ProductionOrder.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$itemId',
        totalPlanned: { $sum: '$quantity' },
        totalSubmitted: { $sum: '$totalFgSubmittedQty' },
        totalRejected: { $sum: '$totalFgRejectedQty' },
        orderCount: { $sum: 1 },
      },
    },
    {
      $project: {
        itemId: '$_id',
        totalPlanned: 1,
        totalSubmitted: 1,
        totalRejected: 1,
        orderCount: 1,
        rejectionRate: {
          $cond: [
            { $gt: ['$totalPlanned', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalRejected', '$totalPlanned'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
    { $sort: { totalRejected: -1 } },
    { $limit: 5 },
  ]);

  // Cross-DB: Item is in booksCrm, not books — $lookup would silently return empty
  const itemIds = [...new Set(data.map(r => r.itemId).filter(Boolean))];
  const items = await Item.find({ _id: { $in: itemIds } })
    .select('itemName itemNo')
    .lean();
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));

  const result = data.map(r => {
    const item = r.itemId ? itemMap.get(r.itemId.toString()) : null;
    return { ...r, itemName: item?.itemName || null, itemCode: item?.itemNo || null };
  });

  return { result };
};

// ─── 4. Top 5 rejection by raw material ──────────────────────────────────────

/**
 * Which input materials are rejected / returned the most (top 5) — signals supplier quality issues.
 * NOTE: Item lives in booksCrm DB — fetch manually.
 * Each entry: { rawMaterialId, itemName, itemCode, totalRequired, totalRejected, totalReturned, rejectionRate }
 */
const getRejectionByRawMaterial = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const match = buildBaseMatch(filter);

  if (filter.productionManageMethod && filter.productionManageMethod !== PRODUCTION_MANAGE_METHOD.BOM_BASED) {
    return { result: [] };
  }
  const methodMatch = { ...match, productionManageMethod: PRODUCTION_MANAGE_METHOD.BOM_BASED };

  const data = await ProductionOrder.aggregate([
    { $match: methodMatch },
    { $unwind: { path: '$rawMaterials', preserveNullAndEmptyArrays: false } },
    { $match: { 'rawMaterials.rejectQty': { $gt: 0 } } },
    {
      $group: {
        _id: '$rawMaterials.rawMaterialId',
        totalRequired: { $sum: '$rawMaterials.productionOrderRequiredUnit' },
        totalRejected: { $sum: '$rawMaterials.rejectQty' },
        totalReturned: { $sum: '$rawMaterials.returnQty' },
        orderCount: { $sum: 1 },
      },
    },
    {
      $project: {
        rawMaterialId: '$_id',
        totalRequired: 1,
        totalRejected: 1,
        totalReturned: 1,
        orderCount: 1,
        rejectionRate: {
          $cond: [
            { $gt: ['$totalRequired', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalRejected', '$totalRequired'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
    { $sort: { totalRejected: -1 } },
    { $limit: 5 },
  ]);

  // Cross-DB: Item is in booksCrm, not books — $lookup would silently return empty
  const itemIds = [...new Set(data.map(r => r.rawMaterialId).filter(Boolean))];
  const items = await Item.find({ _id: { $in: itemIds } })
    .select('itemName itemNo')
    .lean();
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));

  const result = data.map(r => {
    const item = r.rawMaterialId ? itemMap.get(r.rawMaterialId.toString()) : null;
    return { ...r, itemName: item?.itemName || null, itemCode: item?.itemNo || null };
  });

  return { result };
};

// ─── 5. Top 5 rejection by process step (PROCESS_ROUTE only) ─────────────────

/**
 * Shows which process steps lose the most (top 5).
 * Each entry: { processName, totalProcessIN, totalProcessOUT, totalRejection, rejectionRate }
 */
const getRejectionByProcess = async filter => {
  const { ProductionOrder } = getBooksModels();
  const match = {
    ...buildBaseMatch(filter),
    productionManageMethod: PRODUCTION_MANAGE_METHOD.PROCESS_ROUTE,
  };

  const result = await ProductionOrder.aggregate([
    { $match: match },
    { $unwind: { path: '$processBased.processes', preserveNullAndEmptyArrays: false } },
    { $match: { 'processBased.processes.processRejection': { $gt: 0 } } },
    {
      $group: {
        _id: '$processBased.processes.processName',
        totalProcessIN: { $sum: '$processBased.processes.processIN' },
        totalProcessOUT: { $sum: '$processBased.processes.processOUT' },
        totalRejection: { $sum: '$processBased.processes.processRejection' },
        orderCount: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        processName: '$_id',
        totalProcessIN: 1,
        totalProcessOUT: 1,
        totalRejection: 1,
        orderCount: 1,
        rejectionRate: {
          $cond: [
            { $gt: ['$totalProcessIN', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalRejection', '$totalProcessIN'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
    { $sort: { totalRejection: -1 } },
    { $limit: 5 },
  ]);

  return { result };
};

// ─── 6. Top 5 rejection by branch ────────────────────────────────────────────

/**
 * Which plant/branch has the worst rejection rate (top 5).
 * NOTE: Branch lives in booksCrm DB — cannot use $lookup; fetch manually.
 * Each entry: { branchId, branchName, totalPlanned, totalSubmitted, totalRejected, rejectionRate }
 */
const getRejectionByBranch = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Branch } = getBooksCrmModels();
  const match = buildBaseMatch(filter);

  const data = await ProductionOrder.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$branchId',
        totalPlanned: { $sum: '$quantity' },
        totalSubmitted: { $sum: '$totalFgSubmittedQty' },
        totalRejected: { $sum: '$totalFgRejectedQty' },
        orderCount: { $sum: 1 },
      },
    },
    {
      $project: {
        branchId: '$_id',
        totalPlanned: 1,
        totalSubmitted: 1,
        totalRejected: 1,
        orderCount: 1,
        rejectionRate: {
          $cond: [
            { $gt: ['$totalPlanned', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalRejected', '$totalPlanned'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
    { $sort: { rejectionRate: -1 } },
    { $limit: 5 },
  ]);

  // Cross-DB: Branch is in booksCrm, not books — $lookup would silently return empty
  const branchIds = [...new Set(data.map(r => r.branchId).filter(Boolean))];
  const branches = await Branch.find({ _id: { $in: branchIds } })
    .select('name')
    .lean();
  const branchMap = new Map(branches.map(b => [b._id.toString(), b]));

  const result = data.map(r => {
    const branch = r.branchId ? branchMap.get(r.branchId.toString()) : null;
    return { ...r, branchName: branch?.name || null };
  });

  return { result };
};

const roundPercentage = value => Math.round((value + Number.EPSILON) * 100) / 100;

const itemRejectionReportOfProductionOrder = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();

  const { companyId, itemId, itemType, startDate, endDate, pagination, page, limit } = filter;
  const itemObjectId = itemId ? new mongoose.Types.ObjectId(itemId) : null;
  const normalizedItemType = itemType ? itemType.toUpperCase() : null;
  const includeRawMaterial = normalizedItemType !== 'FG';
  const includeFg = normalizedItemType !== 'RM';

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    productionManageMethod: PRODUCTION_MANAGE_METHOD.BOM_BASED,
    $or: [
      ...(includeRawMaterial ? [{ 'rawMaterials.rejectQty': { $gt: 0 } }] : []),
      ...(includeFg ? [{ totalFgRejectedQty: { $gt: 0 } }] : []),
    ],
  };

  if (startDate && endDate) {
    match.createdAt = {
      $gte: moment(startDate).startOf('day').toDate(),
      $lte: moment(endDate).endOf('day').toDate(),
    };
  }

  const orderFields = {
    productionOrderId: '$_id',
    productionOrderCode: '$productionOrderCode',
    branchId: '$branchId',
    divisionId: '$divisionId',
    warehouseId: '$warehouseId',
    status: '$status',
    productionDate: '$productionDate',
  };

  const [{ rawMaterialRejections = [], fgRejections = [] } = {}] = await ProductionOrder.aggregate([
    { $match: match },
    {
      $facet: {
        rawMaterialRejections: includeRawMaterial
          ? [
              { $unwind: '$rawMaterials' },
              {
                $match: {
                  'rawMaterials.rejectQty': { $gt: 0 },
                  ...(itemObjectId ? { 'rawMaterials.rawMaterialId': itemObjectId } : {}),
                },
              },
              {
                $group: {
                  _id: '$rawMaterials.rawMaterialId',
                  productionOrders: {
                    $push: {
                      ...orderFields,
                      rejectedQty: '$rawMaterials.rejectQty',
                      requiredQty: '$rawMaterials.productionOrderRequiredUnit',
                    },
                  },
                },
              },
            ]
          : [{ $match: { _id: { $exists: false } } }],
        fgRejections: includeFg
          ? [
              { $match: { totalFgRejectedQty: { $gt: 0 }, ...(itemObjectId ? { itemId: itemObjectId } : {}) } },
              {
                $group: {
                  _id: '$itemId',
                  productionOrders: {
                    $push: { ...orderFields, rejectedQty: '$totalFgRejectedQty', requiredQty: '$quantity' },
                  },
                },
              },
            ]
          : [{ $match: { _id: { $exists: false } } }],
      },
    },
  ]);

  const itemsMap = new Map();

  const mergeContributions = (entries, source) => {
    entries.forEach(({ _id, productionOrders }) => {
      if (!_id) return;
      const itemKey = _id.toString();
      if (!itemsMap.has(itemKey)) {
        itemsMap.set(itemKey, new Map());
      }
      const ordersMap = itemsMap.get(itemKey);

      productionOrders.forEach(order => {
        const orderKey = order.productionOrderId.toString();
        if (!ordersMap.has(orderKey)) {
          ordersMap.set(orderKey, {
            productionOrderId: order.productionOrderId,
            productionOrderCode: order.productionOrderCode,
            branchId: order.branchId,
            divisionId: order.divisionId,
            warehouseId: order.warehouseId,
            status: order.status,
            productionDate: order.productionDate,
            fgRejectedQty: 0,
            rawMaterialRejectedQty: 0,
            fgRequiredQty: 0,
            rawMaterialRequiredQty: 0,
          });
        }
        const orderEntry = ordersMap.get(orderKey);
        if (source === 'FG') {
          orderEntry.fgRejectedQty += order.rejectedQty || 0;
          orderEntry.fgRequiredQty += order.requiredQty || 0;
        } else {
          orderEntry.rawMaterialRejectedQty += order.rejectedQty || 0;
          orderEntry.rawMaterialRequiredQty += order.requiredQty || 0;
        }
      });
    });
  };

  mergeContributions(rawMaterialRejections, 'RM');
  mergeContributions(fgRejections, 'FG');

  const itemIds = [...itemsMap.keys()];
  const items = await Item.find({ _id: { $in: itemIds } })
    .select('itemName itemNo')
    .lean();
  const itemMap = new Map(items.map(item => [item._id.toString(), item]));

  const itemResults = itemIds
    .map(id => {
      const productionOrders = [...itemsMap.get(id).values()].map(order => {
        const rejectedQty = order.fgRejectedQty + order.rawMaterialRejectedQty;
        const requiredQty = order.fgRequiredQty + order.rawMaterialRequiredQty;

        return {
          ...order,
          rejectedQty,
          requiredQty,
          rejectionPercentage: requiredQty > 0 ? roundPercentage((rejectedQty / requiredQty) * 100) : 0,
        };
      });

      const totalRejectedQty = productionOrders.reduce((sum, order) => sum + order.rejectedQty, 0);
      const totalRequiredQty = productionOrders.reduce((sum, order) => sum + order.requiredQty, 0);

      return {
        itemId: id,
        itemName: itemMap.get(id)?.itemName || null,
        itemNo: itemMap.get(id)?.itemNo || null,
        totalRejectedQty,
        totalRequiredQty,
        rejectionPercentage: totalRequiredQty > 0 ? roundPercentage((totalRejectedQty / totalRequiredQty) * 100) : 0,
        productionOrders,
      };
    })
    .sort((a, b) => b.totalRejectedQty - a.totalRejectedQty);

  const uniqueProductionOrderIds = new Set();
  let totalFgRejectedQty = 0;
  let totalRawMaterialRejectedQty = 0;
  let totalFgRequiredQty = 0;
  let totalRawMaterialRequiredQty = 0;

  itemResults.forEach(item => {
    item.productionOrders.forEach(order => {
      uniqueProductionOrderIds.add(order.productionOrderId.toString());
      totalFgRejectedQty += order.fgRejectedQty;
      totalRawMaterialRejectedQty += order.rawMaterialRejectedQty;
      totalFgRequiredQty += order.fgRequiredQty;
      totalRawMaterialRequiredQty += order.rawMaterialRequiredQty;
    });
  });

  const totalRequiredQty = totalFgRequiredQty + totalRawMaterialRequiredQty;
  const totalRejectedQty = totalFgRejectedQty + totalRawMaterialRejectedQty;

  const isPaginated = ![false, 'false'].includes(pagination);
  const pageLimit = limit && parseInt(limit, 10) > 0 ? parseInt(limit, 10) : 10;
  const currentPage = page && parseInt(page, 10) > 0 ? parseInt(page, 10) : 1;
  const totalItems = itemResults.length;
  const pagedItems = isPaginated
    ? itemResults.slice((currentPage - 1) * pageLimit, (currentPage - 1) * pageLimit + pageLimit)
    : itemResults;

  return {
    totalProductionOrders: uniqueProductionOrderIds.size,
    totalFgRejectedQty,
    totalRawMaterialRejectedQty,
    totalRejectedQty,
    totalFgRequiredQty,
    totalRawMaterialRequiredQty,
    totalRequiredQty,
    fgRejectionPercentage: totalFgRequiredQty > 0 ? roundPercentage((totalFgRejectedQty / totalFgRequiredQty) * 100) : 0,
    rmRejectionPercentage:
      totalRawMaterialRequiredQty > 0 ? roundPercentage((totalRawMaterialRejectedQty / totalRawMaterialRequiredQty) * 100) : 0,
    overallRejectionPercentage: totalRequiredQty > 0 ? roundPercentage((totalRejectedQty / totalRequiredQty) * 100) : 0,
    items: pagedItems,
    otherDetails: {
      totalItems,
      totalPages: isPaginated ? Math.ceil(totalItems / pageLimit) : 1,
      currentPage: isPaginated ? currentPage : 1,
      limit: isPaginated ? pageLimit : totalItems,
    },
  };
};

const itemRejectionProductionOrderList = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();

  const { companyId, itemId, startDate, endDate } = filter;
  const itemObjectId = new mongoose.Types.ObjectId(itemId);

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    productionManageMethod: PRODUCTION_MANAGE_METHOD.BOM_BASED,
    $or: [
      { itemId: itemObjectId, totalFgRejectedQty: { $gt: 0 } },
      { rawMaterials: { $elemMatch: { rawMaterialId: itemObjectId, rejectQty: { $gt: 0 } } } },
    ],
  };

  if (startDate && endDate) {
    match.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
  }

  const [orders, item] = await Promise.all([
    ProductionOrder.find(match)
      .select(
        'productionOrderCode itemId branchId divisionId warehouseId quantity status productionDate rawMaterials totalFgRejectedQty totalFgSubmittedQty createdAt',
      )
      .sort({ createdAt: -1 })
      .lean(),
    Item.findById(itemObjectId).select('itemName itemNo').lean(),
  ]);

  const productionOrders = orders.map(order => {
    const fgRejectedQty = order.itemId?.toString() === itemId.toString() ? order.totalFgRejectedQty || 0 : 0;

    const rawMaterialRejectedQty = (order.rawMaterials || [])
      .filter(rm => rm.rawMaterialId?.toString() === itemId.toString() && rm.rejectQty > 0)
      .reduce((sum, rm) => sum + (rm.rejectQty || 0), 0);

    return {
      productionOrderId: order._id,
      productionOrderCode: order.productionOrderCode,
      branchId: order.branchId,
      divisionId: order.divisionId,
      warehouseId: order.warehouseId,
      status: order.status,
      productionDate: order.productionDate,
      fgRejectedQty,
      rawMaterialRejectedQty,
      rejectedQty: fgRejectedQty + rawMaterialRejectedQty,
    };
  });

  return {
    itemId,
    itemName: item?.itemName || null,
    itemCode: item?.itemNo || null,
    totalRejectedQty: productionOrders.reduce((sum, order) => sum + order.rejectedQty, 0),
    productionOrders,
  };
};

module.exports = {
  getRejectionSummary,
  getRejectionTrend,
  getRejectionByItem,
  getRejectionByRawMaterial,
  getRejectionByProcess,
  getRejectionByBranch,
  itemRejectionReportOfProductionOrder,
  itemRejectionProductionOrderList,
};
