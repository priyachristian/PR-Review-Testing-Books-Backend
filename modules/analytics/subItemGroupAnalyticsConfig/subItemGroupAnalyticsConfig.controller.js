const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const subItemGroupAnalyticsConfig = require('./subItemGroupAnalyticsConfig.service');
const { successResponse } = require('../../../services/response.service');
const { SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES } = require('../../../utils/messages');

const createSubItemGroupAnalyticsConfig = catchAsync(
  async (req, res) => {
    const config = await subItemGroupAnalyticsConfig.createSubItemGroupAnalyticsConfig({
      ...req.body,
      companyId: req.query.companyId,
    });
    return successResponse(res, config, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createSubItemGroupAnalyticsConfig',
    controller: 'subItemGroupAnalyticsConfig',
    failureMessage: SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getSubItemGroupAnalyticsConfigs = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['subItemGroupId', 'companyId', 'startDate', 'endDate', 'isSplit', 'divisionId', 'branchId']);
    const result = await subItemGroupAnalyticsConfig.querySubItemGroupAnalyticsConfigs(filter);
    return successResponse(res, result, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'querySubItemGroupAnalyticsConfigs',
    controller: 'subItemGroupAnalyticsConfig',
    failureMessage: SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateSubItemGroupAnalyticsConfig = catchAsync(
  async (req, res) => {
    const config = await subItemGroupAnalyticsConfig.updateSubItemGroupAnalyticsConfigById(
      req.params.subItemGroupAnalyticsConfigId,
      req.body,
      req.query?.companyId,
    );
    return successResponse(res, config, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateSubItemGroupAnalyticsConfigById',
    controller: 'subItemGroupAnalyticsConfig',
    failureMessage: SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteSubItemGroupAnalyticsConfig = catchAsync(
  async (req, res) => {
    await subItemGroupAnalyticsConfig.deleteSubItemGroupAnalyticsConfigById(
      req.params.subItemGroupAnalyticsConfigId,
      req.query.companyId,
    );
    return successResponse(res, {}, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteSubItemGroupAnalyticsConfigById',
    controller: 'subItemGroupAnalyticsConfig',
    failureMessage: SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getAnalyticsBySubItemGroupId = catchAsync(
  async (req, res) => {
    const { subItemGroupId } = req.params;
    const { companyId, startDate, endDate, divisionId, branchId, isSplit } = req.query;
    const analytics = await subItemGroupAnalyticsConfig.getAnalyticsBySubItemGroupId(subItemGroupId, companyId, {
      startDate,
      endDate,
      divisionId,
      branchId,
      isSplit,
    });
    return successResponse(res, analytics, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAnalyticsBySubItemGroupId',
    controller: 'subItemGroupAnalyticsConfig',
    failureMessage: SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createSubItemGroupAnalyticsConfig,
  getSubItemGroupAnalyticsConfigs,
  updateSubItemGroupAnalyticsConfig,
  deleteSubItemGroupAnalyticsConfig,
  getAnalyticsBySubItemGroupId,
};
