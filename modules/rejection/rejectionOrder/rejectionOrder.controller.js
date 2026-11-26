const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const rejectionOrderService = require('./rejectionOrder.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const { REJECTION_ORDER_MESSAGES } = require('../../../utils/messages');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');
const rejectionOrderTransformers = require('./rejectionOrder.transformer');

const createRejectionOrder = catchAsync(async (req, res) => {
  try {
    const orderBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const order = await rejectionOrderService.createRejectionOrder(
      { ...orderBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, order, REJECTION_ORDER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createRejectionOrder', controller: 'rejectionOrder' },
      res,
      error?.message || REJECTION_ORDER_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getRejectionOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'rejectionOrderId',
      'status',
      'branchId',
      'divisionId',
      'addedBy',
      'search',
      'startDate',
      'endDate',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await rejectionOrderService.queryRejectionOrders(filter, options);
    const { results, ...otherFields } = result;
    const transformedRejectionOrders = rejectionOrderTransformers.queryRejectionOrders(results);
    return successResponse(
      res,
      transformedRejectionOrders,
      REJECTION_ORDER_MESSAGES.FETCH_ALL_SUCCESS,
      httpStatus.OK,
      otherFields,
    );
  },
  {
    service: 'queryRejectionOrders',
    controller: 'rejectionOrder',
    failureMessage: REJECTION_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getRejectionOrder = catchAsync(
  async (req, res) => {
    const order = await rejectionOrderService.getRejectionOrderById(req.params.rejectionOrderId, req.query.companyId);
    return successResponse(res, order, REJECTION_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionOrderById',
    controller: 'rejectionOrder',
    failureMessage: REJECTION_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const saveRejectionWorkflow = catchAsync(async (req, res) => {
  try {
    const order = await rejectionOrderService.saveRejectionWorkflowById(
      req.params.rejectionOrderId,
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, order, REJECTION_ORDER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'saveRejectionWorkflowById', controller: 'rejectionOrder' },
      res,
      error?.message || REJECTION_ORDER_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const updateRejectionBooking = catchAsync(async (req, res) => {
  try {
    const bookingBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const order = await rejectionOrderService.updateRejectionBookingById(
      req.params.rejectionOrderId,
      req.query.companyId,
      bookingBody,
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, order, REJECTION_ORDER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updateRejectionBookingById', controller: 'rejectionOrder' },
      res,
      error?.message || REJECTION_ORDER_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const updateRejectionOrderStatus = catchAsync(
  async (req, res) => {
    const order = await rejectionOrderService.updateRejectionOrderStatus(
      req.params.rejectionOrderId,
      req.query.companyId,
      req.body.status,
      req.user._id,
    );
    return successResponse(res, order, REJECTION_ORDER_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRejectionOrderStatus',
    controller: 'rejectionOrder',
    failureMessage: REJECTION_ORDER_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteRejectionOrder = catchAsync(
  async (req, res) => {
    await rejectionOrderService.deleteRejectionOrderById(req.params.rejectionOrderId, req.query.companyId);
    return successResponse(res, {}, REJECTION_ORDER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteRejectionOrderById',
    controller: 'rejectionOrder',
    failureMessage: REJECTION_ORDER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getInventorySummary = catchAsync(
  async (req, res) => {
    const { orders, extras } = await rejectionOrderService.getInventorySummary(req.query.companyId);
    return successResponse(res, orders, REJECTION_ORDER_MESSAGES.INVENTORY_SUMMARY_SUCCESS, httpStatus.OK, extras);
  },
  {
    service: 'getInventorySummary',
    controller: 'rejectionOrder',
    failureMessage: REJECTION_ORDER_MESSAGES.INVENTORY_SUMMARY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getAnalysisSummary = catchAsync(
  async (req, res) => {
    const data = await rejectionOrderService.getAnalysisSummary(req.query.companyId, req.query.itemId || null);
    return successResponse(res, data, REJECTION_ORDER_MESSAGES.ANALYSIS_SUMMARY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAnalysisSummary',
    controller: 'rejectionOrder',
    failureMessage: REJECTION_ORDER_MESSAGES.ANALYSIS_SUMMARY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getRecoveryBom = catchAsync(
  async (req, res) => {
    const data = await rejectionOrderService.getRecoveryBom(req.params.rejectionOrderId, req.query.companyId);
    return successResponse(res, data, REJECTION_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRecoveryBom',
    controller: 'rejectionOrder',
    failureMessage: REJECTION_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getInvoiceDropdown = catchAsync(
  async (req, res) => {
    const filters = pick(req.query, ['customerId', 'companyId', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await rejectionOrderService.getInvoiceDropdown(filters, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, 'Invoice dropdown fetched successfully', httpStatus.OK, otherFields);
  },
  {
    service: 'getInvoiceDropdown',
    controller: 'rejectionOrder',
    failureMessage: 'Failed to fetch invoice dropdown',
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.rejectionOrderId,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.REJECTION_ORDER,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createRejectionOrder,
  getRejectionOrders,
  getRejectionOrder,
  saveRejectionWorkflow,
  updateRejectionBooking,
  updateRejectionOrderStatus,
  deleteRejectionOrder,
  getInventorySummary,
  getAnalysisSummary,
  getRecoveryBom,
  getInvoiceDropdown,
};
