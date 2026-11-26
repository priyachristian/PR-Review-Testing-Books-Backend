const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const { successResponse } = require('../../../services/response.service');
const salesDashboardService = require('./salesDashboard.service');
const { SALES_DASHBOARD_MESSAGES } = require('../../../utils/messages');

const FILTER_KEYS = ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'userId', 'isSplit'];

const getSummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const { result } = await salesDashboardService.getSummary(filter);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_SUMMARY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSummary',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getStateWise = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const options = pick(req.query, ['sortBy']);
    const { result, ...otherdetails } = await salesDashboardService.getStateWise(filter, options);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_STATE_WISE_SUCCESS, httpStatus.OK, otherdetails);
  },
  {
    service: 'getStateWise',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_STATE_WISE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCityWise = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'state']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, ...otherdetails } = await salesDashboardService.getCityWise(filter, options);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_CITY_WISE_SUCCESS, httpStatus.OK, otherdetails);
  },
  {
    service: 'getCityWise',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_CITY_WISE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerWise = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, ...otherdetails } = await salesDashboardService.getCustomerWise(filter, options);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMER_WISE_SUCCESS, httpStatus.OK, otherdetails);
  },
  {
    service: 'getCustomerWise',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMER_WISE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemWise = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, ...otherdetails } = await salesDashboardService.getItemWise(filter, options);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_ITEM_WISE_SUCCESS, httpStatus.OK, otherdetails);
  },
  {
    service: 'getItemWise',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_ITEM_WISE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getStateWiseGraph = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const result = await salesDashboardService.getStateWiseGraph(filter);

    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_STATE_WISE_GRAPH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getStateWiseGraph',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_STATE_WISE_GRAPH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getOrderInvoicePaymentTrend = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const result = await salesDashboardService.getOrderInvoicePaymentTrend(filter);

    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_ORDER_INVOICE_PAYMENT_TREND_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getOrderInvoicePaymentTrend',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_ORDER_INVOICE_PAYMENT_TREND_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getOrderStatusSummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const result = await salesDashboardService.getOrderStatusSummary(filter);

    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_ORDER_STATUS_SUMMARY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getOrderStatusSummary',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_ORDER_STATUS_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemWiseDetails = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'tab']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, ...otherdetails } = await salesDashboardService.getItemWiseDetails(req.params.itemId, filter, options);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_ITEM_WISE_DETAILS_SUCCESS, httpStatus.OK, otherdetails);
  },
  {
    service: 'getItemWiseDetails',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_ITEM_WISE_DETAILS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerWiseDetails = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, ...otherdetails } = await salesDashboardService.getCustomerWiseDetails(
      req.params.customerId,
      filter,
      options,
    );
    return successResponse(
      res,
      result,
      SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMER_WISE_DETAILS_SUCCESS,
      httpStatus.OK,
      otherdetails,
    );
  },
  {
    service: 'getCustomerWiseDetails',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMER_WISE_DETAILS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getStateWiseDetails = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'tab']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, ...otherdetails } = await salesDashboardService.getStateWiseDetails(req.params.stateId, filter, options);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_STATE_WISE_DETAILS_SUCCESS, httpStatus.OK, otherdetails);
  },
  {
    service: 'getStateWiseDetails',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_STATE_WISE_DETAILS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'state', 'city']);
    const { result } = await salesDashboardService.getCustomers(filter);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMERS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomers',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMERS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getInactiveCustomers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'state', 'city']);
    const { result } = await salesDashboardService.getInactiveCustomers(filter);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_INACTIVE_CUSTOMERS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getInactiveCustomers',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_INACTIVE_CUSTOMERS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getNonOrderCustomers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const { result } = await salesDashboardService.getNonOrderCustomers(filter);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_NON_ORDER_CUSTOMERS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getNonOrderCustomers',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_NON_ORDER_CUSTOMERS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getNonOrderCustomerList = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'state', 'city']);
    const { result } = await salesDashboardService.getNonOrderCustomerList(filter);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_NON_ORDER_CUSTOMER_LIST_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getNonOrderCustomerList',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_NON_ORDER_CUSTOMER_LIST_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerInvoices = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'customerId']);
    const { result } = await salesDashboardService.getCustomerInvoices(filter);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMER_INVOICES_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomerInvoices',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_CUSTOMER_INVOICES_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemGroupAnalytics = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const { result } = await salesDashboardService.getItemGroupAnalytics(filter);
    return successResponse(res, result, SALES_DASHBOARD_MESSAGES.FETCH_ITEM_GROUP_ANALYTICS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemGroupAnalytics',
    controller: 'salesDashboard',
    failureMessage: SALES_DASHBOARD_MESSAGES.FETCH_ITEM_GROUP_ANALYTICS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getSummary,
  getStateWise,
  getCityWise,
  getCustomerWise,
  getItemWise,
  getStateWiseGraph,
  getOrderInvoicePaymentTrend,
  getOrderStatusSummary,
  getCustomers,
  getInactiveCustomers,
  getNonOrderCustomers,
  getNonOrderCustomerList,
  getCustomerInvoices,
  getItemGroupAnalytics,
  getItemWiseDetails,
  getCustomerWiseDetails,
  getStateWiseDetails,
};
