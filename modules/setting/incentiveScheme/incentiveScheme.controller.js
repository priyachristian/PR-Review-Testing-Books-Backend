const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const incentiveSchemeService = require('./incentiveScheme.service');
const { successResponse } = require('../../../services/response.service');
const { INCENTIVE_SCHEME_MESSAGES } = require('../../../utils/messages');

const createIncentiveScheme = catchAsync(
  async (req, res) => {
    const scheme = await incentiveSchemeService.createIncentiveScheme({
      ...req.body,
      companyId: req.query.companyId,
      createdBy: req.user._id,
    });
    return successResponse(res, scheme, INCENTIVE_SCHEME_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createIncentiveScheme',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getIncentiveSchemes = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'status', 'userId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await incentiveSchemeService.queryIncentiveSchemes(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryIncentiveSchemes',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getIncentiveScheme = catchAsync(
  async (req, res) => {
    const scheme = await incentiveSchemeService.getIncentiveSchemeById(req.params.schemeId, req.query.companyId);
    return successResponse(res, scheme, INCENTIVE_SCHEME_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getIncentiveSchemeById',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateIncentiveScheme = catchAsync(
  async (req, res) => {
    const scheme = await incentiveSchemeService.updateIncentiveSchemeById(req.params.schemeId, req.query.companyId, req.body);
    return successResponse(res, scheme, INCENTIVE_SCHEME_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateIncentiveSchemeById',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateIncentiveSchemeStatus = catchAsync(
  async (req, res) => {
    const scheme = await incentiveSchemeService.updateSchemeStatus(req.params.schemeId, req.query.companyId, req.body.status);
    return successResponse(res, scheme, INCENTIVE_SCHEME_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateSchemeStatus',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteIncentiveScheme = catchAsync(
  async (req, res) => {
    await incentiveSchemeService.deleteIncentiveSchemeById(req.params.schemeId, req.query.companyId);
    return successResponse(res, {}, INCENTIVE_SCHEME_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteIncentiveSchemeById',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSchemeConsumption = catchAsync(
  async (req, res) => {
    const data = await incentiveSchemeService.getSchemeConsumption(req.params.schemeId, req.query.companyId);
    return successResponse(res, data, INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSchemeConsumption',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSchemeSummary = catchAsync(
  async (req, res) => {
    const data = await incentiveSchemeService.getSchemeSummary(req.query.companyId);
    return successResponse(res, data, INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSchemeSummary',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getIncentiveLogs = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'schemeId', 'userId', 'docType', 'status']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await incentiveSchemeService.queryIncentiveLogs(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryIncentiveLogs',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateLogStatus = catchAsync(
  async (req, res) => {
    const log = await incentiveSchemeService.updateLogStatus(
      req.params.logId,
      req.query.companyId,
      req.body.status,
      req.user._id,
    );
    return successResponse(res, log, INCENTIVE_SCHEME_MESSAGES.LOG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateLogStatus',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.LOG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteIncentiveLog = catchAsync(
  async (req, res) => {
    await incentiveSchemeService.deleteIncentiveLog(req.params.logId, req.query.companyId);
    return successResponse(res, {}, INCENTIVE_SCHEME_MESSAGES.LOG_DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteIncentiveLog',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.LOG_DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const bulkSettleLogs = catchAsync(
  async (req, res) => {
    await incentiveSchemeService.bulkSettleLogs(req.body.schemeId, req.body.userId, req.query.companyId, req.user._id);
    return successResponse(res, {}, INCENTIVE_SCHEME_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'bulkSettleLogs',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getUserIncentiveSchemes = catchAsync(
  async (req, res) => {
    const data = await incentiveSchemeService.getUserIncentiveSchemes(req.params.userId, req.query.companyId);

    return successResponse(res, data, INCENTIVE_SCHEME_MESSAGES.USER_INCENTIVE_SCHEMES_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getUserIncentiveSchemes',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.USER_INCENTIVE_SCHEMES_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTeamStats = catchAsync(
  async (req, res) => {
    const data = await incentiveSchemeService.getTeamStats(req.query.companyId);
    return successResponse(res, data, INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTeamStats',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getUserStatsDetail = catchAsync(
  async (req, res) => {
    const data = await incentiveSchemeService.getUserStatsDetail(req.query.companyId, req.user._id);
    return successResponse(res, data, INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getUserStats',
    controller: 'incentiveScheme',
    failureMessage: INCENTIVE_SCHEME_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createIncentiveScheme,
  getIncentiveSchemes,
  getIncentiveScheme,
  updateIncentiveScheme,
  updateIncentiveSchemeStatus,
  deleteIncentiveScheme,
  getSchemeConsumption,
  getSchemeSummary,
  getIncentiveLogs,
  updateLogStatus,
  deleteIncentiveLog,
  bulkSettleLogs,
  getUserIncentiveSchemes,
  getTeamStats,
  getUserStatsDetail,
};
