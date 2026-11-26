const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const inventoryTransferService = require('./inventoryTransfer.service');
const { successResponse } = require('../../../services/response.service');
const { INVENTORY_TRANSFER_MESSAGES } = require('../../../utils/messages');

const createInventoryTransferRequest = catchAsync(
  async (req, res) => {
    const transferData = {
      ...req.body,
      addedBy: req.user._id,
      companyId: req.query?.companyId,
      updatedBy: req.user._id,
    };
    const result = await inventoryTransferService.createInventoryTransferRequest(transferData);
    return successResponse(res, result, INVENTORY_TRANSFER_MESSAGES.CREATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'createInventoryTransferRequest',
    controller: 'inventoryTransfer',
    failureMessage: INVENTORY_TRANSFER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getInventoryTransferRequests = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'fromBranchId',
      'toBranchId',
      'warehouseId',
      'status',
      'search',
      'startDate',
      'endDate',
      'divisionId',
      'branchId',
      'isProductionOrderReq',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await inventoryTransferService.getInventoryTransferRequests(filter, options);
    const { results, ...paginationData } = result;
    return successResponse(res, results, INVENTORY_TRANSFER_MESSAGES.FETCH_LIST_SUCCESS, httpStatus.OK, paginationData);
  },
  {
    service: 'getInventoryTransferRequests',
    controller: 'inventoryTransfer',
    failureMessage: INVENTORY_TRANSFER_MESSAGES.FETCH_LIST_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getInventoryTransfer = catchAsync(
  async (req, res) => {
    const result = await inventoryTransferService.getInventoryTransferById(req.params.transferId, req.query.companyId);
    return successResponse(res, result, INVENTORY_TRANSFER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getInventoryTransferById',
    controller: 'inventoryTransfer',
    failureMessage: INVENTORY_TRANSFER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const approveInventoryTransfer = catchAsync(
  async (req, res) => {
    const { manPower_inventoryTransfer } = req.body;
    const result = await inventoryTransferService.approveInventoryTransfer(
      req.params.transferId,
      req.query.companyId,
      req.user._id,
      manPower_inventoryTransfer,
    );
    return successResponse(res, result, INVENTORY_TRANSFER_MESSAGES.APPROVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'approveInventoryTransfer',
    controller: 'inventoryTransfer',
    failureMessage: INVENTORY_TRANSFER_MESSAGES.APPROVE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const rejectInventoryTransfer = catchAsync(
  async (req, res) => {
    const { manPower_inventoryTransfer } = req.body;
    const result = await inventoryTransferService.rejectInventoryTransfer(
      req.params.transferId,
      req.query.companyId,
      req.user._id,
      manPower_inventoryTransfer,
    );
    return successResponse(res, result, INVENTORY_TRANSFER_MESSAGES.REJECT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'rejectInventoryTransfer',
    controller: 'inventoryTransfer',
    failureMessage: INVENTORY_TRANSFER_MESSAGES.REJECT_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.transferId,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.INVENTORY_TRANSFER,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createInventoryTransferRequest,
  getInventoryTransferRequests,
  getInventoryTransfer,
  approveInventoryTransfer,
  rejectInventoryTransfer,
};
