const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const itemGroupAnalyticsConfig = require('./itemGroupAnalyticsConfig.service');
const { successResponse } = require('../../../services/response.service');
const { ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES } = require('../../../utils/messages');

const createItemGroupAnalyticsConfig = catchAsync(
  async (req, res) => {
    const config = await itemGroupAnalyticsConfig.createItemGroupAnalyticsConfig({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, config, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createItemGroupAnalyticsConfig',
    controller: 'itemGroupAnalyticsConfig',
    failureMessage: ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemGroupAnalyticsConfigs = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['itemGroupId', 'companyId', 'startDate', 'endDate', 'isSplit', 'divisionId', 'branchId']);
    const result = await itemGroupAnalyticsConfig.queryItemGroupAnalyticsConfigs(filter);
    return successResponse(res, result, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryItemGroupAnalyticsConfigs',
    controller: 'itemGroupAnalyticsConfig',
    failureMessage: ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateItemGroupAnalyticsConfig = catchAsync(
  async (req, res) => {
    const config = await itemGroupAnalyticsConfig.updateItemGroupAnalyticsConfigById(
      req.params.itemGroupAnalyticsConfigId,
      req.body,
      req.query?.companyId,
    );
    return successResponse(res, config, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateItemGroupAnalyticsConfigById',
    controller: 'itemGroupAnalyticsConfig',
    failureMessage: ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteItemGroupAnalyticsConfig = catchAsync(
  async (req, res) => {
    await itemGroupAnalyticsConfig.deleteItemGroupAnalyticsConfigById(req.params.itemGroupAnalyticsConfigId, req.query.companyId);
    return successResponse(res, {}, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteItemGroupAnalyticsConfigById',
    controller: 'itemGroupAnalyticsConfig',
    failureMessage: ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getAnalyticsByItemGroupId = catchAsync(
  async (req, res) => {
    const { itemGroupId } = req.params;
    const { companyId, startDate, endDate, divisionId, branchId, isSplit } = req.query;
    const analytics = await itemGroupAnalyticsConfig.getAnalyticsByItemGroupId(itemGroupId, companyId, {
      startDate,
      endDate,
      divisionId,
      branchId,
      isSplit,
    });
    return successResponse(res, analytics, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAnalyticsByItemGroupId',
    controller: 'itemGroupAnalyticsConfig',
    failureMessage: ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createItemGroupAnalyticsConfig,
  getItemGroupAnalyticsConfigs,
  updateItemGroupAnalyticsConfig,
  deleteItemGroupAnalyticsConfig,
  getAnalyticsByItemGroupId,
};
