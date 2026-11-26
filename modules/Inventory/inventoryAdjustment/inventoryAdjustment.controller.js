const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const inventoryAdjustmentService = require('./inventoryAdjustment.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const { INVENTORY_ADJUSTMENT_MESSAGES } = require('../../../utils/messages');

const createInventoryAdjustment = catchAsync(
  async (req, res) => {
    const adjustment = await inventoryAdjustmentService.createInventoryAdjustment(
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, adjustment, 'Inventory adjustment created successfully', httpStatus.CREATED);
  },
  {
    service: 'createInventoryAdjustment',
    controller: 'inventoryAdjustment',
    failureMessage: INVENTORY_ADJUSTMENT_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getInventoryAdjustments = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'divisionId',
      'branchId',
      'warehouseId',
      'status',
      'reason',
      'inventoryAdjustmentNumber',
      'referenceNumber',
      'startDate',
      'endDate',
      'search',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await inventoryAdjustmentService.queryInventoryAdjustments(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, INVENTORY_ADJUSTMENT_MESSAGES.FETCH_LIST_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryInventoryAdjustments',
    controller: 'inventoryAdjustment',
    failureMessage: INVENTORY_ADJUSTMENT_MESSAGES.FETCH_LIST_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getInventoryAdjustment = catchAsync(
  async (req, res) => {
    const adjustment = await inventoryAdjustmentService.getInventoryAdjustmentById(req.params.adjustmentId, req.query.companyId);
    return successResponse(res, adjustment, INVENTORY_ADJUSTMENT_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getInventoryAdjustmentById',
    controller: 'inventoryAdjustment',
    failureMessage: INVENTORY_ADJUSTMENT_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const approveInventoryAdjustment = catchAsync(async (req, res) => {
  try {
    const adjustment = await inventoryAdjustmentService.approveInventoryAdjustment(
      req.params.adjustmentId,
      req.query.companyId,
      req.user._id,
    );
    return successResponse(res, adjustment, 'Inventory adjustment approved successfully', httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'approveInventoryAdjustment', controller: 'inventoryAdjustment' },
      res,
      error?.message || 'Failed to approve inventory adjustment',
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const rejectInventoryAdjustment = catchAsync(async (req, res) => {
  try {
    const adjustment = await inventoryAdjustmentService.rejectInventoryAdjustment(
      req.params.adjustmentId,
      req.query.companyId,
      req.user._id,
    );
    return successResponse(res, adjustment, 'Inventory adjustment rejected successfully', httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'rejectInventoryAdjustment', controller: 'inventoryAdjustment' },
      res,
      error?.message || 'Failed to reject inventory adjustment',
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const updateInventoryAdjustment = catchAsync(async (req, res) => {
  try {
    const adjustment = await inventoryAdjustmentService.updateInventoryAdjustmentById(
      req.params.adjustmentId,
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
      req.query.companyId,
    );
    return successResponse(res, adjustment, 'Inventory adjustment updated successfully', httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updateInventoryAdjustmentById', controller: 'inventoryAdjustment' },
      res,
      error?.message || 'Failed to update inventory adjustment',
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.adjustmentId,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.INVENTORY_ADJUSTMENT,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createInventoryAdjustment,
  getInventoryAdjustments,
  getInventoryAdjustment,
  approveInventoryAdjustment,
  rejectInventoryAdjustment,
  updateInventoryAdjustment,
};
