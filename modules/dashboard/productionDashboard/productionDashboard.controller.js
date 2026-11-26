const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const { successResponse } = require('../../../services/response.service');
const service = require('./productionDashboard.service');

const FILTER_KEYS = ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId'];

const getSummary = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const result = await service.getSummary(filter);
    return successResponse(res, result, 'Production dashboard summary fetched', httpStatus.OK);
  },
  {
    service: 'getSummary',
    controller: 'productionDashboard',
    failureMessage: 'Failed to fetch summary',
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPipeline = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const result = await service.getPipeline(filter);
    return successResponse(res, result, 'Pipeline fetched', httpStatus.OK);
  },
  {
    service: 'getPipeline',
    controller: 'productionDashboard',
    failureMessage: 'Failed to fetch pipeline',
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSalesOrderFunnel = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, FILTER_KEYS);
    const result = await service.getSalesOrderFunnel(filter);
    return successResponse(res, result, 'Sales funnel fetched', httpStatus.OK);
  },
  {
    service: 'getSalesOrderFunnel',
    controller: 'productionDashboard',
    failureMessage: 'Failed to fetch sales funnel',
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTrend = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'groupBy']);
    const result = await service.getTrend(filter);
    return successResponse(res, result, 'Trend fetched', httpStatus.OK);
  },
  {
    service: 'getTrend',
    controller: 'productionDashboard',
    failureMessage: 'Failed to fetch trend',
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTopItems = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [...FILTER_KEYS, 'limit']);
    const result = await service.getTopItems(filter);
    return successResponse(res, result, 'Top items fetched', httpStatus.OK);
  },
  {
    service: 'getTopItems',
    controller: 'productionDashboard',
    failureMessage: 'Failed to fetch top items',
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = { getSummary, getPipeline, getSalesOrderFunnel, getTrend, getTopItems };
