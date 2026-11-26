const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const reportService = require('./report.service');
const reportTransformer = require('./report.transformer');
const { successResponse } = require('../../../services/response.service');
const { LEDGER_MESSAGES, BANK_HISTORY_MESSAGES, REPORT_MESSAGES } = require('../../../utils/messages');
const pick = require('../../../utils/pick');

const getLedgerReport = catchAsync(
  async (req, res) => {
    const ledgerData = await reportService.getLedgerReport(req.query);
    return successResponse(res, ledgerData, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getLedgerReport',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const invoiceBarGraph = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'FY', 'divisionId', 'branchId', 'isSplit']);
    const invoiceData = await reportService.invoiceBarGraph(filter);
    return successResponse(res, invoiceData, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'invoiceBarGraph',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const invoiceBarGraphDetail = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'divisionId',
      'branchId',
      'sortField',
      'sortOrder',
      'isSplit',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const invoiceData = await reportService.invoiceBarGraphDetail(filter, options);
    const { results, ...otherFields } = invoiceData;
    const transformedReport = reportTransformer.invoiceBarGraphDetail(results);
    return successResponse(res, transformedReport, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, { ...otherFields });
  },
  {
    service: 'invoiceBarGraphDetail',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const billBarGraph = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'FY', 'divisionId', 'branchId', 'isSplit']);
    const billData = await reportService.billBarGraph(filter);
    return successResponse(res, billData, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'billBarGraph',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const billBarGraphDetail = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'divisionId',
      'branchId',
      'sortField',
      'sortOrder',
      'isSplit',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const billData = await reportService.billBarGraphDetail(filter, options);
    const { results, ...otherFields } = billData;
    const transformedReport = reportTransformer.billBarGraphDetail(results);
    return successResponse(res, transformedReport, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, { ...otherFields });
  },
  {
    service: 'billBarGraphDetail',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const creditorsReport = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'divisionId',
      'branchId',
      'isSplit',
      'withZeroBalance',
      'splitOnly',
      'column',
      'includeLinkedData',
    ]);
    const report = await reportService.creditorsReport(filter);
    return successResponse(res, report, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'creditorsReport',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const debtorsReport = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'divisionId',
      'branchId',
      'isSplit',
      'withZeroBalance',
      'splitOnly',
      'column',
      'includeLinkedData',
    ]);
    const report = await reportService.debtorsReport(filter);
    return successResponse(res, report, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'debtorsReport',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBankHistory = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'accountId',
      'divisionId',
      'branchId',
      'customerId',
      'date',
      'startDate',
      'endDate',
      'isSplit',
      'sortOrder',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await reportService.queryBankHistories(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, BANK_HISTORY_MESSAGES.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryBankHistories',
    controller: 'report',
    failureMessage: BANK_HISTORY_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const itemModulewiseDetails = catchAsync(
  async (req, res) => {
    const query = pick(req.query, [
      'companyId',
      'itemId',
      'moduleName',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'page',
      'limit',
      'isSplit',
    ]);
    const result = await reportService.itemModulewiseDetails(query);
    return successResponse(res, result, LEDGER_MESSAGES.FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'itemModulewiseDetails',
    controller: 'report',
    failureMessage: LEDGER_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);
/**
 * Get Balance Sheet Summary with Full Ledger Transaction Data
 *
 * @param {Object} req - Express request object
 * @param {Object} req.query - Query parameters
 * @param {string} req.query.companyId - Company ID (required)
 * @param {string} req.query.startDate - Period start date (required)
 * @param {string} req.query.endDate - Period end date (required)
 * @param {string} [req.query.category] - Filter by specific category
 * @param {string} [req.query.branchId] - Filter by branch (comma-separated)
 * @param {string} [req.query.divisionId] - Filter by division
 * @param {Object} res - Express response object
 * @returns {Object} Hierarchical balance sheet with ledger transactions
 */
const getBalanceSheetSummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'category', 'branchId', 'divisionId']);
    const result = await reportService.getBalanceSheetSummary(filter);
    return successResponse(res, result, REPORT_MESSAGES.BALANCE_SHEET_FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getBalanceSheetSummary',
    controller: 'report',
    failureMessage: REPORT_MESSAGES.BALANCE_SHEET_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProfitLossSheet = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'productId',
      'categoryId',
      'warehouseId',
      'branchId',
      'divisionId',
    ]);
    const result = await reportService.getProfitLossSheet(filter);
    return successResponse(res, result, REPORT_MESSAGES.PROFIT_LOSS_SHEET_FETCH_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getProfitLossSheet',
    controller: 'report',
    failureMessage: REPORT_MESSAGES.PROFIT_LOSS_SHEET_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getLedgerReport,
  invoiceBarGraph,
  invoiceBarGraphDetail,
  billBarGraph,
  billBarGraphDetail,
  creditorsReport,
  debtorsReport,
  getBankHistory,
  itemModulewiseDetails,
  getBalanceSheetSummary,
  getProfitLossSheet,
};
