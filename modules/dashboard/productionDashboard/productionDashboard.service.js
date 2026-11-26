const mongoose = require('mongoose');
const { getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const { PRODUCTION_ORDER_STATUS, SALES_ORDER_STATUS } = require('../../../utils/enum');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');

const toOid = id => new mongoose.Types.ObjectId(id);

const buildBaseFilter = filter => {
  const { companyId, startDate, endDate, branchId, divisionId } = filter;
  const query = { companyId: toOid(companyId) };

  const branchCond = buildBranchDivisionOrCondition(filter, { dateField: 'productionDate' });
  if (branchCond) Object.assign(query, branchCond);

  if (startDate || endDate) {
    query.productionDate = {};
    if (startDate) query.productionDate.$gte = new Date(startDate);
    if (endDate) query.productionDate.$lte = new Date(endDate);
  }

  return query;
};

const getSummary = async filter => {
  const { ProductionOrder } = getBooksModels();
  const baseFilter = buildBaseFilter(filter);

  const [statusCounts, salesOrderLinked] = await Promise.all([
    ProductionOrder.aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalQty: { $sum: '$quantity' },
          submittedQty: { $sum: '$fgSubmittedQty' },
        },
      },
    ]),
    ProductionOrder.countDocuments({ ...baseFilter, salesOrderId: { $exists: true, $ne: null } }),
  ]);

  const STATUS_ORDER = [
    PRODUCTION_ORDER_STATUS.PENDING,
    PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL,
    PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED,
    PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED,
    PRODUCTION_ORDER_STATUS.PARTIAL,
    PRODUCTION_ORDER_STATUS.COMPLETED,
    PRODUCTION_ORDER_STATUS.CLOSED,
    PRODUCTION_ORDER_STATUS.ON_HOLD,
  ];

  const countMap = {};
  let totalQty = 0;
  let submittedQty = 0;
  let totalOrders = 0;

  for (const row of statusCounts) {
    countMap[row._id] = { count: row.count, totalQty: row.totalQty, submittedQty: row.submittedQty };
    totalOrders += row.count;
    totalQty += row.totalQty || 0;
    submittedQty += row.submittedQty || 0;
  }

  const byStatus = STATUS_ORDER.map(s => ({
    status: s,
    count: countMap[s]?.count || 0,
    totalQty: countMap[s]?.totalQty || 0,
    submittedQty: countMap[s]?.submittedQty || 0,
  }));

  return {
    totalOrders,
    salesOrderLinked,
    totalQty: Math.round(totalQty * 100) / 100,
    submittedQty: Math.round(submittedQty * 100) / 100,
    completionRate: totalQty > 0 ? Math.round((submittedQty / totalQty) * 100) : 0,
    byStatus,
  };
};

const getPipeline = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const baseFilter = buildBaseFilter(filter);

  const PIPELINE_STAGES = [
    { status: PRODUCTION_ORDER_STATUS.PENDING, label: 'Pending', color: '#8a94ab' },
    { status: PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL, label: 'Awaiting Inventory', color: '#b45309' },
    { status: PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED, label: 'Inventory Issued', color: '#0e7490' },
    { status: PRODUCTION_ORDER_STATUS.PARTIAL, label: 'In Production', color: '#1e4fd6' },
    { status: PRODUCTION_ORDER_STATUS.COMPLETED, label: 'Completed', color: '#15803d' },
  ];

  const [aggregated, recentOrders] = await Promise.all([
    ProductionOrder.aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalQty: { $sum: '$quantity' },
          submittedQty: { $sum: '$fgSubmittedQty' },
          rejectedQty: { $sum: '$fgRejectedQty' },
          onHoldCount: {
            $sum: { $cond: [{ $eq: ['$status', PRODUCTION_ORDER_STATUS.ON_HOLD] }, 1, 0] },
          },
        },
      },
    ]),
    ProductionOrder.find(baseFilter)
      .sort({ productionDate: -1 })
      .limit(50)
      .select('productionOrderCode status itemId quantity fgSubmittedQty productionDate salesOrderId productionManageMethod')
      .lean(),
  ]);

  const countMap = {};
  for (const row of aggregated) countMap[row._id] = row;

  const itemIds = [...new Set(recentOrders.map(o => o.itemId?.toString()).filter(Boolean))];
  const items = itemIds.length
    ? await Item.find({ _id: { $in: itemIds } })
        .select('itemName')
        .lean()
    : [];
  const itemNameMap = new Map(items.map(i => [i._id.toString(), i.itemName]));

  const stages = PIPELINE_STAGES.map(stage => {
    const stats = countMap[stage.status] || { count: 0, totalQty: 0, submittedQty: 0, rejectedQty: 0 };
    const orders = recentOrders
      .filter(o => o.status === stage.status)
      .slice(0, 5)
      .map(o => ({
        id: o._id,
        code: o.productionOrderCode,
        itemName: itemNameMap.get(o.itemId?.toString()) || '—',
        quantity: o.quantity,
        submittedQty: o.fgSubmittedQty,
        productionDate: o.productionDate,
        salesOrderLinked: !!o.salesOrderId,
        method: o.productionManageMethod,
      }));

    return {
      ...stage,
      count: stats.count,
      totalQty: Math.round((stats.totalQty || 0) * 100) / 100,
      submittedQty: Math.round((stats.submittedQty || 0) * 100) / 100,
      rejectedQty: Math.round((stats.rejectedQty || 0) * 100) / 100,
      orders,
    };
  });

  const onHoldCount = countMap[PRODUCTION_ORDER_STATUS.ON_HOLD]?.count || 0;
  const closedCount = countMap[PRODUCTION_ORDER_STATUS.CLOSED]?.count || 0;

  return { stages, onHoldCount, closedCount };
};

const getSalesOrderFunnel = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { SalesOrder } = getBooksCrmModels();
  const baseFilter = buildBaseFilter(filter);

  const soFilter = { companyId: toOid(filter.companyId), status: { $ne: SALES_ORDER_STATUS.CANCELLED } };
  const branchCond = buildBranchDivisionOrCondition(filter, { dateField: 'orderDate' });
  if (branchCond) Object.assign(soFilter, branchCond);
  if (filter.startDate || filter.endDate) {
    soFilter.orderDate = {};
    if (filter.startDate) soFilter.orderDate.$gte = new Date(filter.startDate);
    if (filter.endDate) soFilter.orderDate.$lte = new Date(filter.endDate);
  }

  const [totalSalesOrders, linkedProductionOrders, soStatusCounts] = await Promise.all([
    SalesOrder.countDocuments(soFilter),
    ProductionOrder.distinct('salesOrderId', { ...baseFilter, salesOrderId: { $exists: true, $ne: null } }),
    SalesOrder.aggregate([{ $match: soFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const withProductionOrder = linkedProductionOrders.length;
  const withoutProductionOrder = Math.max(0, totalSalesOrders - withProductionOrder);

  const poStatusCounts = await ProductionOrder.aggregate([
    { $match: { ...baseFilter, salesOrderId: { $exists: true, $ne: null } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const soCountMap = {};
  for (const row of soStatusCounts) soCountMap[row._id] = row.count;

  const poCountMap = {};
  for (const row of poStatusCounts) poCountMap[row._id] = row.count;

  return {
    totalSalesOrders,
    withProductionOrder,
    withoutProductionOrder,
    conversionRate: totalSalesOrders > 0 ? Math.round((withProductionOrder / totalSalesOrders) * 100) : 0,
    salesOrderByStatus: soCountMap,
    linkedProductionOrderByStatus: poCountMap,
  };
};

const getTrend = async filter => {
  const { ProductionOrder } = getBooksModels();
  const baseFilter = buildBaseFilter(filter);
  const groupBy = filter.groupBy || 'week';

  const dateGrouping =
    groupBy === 'day'
      ? { year: { $year: '$productionDate' }, month: { $month: '$productionDate' }, day: { $dayOfMonth: '$productionDate' } }
      : groupBy === 'month'
        ? { year: { $year: '$productionDate' }, month: { $month: '$productionDate' } }
        : { year: { $year: '$productionDate' }, week: { $week: '$productionDate' } };

  const rows = await ProductionOrder.aggregate([
    { $match: baseFilter },
    {
      $group: {
        _id: { ...dateGrouping, status: '$status' },
        count: { $sum: 1 },
        totalQty: { $sum: '$quantity' },
        submittedQty: { $sum: '$fgSubmittedQty' },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.week': 1, '_id.day': 1 } },
  ]);

  // Group by period, then pivot status counts
  const periodMap = new Map();
  for (const row of rows) {
    const { year, month, week, day, status } = row._id;
    const key = groupBy === 'day' ? `${year}-${month}-${day}` : groupBy === 'month' ? `${year}-${month}` : `${year}-W${week}`;

    if (!periodMap.has(key)) {
      periodMap.set(key, { period: key, year, month, week, day, total: 0, completed: 0, inProgress: 0, pending: 0 });
    }
    const entry = periodMap.get(key);
    entry.total += row.count;
    if (status === PRODUCTION_ORDER_STATUS.COMPLETED || status === PRODUCTION_ORDER_STATUS.CLOSED) entry.completed += row.count;
    else if (status === PRODUCTION_ORDER_STATUS.PARTIAL) entry.inProgress += row.count;
    else entry.pending += row.count;
  }

  return { trend: [...periodMap.values()], groupBy };
};

const getTopItems = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const baseFilter = buildBaseFilter(filter);
  const limit = parseInt(filter.limit, 10) || 10;

  const rows = await ProductionOrder.aggregate([
    { $match: { ...baseFilter, itemId: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: '$itemId',
        orderCount: { $sum: 1 },
        totalQty: { $sum: '$quantity' },
        completedQty: { $sum: '$fgSubmittedQty' },
        completedOrders: {
          $sum: { $cond: [{ $eq: ['$status', PRODUCTION_ORDER_STATUS.COMPLETED] }, 1, 0] },
        },
      },
    },
    { $sort: { totalQty: -1 } },
    { $limit: limit },
  ]);

  const itemIds = rows.map(r => r._id).filter(Boolean);
  const items = itemIds.length
    ? await Item.find({ _id: { $in: itemIds } })
        .select('itemName itemCode')
        .lean()
    : [];
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));

  return rows.map(r => {
    const item = itemMap.get(r._id.toString()) || {};
    return {
      itemId: r._id,
      itemName: item.itemName || '—',
      itemCode: item.itemCode || '—',
      orderCount: r.orderCount,
      totalQty: Math.round(r.totalQty * 100) / 100,
      completedQty: Math.round(r.completedQty * 100) / 100,
      completedOrders: r.completedOrders,
      completionRate: r.orderCount > 0 ? Math.round((r.completedOrders / r.orderCount) * 100) : 0,
    };
  });
};

module.exports = { getSummary, getPipeline, getSalesOrderFunnel, getTrend, getTopItems };
