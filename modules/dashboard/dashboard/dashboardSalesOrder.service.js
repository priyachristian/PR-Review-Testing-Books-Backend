const mongoose = require('mongoose');
const { getBooksCrmModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const httpStatus = require('http-status');

const getTopCustomers = async (companyId, dateFilter) => {
  const { SalesOrder } = getBooksCrmModels();
  return await SalesOrder.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), ...dateFilter } },
    {
      $group: {
        _id: '$customerId',
        totalSales: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { totalSales: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customerDetails',
      },
    },
    { $unwind: { path: '$customerDetails', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        customerName: '$customerDetails.customerDisplayName',
        totalSales: 1,
        orderCount: 1,
      },
    },
  ]);
};

const getTopSalesOrders = async (companyId, dateFilter) => {
  const { SalesOrder } = getBooksCrmModels();
  return await SalesOrder.find({ companyId, ...dateFilter })
    .sort({ total: -1 })
    .limit(5)
    .select('orderId total customerId orderDate')
    .populate('customerId', 'customerDisplayName');
};

const getTopItems = async (companyId, dateFilter) => {
  const { SalesOrder } = getBooksCrmModels();
  return await SalesOrder.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), ...dateFilter } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.itemId',
        totalQuantity: { $sum: '$items.quantity' },
        totalSales: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
    { $sort: { totalSales: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: 'items',
        localField: '_id',
        foreignField: '_id',
        as: 'itemDetails',
      },
    },
    { $unwind: { path: '$itemDetails', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        itemId: '$_id',
        itemName: '$itemDetails.itemName',
        totalQuantity: 1,
        totalSales: 1,
      },
    },
  ]);
};

const getDashboardSalesOrder = async (query, filter) => {
  try {
    const companyId = filter.companyId;

    let dateFilter = {};
    if (query.startDate && query.endDate) {
      dateFilter.orderDate = {
        $gte: new Date(query.startDate),
        $lte: new Date(query.endDate),
      };
    } else {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      dateFilter.orderDate = {
        $gte: firstDay,
        $lte: lastDay,
      };
    }

    const [topCustomers, topSalesOrders, topItems] = await Promise.all([
      getTopCustomers(companyId, dateFilter),
      getTopSalesOrders(companyId, dateFilter),
      getTopItems(companyId, dateFilter),
    ]);

    return {
      topCustomers,
      topSalesOrders,
      topItems,
    };
  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching dashboard analytics');
  }
};

module.exports = {
  getDashboardSalesOrder,
};
