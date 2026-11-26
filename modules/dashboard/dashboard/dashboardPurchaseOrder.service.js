const mongoose = require('mongoose');
const { getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const httpStatus = require('http-status');

const getTopPurchasedItems = async (companyId, dateFilter) => {
  const { PurchaseOrder } = getBooksModels();
  return await PurchaseOrder.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), ...dateFilter } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.itemId',
        totalQuantity: { $sum: '$items.quantity' },
        totalPurchaseAmount: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
    { $sort: { totalPurchaseAmount: -1 } },
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
        totalPurchaseAmount: 1,
      },
    },
  ]);
};

const getTopPurchaseOrders = async (companyId, dateFilter) => {
  const { PurchaseOrder } = getBooksModels();
  return await PurchaseOrder.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), ...dateFilter } },
    {
      $group: {
        _id: '$_id',
        purchaseOrderId: { $first: '$purchaseOrderId' },
        vendor: { $first: '$vendor' },
        totalAmount: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
        date: { $first: '$date' },
      },
    },
    { $sort: { totalAmount: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: 'customers',
        localField: 'vendor',
        foreignField: '_id',
        as: 'vendorDetails',
      },
    },
    { $unwind: { path: '$vendorDetails', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        purchaseOrderId: 1,
        vendorName: '$vendorDetails.customerDisplayName',
        totalAmount: 1,
        date: 1,
      },
    },
  ]);
};

const getTopVendors = async (companyId, dateFilter) => {
  const { PurchaseOrder } = getBooksModels();
  return await PurchaseOrder.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), ...dateFilter } },
    {
      $group: {
        _id: '$vendor',
        totalPurchaseAmount: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { totalPurchaseAmount: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'vendorDetails',
      },
    },
    { $unwind: { path: '$vendorDetails', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        vendorId: '$_id',
        vendorName: '$vendorDetails.customerDisplayName',
        totalPurchaseAmount: 1,
        orderCount: 1,
      },
    },
  ]);
};

const getDashboardPurchaseOrder = async (query, filter) => {
  const { PurchaseOrder } = getBooksModels();
  try {
    const companyId = filter.companyId;

    let dateFilter = {};
    if (query.startDate && query.endDate) {
      dateFilter.date = {
        $gte: new Date(query.startDate),
        $lte: new Date(query.endDate),
      };
    } else {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      dateFilter.date = {
        $gte: firstDay,
        $lte: lastDay,
      };
    }

    const [topPurchasedItems, topPurchaseOrders, topVendors] = await Promise.all([
      getTopPurchasedItems(companyId, dateFilter),
      getTopPurchaseOrders(companyId, dateFilter),
      getTopVendors(companyId, dateFilter),
    ]);

    return {
      topPurchasedItems,
      topPurchaseOrders,
      topVendors,
    };
  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching dashboard analytics');
  }
};

module.exports = {
  getDashboardPurchaseOrder,
};
