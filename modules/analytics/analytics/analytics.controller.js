const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const analyticsService = require('./analytics.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { ANALYTICS } = require('../../../utils/messages');

const topCustomersOfSales = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'isSplit',
      'page',
      'limit',
      'sortBy',
      'itemId',
      'itemGroupId',
    ]);
    const { result, otherDetails } = await analyticsService.topCustomersOfSales(filter);
    return successResponse(res, result, ANALYTICS.FETCH_TOP_SALES_CUSTOMERS_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'topCustomersOfSales',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_TOP_SALES_CUSTOMERS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const topItemsOfSales = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'isSplit',
      'page',
      'limit',
      'sortBy',
      'customerId',
      'itemGroupId',
    ]);
    const { result, otherDetails } = await analyticsService.topItemsOfSales(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'topItemsOfSales',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const topPurchasedItems = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'isSplit',
      'page',
      'limit',
      'sortBy',
    ]);
    const { result, otherDetails } = await analyticsService.topPurchasedItems(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'topPurchasedItems',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const topPurchaseOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit']);
    const { result, otherDetails } = await analyticsService.topPurchaseOrders(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'topPurchaseOrders',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const topVendorsOfPurchase = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'isSplit',
      'page',
      'limit',
      'sortBy',
    ]);
    const { result, otherDetails } = await analyticsService.topVendorsOfPurchase(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'topVendorsOfPurchase',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const topCustomersByBalance = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.topCustomersByBalance(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'topCustomersByBalance',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const recentPayments = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.recentPayments(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'recentPayments',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const upcomingReceivables = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.upcomingReceivables(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'upcomingReceivables',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const overdueInvoices = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.overdueInvoices(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'overdueInvoices',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const itemProcessAnalytics = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'itemId', 'process', 'pagination', 'page', 'limit']);
    const { result, otherDetails } = await analyticsService.itemProcessAnalytics(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'itemProcessAnalytics',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const topVendorsByBalance = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.topVendorsByBalance(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'topVendorsByBalance',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const recentPaymentsMade = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.recentPaymentsMade(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'recentPaymentsMade',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const upcomingPayables = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.upcomingPayables(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'upcomingPayables',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const overdueBills = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.overdueBills(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'overdueBills',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const customersWithSingleInvoice = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'page', 'limit', 'isSplit']);
    const { result, otherDetails } = await analyticsService.customersWithSingleInvoice(filter);
    return successResponse(res, result, ANALYTICS.FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'customersWithSingleInvoice',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createGeneralSalesAnalytics = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const doc = await analyticsService.createGeneralSalesAnalytics(req.body, companyId, req.user?._id);
    return successResponse(res, doc, ANALYTICS.CREATE_SUCCESS, httpStatus.CREATED, {});
  },
  {
    service: 'createGeneralSalesAnalytics',
    controller: 'analytics',
    failureMessage: ANALYTICS.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getGeneralSalesAnalytics = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const list = await analyticsService.getGeneralSalesAnalytics(companyId);
    return successResponse(res, list, ANALYTICS.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getGeneralSalesAnalytics',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getGeneralSalesAnalyticsById = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const filter = pick(req.query, ['startDate', 'endDate', 'page', 'limit']);
    const { result, ...pagination } = await analyticsService.getGeneralSalesAnalyticsByIdWithData(
      req.params.id,
      companyId,
      filter,
    );
    return successResponse(res, result, ANALYTICS.FETCH_ONE_SUCCESS, httpStatus.OK, pagination);
  },
  {
    service: 'getGeneralSalesAnalyticsById',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateGeneralSalesAnalytics = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const body = pick(req.body, ['reportName', 'reportBasis', 'basisIds', 'documents']);
    const doc = await analyticsService.updateGeneralSalesAnalytics(req.params.id, body, companyId, req.user?._id);
    return successResponse(res, doc, ANALYTICS.UPDATE_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'updateGeneralSalesAnalytics',
    controller: 'analytics',
    failureMessage: ANALYTICS.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteGeneralSalesAnalytics = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await analyticsService.deleteGeneralSalesAnalytics(req.params.id, companyId);
    return successResponse(res, null, ANALYTICS.DELETE_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'deleteGeneralSalesAnalytics',
    controller: 'analytics',
    failureMessage: ANALYTICS.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const partyWiseBusinessPerformance = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'customerId',
      'addedBy',
      'state',
      'city',
      'page',
      'limit',
      'sortBy',
    ]);
    const { result, otherDetails } = await analyticsService.partyWiseBusinessPerformance(filter);
    return successResponse(res, result, ANALYTICS.FETCH_PARTY_WISE_BUSINESS_PERFORMANCE_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'partyWiseBusinessPerformance',
    controller: 'analytics',
    failureMessage: ANALYTICS.FETCH_PARTY_WISE_BUSINESS_PERFORMANCE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const exportPartyWiseBusinessPerformance = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'customerId',
      'addedBy',
      'state',
      'city',
      'sortBy',
      'fileName',
    ]);
    await analyticsService.exportPartyWiseBusinessPerformance(filter, res);
  },
  {
    service: 'exportPartyWiseBusinessPerformance',
    controller: 'analytics',
    failureMessage: ANALYTICS.EXPORT_PARTY_WISE_BUSINESS_PERFORMANCE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  topCustomersOfSales,
  topItemsOfSales,
  topPurchasedItems,
  topPurchaseOrders,
  topVendorsOfPurchase,
  topCustomersByBalance,
  recentPayments,
  upcomingReceivables,
  overdueInvoices,
  itemProcessAnalytics,
  topVendorsByBalance,
  recentPaymentsMade,
  upcomingPayables,
  overdueBills,
  customersWithSingleInvoice,
  createGeneralSalesAnalytics,
  getGeneralSalesAnalytics,
  getGeneralSalesAnalyticsById,
  updateGeneralSalesAnalytics,
  deleteGeneralSalesAnalytics,
  partyWiseBusinessPerformance,
  exportPartyWiseBusinessPerformance,
};
