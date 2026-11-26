const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const profitLossService = require('./profitLoss.service');
const { successResponse } = require('../../../services/response.service');
const { PROFIT_LOSS_MESSAGES } = require('../../../utils/messages');

const getProfitLossByCustomer = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'customerId', 'startDate', 'endDate', 'branchId', 'divisionId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getProfitLossByCustomer(filter, options);

    // Extract summary and pagination info into extras (flattened)
    const { summary, pagination, ...data } = result;
    const extras = {
      summary,
      ...(pagination
        ? {
            totalResults: pagination.totalResults ?? pagination.total ?? 0,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: pagination.totalPages,
            totalRecords: pagination.totalRecords ?? pagination.total ?? 0,
          }
        : {}),
    };
    return successResponse(res, data, PROFIT_LOSS_MESSAGES.FETCH_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getProfitLossByCustomer',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProfitLossSummaryByCustomer = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'customerId', 'startDate', 'endDate', 'branchId', 'divisionId', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getProfitLossSummaryByCustomer(filter, options);

    // Extract summary and pagination info and add to extras
    const { summary, pagination, ...data } = result;
    const extras = {
      summary,
      ...(pagination
        ? {
            totalResults: pagination.totalResults,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: pagination.totalPages,
            totalRecords: pagination.totalRecords,
          }
        : {}),
    };
    return successResponse(res, data, PROFIT_LOSS_MESSAGES.FETCH_SUMMARY_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getProfitLossSummaryByCustomer',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProfitLossSummaryByItem = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'itemId',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'search',
      'itemType',
      'itemGroup',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);

    const result = await profitLossService.getProfitLossSummaryByItem(filter, options);

    // Extract summary and pagination info and add to extras
    const { summary, pagination, ...data } = result;
    const extras = {
      summary,
      ...(pagination
        ? {
            totalResults: pagination.totalResults,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: pagination.totalPages,
            totalRecords: pagination.totalRecords,
          }
        : {}),
    };
    return successResponse(res, data, PROFIT_LOSS_MESSAGES.FETCH_ITEM_SUMMARY_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getProfitLossSummaryByItem',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_ITEM_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProfitLossByItem = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'itemId', 'startDate', 'endDate', 'branchId', 'divisionId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getProfitLossByItem(filter, options);

    // Extract summary and pagination info and add to extras
    const { summary, pagination, ...data } = result;
    const extras = {
      summary,
      ...(pagination
        ? {
            totalResults: pagination.totalResults,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: pagination.totalPages,
            totalRecords: pagination.totalRecords,
          }
        : {}),
    };
    return successResponse(res, data, PROFIT_LOSS_MESSAGES.FETCH_ITEM_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getProfitLossByItem',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_ITEM_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProfitLossByCustomerMonthWise = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getProfitLossByCustomerMonthWise(filter, options);

    // Extract summary and pagination info and add to extras
    const { summary, pagination, ...data } = result;
    const extras = {
      summary,
      ...(pagination
        ? {
            totalResults: pagination.totalResults,
            page: pagination.page,
            limit: pagination.limit,
            totalPages: pagination.totalPages,
            totalRecords: pagination.totalRecords,
          }
        : {}),
    };
    return successResponse(res, data, PROFIT_LOSS_MESSAGES.FETCH_CUSTOMER_MONTH_WISE_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getProfitLossByCustomerMonthWise',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_CUSTOMER_MONTH_WISE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDocumentDetails = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'documentId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getDocumentDetails(filter, options);

    // Extract summary and add to extras
    const { summary, ...data } = result;
    const extras = {
      summary,
    };

    return successResponse(res, data, PROFIT_LOSS_MESSAGES.FETCH_DOCUMENT_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getDocumentDetails',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_DOCUMENT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDocumentDetailsByItemId = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'documentId', 'itemId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getDocumentDetailsByItemId(filter, options);

    // Extract summary and add to extras
    const { summary, ...data } = result;
    const extras = {
      summary,
    };

    return successResponse(res, data, PROFIT_LOSS_MESSAGES.FETCH_DOCUMENT_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getDocumentDetailsByItemId',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_DOCUMENT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProductionOrderDetails = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'productionOrderId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getProductionOrderDetails(filter, options);
    return successResponse(res, result, PROFIT_LOSS_MESSAGES.FETCH_PRODUCTION_ORDER_DETAILS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProductionOrderDetails',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_PRODUCTION_ORDER_DETAILS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProductionOrderDetails_v2 = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'productionOrderId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await profitLossService.getProductionOrderDetails_v2(filter, options);
    return successResponse(res, result, PROFIT_LOSS_MESSAGES.FETCH_PRODUCTION_ORDER_DETAILS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProductionOrderDetails_v2',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_PRODUCTION_ORDER_DETAILS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBatchSourceDetailsBulk = catchAsync(
  async (req, res) => {
    const filter = {
      ...pick(req.body, ['itemId', 'batches']),
      companyId: req.query.companyId,
    };
    const result = await profitLossService.getBatchSourceDetailsBulk(filter);
    return successResponse(res, result.data, PROFIT_LOSS_MESSAGES.FETCH_BATCH_SOURCE_BULK_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBatchSourceDetailsBulk',
    controller: 'profitLoss',
    failureMessage: PROFIT_LOSS_MESSAGES.FETCH_BATCH_SOURCE_BULK_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getProfitLossByCustomer,
  getProfitLossSummaryByCustomer,
  getProfitLossSummaryByItem,
  getProfitLossByItem,
  getProfitLossByCustomerMonthWise,
  getDocumentDetails,
  getDocumentDetailsByItemId,
  getProductionOrderDetails,
  getProductionOrderDetails_v2,
  getBatchSourceDetailsBulk,
};
