const mongoose = require('mongoose');
const { getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const { PRODUCTION_ORDER_STATUS } = require('../../../utils/enum');
const {
  resolveCompanyTimezone,
  getLocalYearRange,
  getLocalMonthRange,
  mongoDateUnit,
} = require('../../../utils/companyTimezone');

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const buildBaseMatch = filter => {
  const { companyId, branchId, divisionId } = filter;

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    isActive: true,
    status: { $nin: [PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED] },
  };

  if (branchId) {
    const arr = branchId.split(',').filter(Boolean);
    if (arr.length) match.branchId = { $in: arr.map(id => new mongoose.Types.ObjectId(id)) };
  }

  if (divisionId) {
    const arr = divisionId.split(',').filter(Boolean);
    if (arr.length) match.divisionId = { $in: arr.map(id => new mongoose.Types.ObjectId(id)) };
  }

  return match;
};

// ─── 1. Monthly Summary (year-wise) ─────────────────────────────────────────

const getMonthlySummary = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { year, ...rest } = filter;

  const yearInt = parseInt(year, 10);
  const timezone = await resolveCompanyTimezone(rest.companyId);
  const { startDate, endDate } = getLocalYearRange(yearInt, timezone);
  const baseMatch = buildBaseMatch(rest);

  baseMatch.productionDate = { $gte: startDate, $lte: endDate };

  const monthRows = await ProductionOrder.aggregate([
    { $match: baseMatch },
    {
      $group: {
        _id: mongoDateUnit('month', '$productionDate', timezone),
        orders: { $sum: 1 },
        plannedQty: { $sum: '$quantity' },
        completeQty: { $sum: '$totalFgSubmittedQty' },
        fgRejectionQty: { $sum: '$totalFgRejectedQty' },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        month: '$_id',
        orders: 1,
        plannedQty: 1,
        completeQty: 1,
        fgRejectionQty: 1,
        fgRejectionPct: {
          $cond: [
            { $gt: ['$plannedQty', 0] },
            { $round: [{ $multiply: [{ $divide: ['$fgRejectionQty', '$plannedQty'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
  ]);

  const months = monthRows.map(r => ({
    ...r,
    monthLabel: `${MONTH_NAMES[r.month - 1]} ${yearInt}`,
  }));

  let totalOrders = 0;
  let totalPlanned = 0;
  let totalComplete = 0;
  let totalRejection = 0;

  months.forEach(m => {
    totalOrders += m.orders;
    totalPlanned += m.plannedQty;
    totalComplete += m.completeQty;
    totalRejection += m.fgRejectionQty;
  });

  const avgRejectionPct = totalPlanned > 0 ? Math.round((totalRejection / totalPlanned) * 10000) / 100 : 0;

  const kpis = {
    totalOrders,
    totalPlanned,
    totalComplete,
    totalRejection,
    avgRejectionPct,
  };

  return { result: { kpis, months } };
};

// ─── 2. Monthly Detail — Production Order list ───────────────────────────────

const getMonthlyDetailOrders = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();

  const { year, month, page = 1, limit = 20, sortBy, pagination, ...rest } = filter;
  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  const paginate = pagination !== false && pagination !== 'false';

  const timezone = await resolveCompanyTimezone(rest.companyId);
  const { startDate, endDate } = getLocalMonthRange(yearInt, monthInt, timezone);

  const baseMatch = buildBaseMatch(rest);
  baseMatch.productionDate = { $gte: startDate, $lte: endDate };

  const pageInt = parseInt(page, 10);
  const limitInt = parseInt(limit, 10);
  const skip = (pageInt - 1) * limitInt;

  let sortStage = { productionDate: -1, _id: -1 };
  if (sortBy) {
    const [field, direction] = sortBy.split(':');
    sortStage = { [field]: direction === 'desc' ? -1 : 1, _id: -1 };
  }

  const pipeline = [
    { $match: baseMatch },
    { $sort: sortStage },
    ...(paginate ? [{ $skip: skip }, { $limit: limitInt }] : []),
    {
      $project: {
        _id: 1,
        productionOrderCode: 1,
        itemId: 1,
        quantity: 1,
        totalFgSubmittedQty: 1,
        totalFgRejectedQty: 1,
        status: 1,
        productionDate: 1,
      },
    },
  ];

  const [totalResults, orders] = await Promise.all([
    ProductionOrder.countDocuments(baseMatch),
    ProductionOrder.aggregate(pipeline),
  ]);

  const itemIds = [...new Set(orders.map(o => o.itemId).filter(Boolean))];
  const items = await Item.find({ _id: { $in: itemIds } })
    .select('itemName itemNo')
    .lean();
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));

  const results = orders.map(o => {
    const item = o.itemId ? itemMap.get(o.itemId.toString()) : null;
    const pendingQty = Math.max(0, (o.quantity || 0) - (o.totalFgSubmittedQty || 0));
    const fgRejectionPct = o.quantity > 0 ? Math.round(((o.totalFgRejectedQty || 0) / o.quantity) * 100 * 100) / 100 : 0;

    return {
      _id: o._id,
      productionOrderCode: o.productionOrderCode || '',
      itemId: o.itemId,
      itemName: item?.itemName || null,
      itemCode: item?.itemNo || null,
      plannedQty: o.quantity || 0,
      producedQty: o.totalFgSubmittedQty || 0,
      pendingQty,
      fgSubmittedQty: o.totalFgSubmittedQty || 0,
      fgRejectedQty: o.totalFgRejectedQty || 0,
      fgRejectionPct,
      status: o.status,
      productionDate: o.productionDate,
    };
  });

  const kpis = await _buildDetailKpis(ProductionOrder, baseMatch);

  const totalPages = Math.ceil(totalResults / limitInt);

  return {
    result: results,
    kpis,
    page: pageInt,
    limit: limitInt,
    totalPages,
    totalResults,
  };
};

// ─── 3. Monthly Detail — Item-wise aggregation ───────────────────────────────

const getMonthlyDetailByItem = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();

  const { year, month, page = 1, limit = 20, pagination, ...rest } = filter;
  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  const paginate = pagination !== false && pagination !== 'false';

  const timezone = await resolveCompanyTimezone(rest.companyId);
  const { startDate, endDate } = getLocalMonthRange(yearInt, monthInt, timezone);

  const baseMatch = buildBaseMatch(rest);
  baseMatch.productionDate = { $gte: startDate, $lte: endDate };

  const pageInt = parseInt(page, 10);
  const limitInt = parseInt(limit, 10);
  const skip = (pageInt - 1) * limitInt;

  const groupStages = [
    { $match: baseMatch },
    {
      $group: {
        _id: '$itemId',
        orders: { $sum: 1 },
        plannedQty: { $sum: '$quantity' },
        producedQty: { $sum: '$totalFgSubmittedQty' },
        fgSubmittedQty: { $sum: '$totalFgSubmittedQty' },
        fgRejectedQty: { $sum: '$totalFgRejectedQty' },
      },
    },
    {
      $project: {
        _id: 0,
        itemId: '$_id',
        orders: 1,
        plannedQty: 1,
        producedQty: 1,
        fgSubmittedQty: 1,
        fgRejectedQty: 1,
        pendingQty: { $max: [{ $subtract: ['$plannedQty', '$producedQty'] }, 0] },
        fgRejectionPct: {
          $cond: [
            { $gt: ['$plannedQty', 0] },
            { $round: [{ $multiply: [{ $divide: ['$fgRejectedQty', '$plannedQty'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
    { $sort: { plannedQty: -1, itemId: 1 } },
  ];

  let pagedData;
  let totalResults;

  if (paginate) {
    const [facetResult] = await ProductionOrder.aggregate([
      ...groupStages,
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $skip: skip }, { $limit: limitInt }],
        },
      },
    ]);
    totalResults = facetResult?.metadata?.[0]?.total || 0;
    pagedData = facetResult?.data || [];
  } else {
    pagedData = await ProductionOrder.aggregate(groupStages);
    totalResults = pagedData.length;
  }

  const [items, kpis] = await Promise.all([
    Item.find({ _id: { $in: [...new Set(pagedData.map(r => r.itemId).filter(Boolean))] } })
      .select('itemName itemNo')
      .lean(),
    _buildDetailKpis(ProductionOrder, baseMatch),
  ]);
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));

  const result = pagedData.map(r => {
    const item = r.itemId ? itemMap.get(r.itemId.toString()) : null;
    return { ...r, itemName: item?.itemName || null, itemCode: item?.itemNo || null };
  });

  const totalPages = paginate ? Math.ceil(totalResults / limitInt) || 1 : 1;

  return {
    result,
    kpis,
    page: pageInt,
    limit: limitInt,
    totalPages,
    totalResults,
  };
};

// ─── Shared detail KPI helper ─────────────────────────────────────────────────

const _buildDetailKpis = async (ProductionOrder, match) => {
  const [agg] = await ProductionOrder.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalPlanned: { $sum: '$quantity' },
        totalComplete: { $sum: '$totalFgSubmittedQty' },
        totalRejection: { $sum: '$totalFgRejectedQty' },
      },
    },
    {
      $project: {
        _id: 0,
        totalOrders: 1,
        totalPlanned: 1,
        totalComplete: 1,
        totalRejection: 1,
        rejectionPct: {
          $cond: [
            { $gt: ['$totalPlanned', 0] },
            { $round: [{ $multiply: [{ $divide: ['$totalRejection', '$totalPlanned'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
  ]);

  return (
    agg || {
      totalOrders: 0,
      totalPlanned: 0,
      totalComplete: 0,
      totalRejection: 0,
      rejectionPct: 0,
    }
  );
};

module.exports = {
  getMonthlySummary,
  getMonthlyDetailOrders,
  getMonthlyDetailByItem,
};
