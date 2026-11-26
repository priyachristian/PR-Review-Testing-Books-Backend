const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const pick = require('../../../utils/pick');
const { successResponse } = require('../../../services/response.service');
const stockSummaryService = require('./stockSummary.service');
const { STOCK_SUMMARY_MESSAGES } = require('../../../utils/messages');

const getStockSummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'fromDate',
      'toDate',
      'branchId',
      'divisionId',
      'warehouseId',
      'itemId',
      'itemGroupId',
      'stockStatus',
      'isSplit',
    ]);
    const options = pick(req.query, ['page', 'limit', 'sortBy', 'pagination']);
    const result = await stockSummaryService.getStockSummary(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, STOCK_SUMMARY_MESSAGES.FETCH_SUMMARY_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getStockSummary',
    controller: 'stockSummary',
    failureMessage: STOCK_SUMMARY_MESSAGES.FETCH_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDateWiseBreakdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'fromDate',
      'toDate',
      'itemId',
      'warehouseId',
      'branchId',
      'divisionId',
      'isSplit',
    ]);
    const options = pick(req.query, ['page', 'limit', 'pagination']);
    const result = await stockSummaryService.getDateWiseBreakdown(filter, options);
    const { rows, openingQty, ...otherFields } = result;
    return successResponse(res, { openingQty, rows }, STOCK_SUMMARY_MESSAGES.FETCH_DATE_WISE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getDateWiseBreakdown',
    controller: 'stockSummary',
    failureMessage: STOCK_SUMMARY_MESSAGES.FETCH_DATE_WISE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = { getStockSummary, getDateWiseBreakdown };
