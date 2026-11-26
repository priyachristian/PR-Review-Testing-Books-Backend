const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const pick = require('../../../utils/pick');
const productionDepartmentWarehouseConfigService = require('./productionDepartmentWarehouseConfig.service');
const { successResponse } = require('../../../services/response.service');
const { PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES } = require('../../../utils/messages');

const createProductionDepartmentWarehouseConfig = catchAsync(
  async (req, res) => {
    const config = await productionDepartmentWarehouseConfigService.createProductionDepartmentWarehouseConfig({
      ...req.body,
      companyId: req.query.companyId,
    });
    return successResponse(res, config, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createProductionDepartmentWarehouseConfig',
    controller: 'productionDepartmentWarehouseConfig',
    failureMessage: PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProductionDepartmentWarehouseConfigs = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search']);
    const configs = await productionDepartmentWarehouseConfigService.getProductionDepartmentWarehouseConfigs(filter);
    return successResponse(res, configs, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProductionDepartmentWarehouseConfigs',
    controller: 'productionDepartmentWarehouseConfig',
    failureMessage: PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getProductionDepartmentWarehouseConfigById = catchAsync(
  async (req, res) => {
    const config = await productionDepartmentWarehouseConfigService.getProductionDepartmentWarehouseConfigById(
      req.params.id,
      req.query.companyId,
    );
    return successResponse(res, config, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProductionDepartmentWarehouseConfigById',
    controller: 'productionDepartmentWarehouseConfig',
    failureMessage: PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateProductionDepartmentWarehouseConfig = catchAsync(
  async (req, res) => {
    const config = await productionDepartmentWarehouseConfigService.updateProductionDepartmentWarehouseConfigById(
      req.params.id,
      req.body,
      req.query.companyId,
    );
    return successResponse(res, config, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateProductionDepartmentWarehouseConfigById',
    controller: 'productionDepartmentWarehouseConfig',
    failureMessage: PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateProductionDepartmentWarehouseConfigStatus = catchAsync(
  async (req, res) => {
    const config = await productionDepartmentWarehouseConfigService.updateProductionDepartmentWarehouseConfigStatus(
      req.params.id,
      req.body.isActive,
      req.query.companyId,
    );
    return successResponse(res, config, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateProductionDepartmentWarehouseConfigStatus',
    controller: 'productionDepartmentWarehouseConfig',
    failureMessage: PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteProductionDepartmentWarehouseConfig = catchAsync(
  async (req, res) => {
    await productionDepartmentWarehouseConfigService.deleteProductionDepartmentWarehouseConfigById(
      req.params.id,
      req.query.companyId,
    );
    return successResponse(res, {}, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteProductionDepartmentWarehouseConfigById',
    controller: 'productionDepartmentWarehouseConfig',
    failureMessage: PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getProductionDepartmentWarehouseDropdown = catchAsync(
  async (req, res) => {
    const result = await productionDepartmentWarehouseConfigService.getProductionDepartmentWarehouseDropdown(req.query.companyId);
    return successResponse(res, result, PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProductionDepartmentWarehouseDropdown',
    controller: 'productionDepartmentWarehouseConfig',
    failureMessage: PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createProductionDepartmentWarehouseConfig,
  getProductionDepartmentWarehouseConfigs,
  getProductionDepartmentWarehouseConfigById,
  updateProductionDepartmentWarehouseConfig,
  updateProductionDepartmentWarehouseConfigStatus,
  deleteProductionDepartmentWarehouseConfig,
  getProductionDepartmentWarehouseDropdown,
};
