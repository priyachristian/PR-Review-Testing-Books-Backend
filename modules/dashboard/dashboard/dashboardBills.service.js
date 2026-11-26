const mongoose = require('mongoose');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels } = require('../../../services/model.service');
const { creditorsReport } = require('../../report/report/report.service');

const getTopVendorsByBalance = async (companyId, dateFilter) => {
  const { Bill } = getBooksModels();
  try {
    const topVendors = await Bill.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          balanceAmount: { $gt: 0 },
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: '$vendor',
          totalBalance: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } },
          billCount: { $sum: 1 },
        },
      },
      { $sort: { totalBalance: -1 } },
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
          vendorName: '$vendorDetails.customerDisplayName',
          totalBalance: 1,
          billCount: 1,
        },
      },
    ]);

    return topVendors;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching top vendors by balance');
  }
};

const getRecentPaymentsMade = async (companyId, dateFilter) => {
  const { PaymentMade } = getBooksModels();
  try {
    const recentPayments = await PaymentMade.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          paymentDate: dateFilter.paymentDate,
        },
      },
      { $sort: { paymentDate: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'customers',
          localField: 'vendorId',
          foreignField: '_id',
          as: 'vendorDetails',
        },
      },
      { $unwind: { path: '$vendorDetails', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          paymentMadeId: 1,
          vendorName: '$vendorDetails.customerDisplayName',
          paymentMade: { $multiply: ['$paymentMade', { $ifNull: ['$exchangeRate', 1] }] },
          paymentMode: 1,
          paymentDate: 1,
        },
      },
    ]);

    return recentPayments;
  } catch (error) {
    console.error('Error fetching recent vendor payments:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching recent vendor payments');
  }
};

const getUpcomingPayables = async (companyId, dateFilter) => {
  const { Bill } = getBooksModels();
  try {
    const today = new Date();

    const upcomingPayables = await Bill.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          dueDate: { $gt: today },
          balanceAmount: { $gt: 0 },
          ...dateFilter,
        },
      },
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
          billId: 1,
          vendorName: '$vendorDetails.customerDisplayName',
          dueDate: 1,
          balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
      { $sort: { dueDate: 1 } },
      { $limit: 5 },
    ]);

    return upcomingPayables;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching upcoming payables');
  }
};

const getOverdueBills = async (companyId, dateFilter) => {
  const { Bill } = getBooksModels();
  try {
    const today = new Date();

    const overdueBills = await Bill.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          dueDate: { $lt: today },
          balanceAmount: { $gt: 0 },
          ...dateFilter,
        },
      },
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
          billId: 1,
          vendorName: '$vendorDetails.customerDisplayName',
          dueDate: 1,
          balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
      { $sort: { dueDate: 1 } },
      { $limit: 5 },
    ]);

    return overdueBills;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching overdue bills');
  }
};

const getTotalPayables = async (companyId, dateFilter) => {
  const { Bill } = getBooksModels();
  try {
    return await Bill.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          balanceAmount: { $gt: 0 },
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } },
          count: { $sum: 1 },
        },
      },
    ]);
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching total payables');
  }
};

const getTodaysPayables = async companyId => {
  const { Bill } = getBooksModels();
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    return await Bill.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          dueDate: { $gte: startOfDay, $lte: endOfDay },
          balanceAmount: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } },
          count: { $sum: 1 },
        },
      },
    ]);
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "Error fetching today's payables");
  }
};

const getDashboardBillData = async (query, filter) => {
  try {
    const companyId = filter.companyId;

    let billDateFilter = {};
    let paymentDateFilter = {};

    if (query.startDate && query.endDate) {
      const start = new Date(query.startDate);
      const end = new Date(query.endDate);

      billDateFilter.billDate = { $gte: start, $lte: end };
      paymentDateFilter.paymentDate = { $gte: start, $lte: end };
    } else {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      billDateFilter.billDate = { $gte: firstDay, $lte: lastDay };
      paymentDateFilter.paymentDate = { $gte: firstDay, $lte: lastDay };
    }

    const [topVendorsByBalance, recentPaymentsMade, upcomingPayables, overdueBills, totalPayable, todaysPayable] =
      await Promise.all([
        getTopVendorsByBalance(companyId, billDateFilter),
        getRecentPaymentsMade(companyId, paymentDateFilter),
        getUpcomingPayables(companyId, billDateFilter),
        getOverdueBills(companyId, billDateFilter),
        creditorsReport({ companyId: new mongoose.Types.ObjectId(companyId), isSplit: false, withZeroBalance: false }),
        getTodaysPayables(companyId),
      ]);

    const totalSummary = totalPayable.reduce(
      (acc, c) => {
        acc.count++;
        acc.totalAmount += c.netPayable || 0;
        acc.overdueBillTotal += c.overdueBillTotal || 0;
        return acc;
      },
      { _id: null, count: 0, totalAmount: 0, overdueBillTotal: 0 },
    );

    return {
      topVendorsByBalance,
      recentPaymentsMade,
      upcomingPayables,
      overdueBills,
      totalPayable: [totalSummary],
      todaysPayable,
    };
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching dashboard bill data');
  }
};

module.exports = {
  getDashboardBillData,
};
