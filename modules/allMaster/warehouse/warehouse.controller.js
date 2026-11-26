const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const warehouseService = require('./warehouse.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { WAREHOUSE_MESSAGES } = require('../../../utils/messages');

const createWarehouse = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const warehouse = await warehouseService.createNewWarehouse({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, warehouse, WAREHOUSE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createNewWarehouse',
    controller: 'warehouse',
    failureMessage: WAREHOUSE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllWarehouses = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isSplit', 'isActive', 'status', 'divisionId', 'branchId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const warehouses = await warehouseService.getAllWarehouses(req.query, filter, options);
    const { results, ...otherFields } = warehouses;
    return successResponse(res, results, WAREHOUSE_MESSAGES.RETRIEVE_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllWarehouses',
    controller: 'warehouse',
    failureMessage: WAREHOUSE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateWarehouse = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const warehouseId = req.params.warehouseId;
    const updatedWarehouse = await warehouseService.updateWarehouse(
      warehouseId,
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, updatedWarehouse, WAREHOUSE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateWarehouse',
    controller: 'warehouse',
    failureMessage: WAREHOUSE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteWarehouse = catchAsync(
  async (req, res) => {
    const warehouseId = req.params.warehouseId;
    await warehouseService.deleteWarehouse(warehouseId, req.query.companyId);
    return successResponse(res, null, WAREHOUSE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteWarehouse',
    controller: 'warehouse',
    failureMessage: WAREHOUSE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getWarehousesDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isSplit', 'branchId', 'includeRejectionWarehouses']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await warehouseService.getWarehousesDropdown(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, WAREHOUSE_MESSAGES.DROPDOWN_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getWarehousesDropdown',
    controller: 'warehouse',
    failureMessage: WAREHOUSE_MESSAGES.DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const warehouseById = catchAsync(
  async (req, res) => {
    const warehouseId = req.params.warehouseId;
    const warehouse = await warehouseService.warehouseById(warehouseId, req.query.companyId);
    return successResponse(res, warehouse, WAREHOUSE_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'warehouseById',
    controller: 'warehouse',
    failureMessage: WAREHOUSE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const warehouseId = req.params.warehouseId;
    const { isActive, companyId } = req.query;
    const updatedWarehouse = await warehouseService.updateStatus(warehouseId, isActive, companyId);
    return successResponse(res, updatedWarehouse, WAREHOUSE_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateStatus',
    controller: 'warehouse',
    failureMessage: WAREHOUSE_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createWarehouse,
  getAllWarehouses,
  updateWarehouse,
  deleteWarehouse,
  getWarehousesDropdown,
  warehouseById,
  updateStatus,
};
