const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const rejectionAnalyticsService = require('./rejectionAnalytics.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { REJECTION_ANALYTICS } = require('../../../utils/messages');

const BASE_FILTER_KEYS = ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'itemId', 'productionManageMethod'];

const getRejectionSummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, BASE_FILTER_KEYS);
    const { result } = await rejectionAnalyticsService.getRejectionSummary(filter);
    return successResponse(res, result, REJECTION_ANALYTICS.FETCH_SUMMARY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionSummary',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.FETCH_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRejectionTrend = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...BASE_FILTER_KEYS, 'groupBy']);
    const { result } = await rejectionAnalyticsService.getRejectionTrend(filter);
    return successResponse(res, result, REJECTION_ANALYTICS.FETCH_TREND_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionTrend',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.FETCH_TREND_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRejectionByItem = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, BASE_FILTER_KEYS);
    const { result } = await rejectionAnalyticsService.getRejectionByItem(filter);
    return successResponse(res, result, REJECTION_ANALYTICS.FETCH_BY_ITEM_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionByItem',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.FETCH_BY_ITEM_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRejectionByRawMaterial = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, BASE_FILTER_KEYS);
    const { result } = await rejectionAnalyticsService.getRejectionByRawMaterial(filter);
    return successResponse(res, result, REJECTION_ANALYTICS.FETCH_BY_RAW_MATERIAL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionByRawMaterial',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.FETCH_BY_RAW_MATERIAL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRejectionByProcess = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, BASE_FILTER_KEYS);
    const { result } = await rejectionAnalyticsService.getRejectionByProcess(filter);
    return successResponse(res, result, REJECTION_ANALYTICS.FETCH_BY_PROCESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionByProcess',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.FETCH_BY_PROCESS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRejectionByBranch = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, BASE_FILTER_KEYS);
    const { result } = await rejectionAnalyticsService.getRejectionByBranch(filter);
    return successResponse(res, result, REJECTION_ANALYTICS.FETCH_BY_BRANCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionByBranch',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.FETCH_BY_BRANCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const itemRejectionReportOfProductionOrder = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'itemId', 'itemType', 'startDate', 'endDate', 'pagination', 'page', 'limit']);
    const { otherDetails, ...result } = await rejectionAnalyticsService.itemRejectionReportOfProductionOrder(filter);
    return successResponse(res, result, REJECTION_ANALYTICS.ITEM_REJECTION_REPORT_FETCH_SUCCESS, httpStatus.OK, otherDetails);
  },
  {
    service: 'itemRejectionReportOfProductionOrder',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.ITEM_REJECTION_REPORT_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const itemRejectionProductionOrderList = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'itemId', 'startDate', 'endDate']);
    const result = await rejectionAnalyticsService.itemRejectionProductionOrderList(filter);
    return successResponse(
      res,
      result,
      REJECTION_ANALYTICS.ITEM_REJECTION_PRODUCTION_ORDER_LIST_FETCH_SUCCESS,
      httpStatus.OK,
      {},
    );
  },
  {
    service: 'itemRejectionProductionOrderList',
    controller: 'rejectionAnalytics',
    failureMessage: REJECTION_ANALYTICS.ITEM_REJECTION_PRODUCTION_ORDER_LIST_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

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
