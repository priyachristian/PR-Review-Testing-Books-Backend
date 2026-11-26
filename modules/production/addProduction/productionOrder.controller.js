const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const { getProductionCostBreakdown } = require('../../../services/productionCostBreakdown.service');
const productionOrderService = require('./productionOrder.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { SALES_ORDER_MESSAGES, PRODUCTION_ORDER_MESSAGES } = require('../../../utils/messages');

const retryOnWriteConflict = async (fn, maxRetries = 3) => {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isWriteConflict =
        error?.errorLabels?.includes('TransientTransactionError') || error?.message?.includes('Write conflict');

      if (isWriteConflict && attempt < maxRetries) {
        console.log(`🔁 Retrying due to write conflict (attempt ${attempt})`);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
};

const createProductionOrder = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const productionOrder = await productionOrderService.createProductionOrder(
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, { productionOrder }, PRODUCTION_ORDER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createProductionOrder',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProductionOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'branchId',
      'warehouseId',
      'divisionId',
      'status',
      'companyId',
      'productionManageMethod',
      'productionDate',
      'itemGroupId',
      'subItemGroupId',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await productionOrderService.queryProductionOrders(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, PRODUCTION_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryProductionOrders',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const submitProductionOrder = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const updatedOrder = await retryOnWriteConflict(() =>
      productionOrderService.submitProductionOrderrById(req.params.id, req.query.companyId, req.body, userId),
    );
    return successResponse(res, updatedOrder, PRODUCTION_ORDER_MESSAGES.SUBMIT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'submitProductionOrderrById',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.SUBMIT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const startProcess = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const result = await productionOrderService.startProcess(req.query, userId);
    return successResponse(res, result, PRODUCTION_ORDER_MESSAGES.START_PROCESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'startProcess',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.START_PROCESS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const endProcess = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const result = await retryOnWriteConflict(() => productionOrderService.endProcess(req.query, req.body, userId));
    return successResponse(res, result, PRODUCTION_ORDER_MESSAGES.END_PROCESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'endProcess',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.END_PROCESS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const submitProcess = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const result = await retryOnWriteConflict(() => productionOrderService.submitProcess(req.query, req.body, userId));
    return successResponse(res, result, PRODUCTION_ORDER_MESSAGES.SUBMIT_PROCESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'submitProcess',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.SUBMIT_PROCESS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteProcessSubmission = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const result = await retryOnWriteConflict(() => productionOrderService.deleteProcessSubmission(req.query, userId));
    return successResponse(res, result, PRODUCTION_ORDER_MESSAGES.DELETE_PROCESS_SUBMISSION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteProcessSubmission',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.DELETE_PROCESS_SUBMISSION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const editProcessSubmission = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const result = await retryOnWriteConflict(() => productionOrderService.editProcessSubmission(req.query, req.body, userId));
    return successResponse(res, result, PRODUCTION_ORDER_MESSAGES.EDIT_PROCESS_SUBMISSION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'editProcessSubmission',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.EDIT_PROCESS_SUBMISSION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemProductionData = catchAsync(
  async (req, res) => {
    const { itemId, warehouseId, companyId, processId } = req.query;
    const result = await productionOrderService.getItemProductionData(itemId, warehouseId, companyId, processId);
    return successResponse(res, result, PRODUCTION_ORDER_MESSAGES.FETCH_PRODUCTION_DATA_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemProductionData',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.FETCH_PRODUCTION_DATA_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getSalesOrderDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await productionOrderService.getSalesOrdersForDropdown(filter);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSalesOrdersForDropdown',
    controller: 'productionOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getProductionOrdersById = catchAsync(
  async (req, res) => {
    const productionOrder = await productionOrderService.getProductionOrdersById(req.params.id, req.query.companyId);
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProductionOrdersById',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBomBasedProductionOrderById = catchAsync(
  async (req, res) => {
    const productionOrder = await productionOrderService.getBomBasedProductionOrderById(req.params.id, req.query.companyId);
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBomBasedProductionOrderById',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProcessBasedProductionOrderById = catchAsync(
  async (req, res) => {
    const productionOrder = await productionOrderService.getProcessBasedProductionOrderById(req.params.id, req.query.companyId);
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProcessBasedProductionOrderById',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateProductionOrderStatus = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const productionOrder = await productionOrderService.updateProductionOrderStatus(
      req.params.id,
      req.query.companyId,
      req.body.status,
      req.body.isManuallyCompleted,
      userId,
    );
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateProductionOrderStatus',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const reRaiseTransferRequest = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const productionOrder = await productionOrderService.reRaiseTransferRequest(req.params.id, req.query.companyId, userId);
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.RE_RAISE_TRANSFER_SUCCESS, httpStatus.OK);
  },
  {
    service: 'reRaiseTransferRequest',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.RE_RAISE_TRANSFER_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteProductionOrder = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    await productionOrderService.deleteProductionOrderById(req.params.id, req.query.companyId, userId);
    return successResponse(res, {}, PRODUCTION_ORDER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteProductionOrderById',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const reorderProcesses = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const productionOrder = await productionOrderService.reorderProcesses(
      req.params.id,
      req.query.companyId,
      req.body.processes,
      req.body.isLocked,
      userId,
    );
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.REORDER_PROCESSES_SUCCESS, httpStatus.OK);
  },
  {
    service: 'reorderProcesses',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.REORDER_PROCESSES_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const editSubmission = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const productionOrder = await retryOnWriteConflict(() =>
      productionOrderService.editSubmissionHistory(req.params.id, req.query.companyId, req.params.submissionId, req.body, userId),
    );
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.EDIT_SUBMISSION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'editSubmissionHistory',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.EDIT_SUBMISSION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteSubmission = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const productionOrder = await retryOnWriteConflict(() =>
      productionOrderService.deleteSubmissionHistory(req.params.id, req.query.companyId, req.params.submissionId, userId),
    );
    return successResponse(res, productionOrder, PRODUCTION_ORDER_MESSAGES.DELETE_SUBMISSION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteSubmissionHistory',
    controller: 'productionOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.DELETE_SUBMISSION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.id,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.PRODUCTION_ORDER,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

const getCostBreakdown = catchAsync(async (req, res) => {
  const result = await getProductionCostBreakdown({
    companyId: req.query.companyId,
    productionOrderId: req.params.id,
  });
  return successResponse(res, result, 'Cost breakdown fetched successfully', httpStatus.OK);
});

const getMaterialConsumption = catchAsync(async (req, res) => {
  const result = await productionOrderService.getProcessRouteMaterialConsumption(req.params.id, req.query.companyId);
  return successResponse(res, result, 'Material consumption fetched successfully', httpStatus.OK);
});

const getScrapAndRejection = catchAsync(async (req, res) => {
  const result = await productionOrderService.getProcessRouteScrapAndRejection(req.params.id, req.query.companyId);
  return successResponse(res, result, 'Scrap and rejection fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  getCostBreakdown,
  getMaterialConsumption,
  getScrapAndRejection,
  createProductionOrder,
  getItemProductionData,
  getProductionOrders,
  submitProductionOrder,
  startProcess,
  endProcess,
  submitProcess,
  deleteProcessSubmission,
  editProcessSubmission,
  getSalesOrderDropdown,
  getProductionOrdersById,
  getBomBasedProductionOrderById,
  getProcessBasedProductionOrderById,
  updateProductionOrderStatus,
  reRaiseTransferRequest,
  deleteProductionOrder,
  reorderProcesses,
  editSubmission,
  deleteSubmission,
};
