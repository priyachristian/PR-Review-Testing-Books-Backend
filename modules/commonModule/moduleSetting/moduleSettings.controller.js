const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const moduleSettingsService = require('./moduleSettings.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { MODULE_SETTINGS_MESSAGES } = require('../../../utils/messages');

const createModuleSettings = catchAsync(
  async (req, res) => {
    const settings = await moduleSettingsService.createModuleSettings({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, settings, MODULE_SETTINGS_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createModuleSettings',
    controller: 'moduleSettings',
    failureMessage: MODULE_SETTINGS_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getModuleSettings = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'moduleName']);
    const settings = await moduleSettingsService.queryModuleSettings(filter);
    return successResponse(res, settings, MODULE_SETTINGS_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryModuleSettings',
    controller: 'moduleSettings',
    failureMessage: MODULE_SETTINGS_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getModuleSettingsByCompanyAndModule = catchAsync(
  async (req, res) => {
    const settings = await moduleSettingsService.getModuleSettings(
      req.query.companyId,
      req.params.moduleName,
      req.query?.customerId,
      req.user._id,
    );
    return successResponse(res, settings, MODULE_SETTINGS_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getModuleSettings',
    controller: 'moduleSettings',
    failureMessage: MODULE_SETTINGS_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateModuleSettings = catchAsync(
  async (req, res) => {
    const settings = await moduleSettingsService.updateModuleSettings(
      req.query.companyId,
      req.params.moduleName,
      req.body,
      req.user._id,
    );
    return successResponse(res, settings, MODULE_SETTINGS_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateModuleSettings',
    controller: 'moduleSettings',
    failureMessage: MODULE_SETTINGS_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteModuleSettings = catchAsync(
  async (req, res) => {
    await moduleSettingsService.deleteModuleSettings(req.query.companyId, req.params.moduleName);
    return successResponse(res, null, MODULE_SETTINGS_MESSAGES.DELETE_SUCCESS, httpStatus.NO_CONTENT);
  },
  {
    service: 'deleteModuleSettings',
    controller: 'moduleSettings',
    failureMessage: MODULE_SETTINGS_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createModuleSettings,
  getModuleSettings,
  getModuleSettingsByCompanyAndModule,
  updateModuleSettings,
  deleteModuleSettings,
};
