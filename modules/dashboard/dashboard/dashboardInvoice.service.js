const mongoose = require('mongoose');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { debtorsReport } = require('../../report/report/report.service');
const ApiError = require('../../../utils/ApiError');
const httpStatus = require('http-status');

const getTopCustomersByBalance = async (companyId, dateFilter) => {
  const { Invoice } = getBooksModels();
  try {
    const topCustomers = await Invoice.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          balanceAmount: { $gt: 0 },
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: '$customerId',
          totalBalance: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } },
          invoiceCount: { $sum: 1 },
        },
      },
      { $sort: { totalBalance: -1 } },
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
          totalBalance: 1,
          invoiceCount: 1,
        },
      },
    ]);

    return topCustomers;
  } catch (error) {
    console.error('Error fetching top customers by balance:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching top customers by balance');
  }
};

const getRecentPayments = async (companyId, dateFilter) => {
  const { PaymentReceived } = getBooksCrmModels();
  try {
    const recentPayments = await PaymentReceived.aggregate([
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
          localField: 'customerId',
          foreignField: '_id',
          as: 'customerDetails',
        },
      },
      { $unwind: { path: '$customerDetails', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          paymentReceivedId: 1,
          customerName: '$customerDetails.customerDisplayName',
          amountReceived: { $multiply: ['$amountReceived', { $ifNull: ['$exchangeRate', 1] }] },
          paymentMode: 1,
          paymentDate: 1,
        },
      },
    ]);

    return recentPayments;
  } catch (error) {
    console.error('Error fetching recent payments:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching recent payments');
  }
};

const getUpcomingReceivables = async (companyId, dateFilter) => {
  const { Invoice } = getBooksModels();
  try {
    const today = new Date();

    const upcomingReceivables = await Invoice.aggregate([
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
          localField: 'customerId',
          foreignField: '_id',
          as: 'customerDetails',
        },
      },
      { $unwind: { path: '$customerDetails', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          invoiceId: 1,
          customerName: '$customerDetails.customerDisplayName',
          dueDate: 1,
          balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
      { $sort: { dueDate: 1 } }, // Soonest due first
      { $limit: 5 },
    ]);

    return upcomingReceivables;
  } catch (error) {
    console.error('Error fetching upcoming receivables:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching upcoming receivables');
  }
};

const getOverdueInvoices = async (companyId, dateFilter) => {
  const { Invoice } = getBooksModels();
  try {
    const today = new Date();

    const overdueInvoices = await Invoice.aggregate([
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
          localField: 'customerId',
          foreignField: '_id',
          as: 'customerDetails',
        },
      },
      { $unwind: { path: '$customerDetails', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          invoiceId: 1,
          customerName: '$customerDetails.customerDisplayName',
          dueDate: 1,
          balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
      { $sort: { dueDate: 1 } },
      { $limit: 5 },
    ]);

    return overdueInvoices;
  } catch (error) {
    console.error('Error fetching overdue invoices:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching overdue invoices');
  }
};

const getTotalReceivables = async (companyId, dateFilter) => {
  const { Invoice } = getBooksModels();
  return await Invoice.aggregate([
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
};

const getTodaysReceivables = async companyId => {
  const { Invoice } = getBooksModels();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  return await Invoice.aggregate([
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
};

const getDashboardInvoiceData = async (query, filter) => {
  try {
    const companyId = filter.companyId;

    let invoiceDateFilter = {};
    let paymentDateFilter = {};

    if (query.startDate && query.endDate) {
      const start = new Date(query.startDate);
      const end = new Date(query.endDate);

      invoiceDateFilter.invoiceDate = { $gte: start, $lte: end };
      paymentDateFilter.paymentDate = { $gte: start, $lte: end };
    } else {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      invoiceDateFilter.invoiceDate = { $gte: firstDay, $lte: lastDay };
      paymentDateFilter.paymentDate = { $gte: firstDay, $lte: lastDay };
    }

    const [topCustomersByBalance, recentPayments, upcomingReceivables, overdueInvoices, totalReceivable, todaysReceivable] =
      await Promise.all([
        getTopCustomersByBalance(companyId, invoiceDateFilter),
        getRecentPayments(companyId, paymentDateFilter),
        getUpcomingReceivables(companyId, invoiceDateFilter),
        getOverdueInvoices(companyId, invoiceDateFilter),
        debtorsReport({ companyId: new mongoose.Types.ObjectId(companyId), isSplit: false, withZeroBalance: false }),
        getTodaysReceivables(companyId),
      ]);

    const totalSummary = totalReceivable.reduce(
      (acc, c) => {
        acc.overdueInvoiceTotal += c.overdueInvoiceTotal || 0;
        acc.count++;
        acc.totalAmount += c.netPayable || 0;
        return acc;
      },
      { _id: null, count: 0, totalAmount: 0, overdueInvoiceTotal: 0 },
    );

    return {
      topCustomersByBalance,
      recentPayments,
      upcomingReceivables,
      overdueInvoices,
      totalReceivable: [totalSummary],
      todaysReceivable,
    };
  } catch (error) {
    console.error('Error fetching dashboard invoice data:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error fetching dashboard invoice data');
  }
};

module.exports = {
  getDashboardInvoiceData,
};
