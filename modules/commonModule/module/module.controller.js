const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const moduleService = require('./module.service');
const { successResponse } = require('../../../services/response.service');
const { MODULE_MESSAGES } = require('../../../utils/messages');

const getModuleTree = catchAsync(
  async (req, res) => {
    const moduleTree = await moduleService.getModuleTree(req.user, req.query.companyId);
    return successResponse(res, moduleTree, MODULE_MESSAGES.GET_TREE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getModuleTree',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.GET_TREE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPermissionModules = catchAsync(
  async (req, res) => {
    const emptyModules = await moduleService.getPermissionModules(req.user, req.query.companyId);
    return successResponse(res, emptyModules, MODULE_MESSAGES.GET_PERMISSION_MODULES_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPermissionModules',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.GET_PERMISSION_MODULES_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSettingsFeaturePlan = catchAsync(
  async (req, res) => {
    const featurePlanStatus = await moduleService.getSettingsFeaturePlanStatus(req.query.companyId);
    return successResponse(res, featurePlanStatus, MODULE_MESSAGES.GET_SETTINGS_FEATURE_PLAN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSettingsFeaturePlanStatus',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.GET_SETTINGS_FEATURE_PLAN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createModule = catchAsync(
  async (req, res) => {
    const module = await moduleService.createModule(req.body);
    return successResponse(res, { module }, MODULE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createModule',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getModules = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['moduleName', 'description']);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await moduleService.queryModules(filter, options);
    return successResponse(res, { result }, MODULE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryModules',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getModule = catchAsync(
  async (req, res) => {
    const module = await moduleService.getModuleById(req.params.moduleId);
    return successResponse(res, { module }, MODULE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getModuleById',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateModule = catchAsync(
  async (req, res) => {
    const module = await moduleService.updateModuleById(req.params.moduleId, req.body);
    return successResponse(res, { module }, MODULE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateModuleById',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteModule = catchAsync(
  async (req, res) => {
    await moduleService.deleteModuleById(req.params.moduleId);
    return successResponse(res, {}, MODULE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteModuleById',
    controller: 'module',
    failureMessage: MODULE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getModuleTree,
  getPermissionModules,
  getSettingsFeaturePlan,
  createModule,
  getModules,
  getModule,
  updateModule,
  deleteModule,
};
