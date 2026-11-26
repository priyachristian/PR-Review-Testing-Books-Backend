const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const productionReportService = require('./productionReport.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { MONTHLY_PRODUCTION_REPORT } = require('../../../utils/messages');

const getMonthlySummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'year', 'branchId', 'divisionId']);
    const { result } = await productionReportService.getMonthlySummary(filter);
    return successResponse(res, result, MONTHLY_PRODUCTION_REPORT.FETCH_SUMMARY_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getMonthlySummary',
    controller: 'productionReport',
    failureMessage: MONTHLY_PRODUCTION_REPORT.FETCH_SUMMARY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMonthlyDetailOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'year',
      'month',
      'branchId',
      'divisionId',
      'page',
      'limit',
      'sortBy',
      'pagination',
    ]);
    const { result, kpis, ...pagination } = await productionReportService.getMonthlyDetailOrders(filter);
    return successResponse(res, result, MONTHLY_PRODUCTION_REPORT.FETCH_DETAIL_ORDERS_SUCCESS, httpStatus.OK, {
      kpis,
      ...pagination,
    });
  },
  {
    service: 'getMonthlyDetailOrders',
    controller: 'productionReport',
    failureMessage: MONTHLY_PRODUCTION_REPORT.FETCH_DETAIL_ORDERS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMonthlyDetailByItem = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'year', 'month', 'branchId', 'divisionId', 'page', 'limit', 'pagination']);
    const { result, kpis, ...pagination } = await productionReportService.getMonthlyDetailByItem(filter);
    return successResponse(res, result, MONTHLY_PRODUCTION_REPORT.FETCH_DETAIL_BY_ITEM_SUCCESS, httpStatus.OK, {
      kpis,
      ...pagination,
    });
  },
  {
    service: 'getMonthlyDetailByItem',
    controller: 'productionReport',
    failureMessage: MONTHLY_PRODUCTION_REPORT.FETCH_DETAIL_BY_ITEM_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getMonthlySummary,
  getMonthlyDetailOrders,
  getMonthlyDetailByItem,
};
