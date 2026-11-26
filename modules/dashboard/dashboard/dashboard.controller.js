const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const pick = require('../../../utils/pick');
const dashboardService = require('./dashboard.service');
const dashboardSalesOrderService = require('./dashboardSalesOrder.service');
const dashboardPurchaseOrderService = require('./dashboardPurchaseOrder.service');
const dashboardInvoiceService = require('./dashboardInvoice.service');
const dashboardBillService = require('./dashboardBills.service');
const { successResponse } = require('../../../services/response.service');
const { DASHBOARD_MESSAGES, ANALYTICS } = require('../../../utils/messages');

const getDashboardSalesOrderAnalytics = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'orderDate']);
    const analyticsData = await dashboardSalesOrderService.getDashboardSalesOrder(req.query, filter);
    return successResponse(res, analyticsData, DASHBOARD_MESSAGES.FETCH_DASHBOARD_SALESORDER, httpStatus.OK);
  },
  {
    service: 'getDashboardSalesOrder',
    controller: 'dashboard',
    failureMessage: DASHBOARD_MESSAGES.FETCH_SALESORDER_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDashboardPurchaseOrderAnalytics = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'date']);
    const analyticsData = await dashboardPurchaseOrderService.getDashboardPurchaseOrder(req.query, filter);
    return successResponse(res, analyticsData, DASHBOARD_MESSAGES.FETCH_DASHBOARD_PURCHASEORDER, httpStatus.OK);
  },
  {
    service: 'getDashboardPurchaseOrder',
    controller: 'dashboard',
    failureMessage: DASHBOARD_MESSAGES.FETCH_PURCHASEORDER_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDashboardInvoiceAnalytics = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'invoiceDate', 'paymentDate']);
    const analyticsData = await dashboardInvoiceService.getDashboardInvoiceData(req.query, filter);
    return successResponse(res, analyticsData, DASHBOARD_MESSAGES.FETCH_DASHBOARD_INVOICE, httpStatus.OK);
  },
  {
    service: 'getDashboardInvoiceData',
    controller: 'dashboard',
    failureMessage: DASHBOARD_MESSAGES.FETCH_DASHBOARD_INVOICE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDashboardBillAnalytics = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'billDate', 'paymentDate']);
    const analyticsData = await dashboardBillService.getDashboardBillData(req.query, filter);
    return successResponse(res, analyticsData, DASHBOARD_MESSAGES.FETCH_DASHBOARD_BILL, httpStatus.OK);
  },
  {
    service: 'getDashboardBillData',
    controller: 'dashboard',
    failureMessage: DASHBOARD_MESSAGES.FETCH_DASHBOARD_BILL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const top5SalesOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'isSplit']);
    const result = await dashboardService.top5SalesOrders(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'top5SalesOrders',
    controller: 'dashboard',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const top5PurchaseOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'isSplit']);
    const result = await dashboardService.top5PurchaseOrders(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'top5PurchaseOrders',
    controller: 'dashboard',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const top5PaymentReceived = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'isSplit']);
    const result = await dashboardService.top5PaymentReceived(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'top5PaymentReceived',
    controller: 'dashboard',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const top5PaymentMade = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'isSplit']);
    const result = await dashboardService.top5PaymentMade(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'top5PaymentMade',
    controller: 'dashboard',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const top5Expense = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId']);
    const result = await dashboardService.top5Expense(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'top5Expense',
    controller: 'dashboard',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const dashboardSummary = catchAsync(
  async (req, res) => {
    const result = await dashboardService.dashboardSummary(req.query);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'dashboardSummary',
    controller: 'dashboard',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const userWiseSummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'branchId', 'divisionId', 'startDate', 'endDate', 'isSplit']);
    const result = await dashboardService.userWiseSummary(filter);
    return successResponse(res, result, DASHBOARD_MESSAGES.FETCH_USER_WISE_SUMMARY_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'userWiseSummary',
    controller: 'dashboard',
    failureMessage: DASHBOARD_MESSAGES.FETCH_USER_WISE_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getDashboardSalesOrderAnalytics,
  getDashboardPurchaseOrderAnalytics,
  getDashboardInvoiceAnalytics,
  getDashboardBillAnalytics,
  top5SalesOrders,
  top5PurchaseOrders,
  top5PaymentReceived,
  top5PaymentMade,
  top5Expense,
  dashboardSummary,
  userWiseSummary,
};
