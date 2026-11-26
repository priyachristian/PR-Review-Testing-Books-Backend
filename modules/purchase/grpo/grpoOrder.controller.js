const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const grpoOrderService = require('./grpoOrder.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { GRPO_ORDER_MESSAGES } = require('../../../utils/messages');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const grpoTransformers = require('./grpo.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

/**
 * Create an Order
 */
const createGrpoOrder = catchAsync(async (req, res) => {
  const userId = req.user._id;
  try {
    const grpoBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const grpoOrder = await grpoOrderService.createGrpoOrder(
      { ...grpoBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );
    return successResponse(res, grpoOrder, GRPO_ORDER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createGrpoOrder', controller: 'grpoOrder' },
      res,
      error?.message || GRPO_ORDER_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getAllGrpoOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'date',
      'search',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
      'isSplit',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const grpoOrder = await grpoOrderService.getAllGrpoOrders(filter, options);
    const { results, ...otherFields } = grpoOrder;
    const transformedGrpo = grpoTransformers.queryGrpo(results);
    return successResponse(res, transformedGrpo, GRPO_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllGrpoOrders',
    controller: 'grpoOrder',
    failureMessage: GRPO_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getGrpoOrdersExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'date',
      'search',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await grpoOrderService.queryGrpoOrdersExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedGrpo = grpoTransformers.queryGrpo(results);
    return successResponse(res, transformedGrpo, GRPO_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryGrpoOrdersExports',
    controller: 'grpoOrder',
    failureMessage: GRPO_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateGrpoOrder = catchAsync(async (req, res) => {
  const grpoOrderId = req.params.id;
  const userId = req.user._id;

  try {
    const grpoBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const updatedGrpoOrder = await grpoOrderService.updateGrpoOrder(
      grpoOrderId,
      { ...grpoBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );

    return successResponse(res, updatedGrpoOrder, GRPO_ORDER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updateGrpoOrder', controller: 'grpoOrder' },
      res,
      error?.message || GRPO_ORDER_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const deleteGrpoOrder = catchAsync(
  async (req, res) => {
    const grpoOrderId = req.params.id;
    const userId = req.user._id;
    await grpoOrderService.deleteGrpoOrder(grpoOrderId, req.query.companyId, userId);

    return successResponse(res, {}, GRPO_ORDER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteGrpoOrder',
    controller: 'grpoOrder',
    failureMessage: GRPO_ORDER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateGrpoOrderStatus = catchAsync(
  async (req, res) => {
    const grpoOrderId = req.params.grpoOrderId;
    const userId = req.user._id;
    const { status } = req.body;
    const updatedGrpoOrder = await grpoOrderService.updateGrpoOrderStatus(grpoOrderId, req.query.companyId, status, userId);

    return successResponse(res, updatedGrpoOrder, GRPO_ORDER_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateGrpoOrderStatus',
    controller: 'grpoOrder',
    failureMessage: GRPO_ORDER_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getGrpoOrder = catchAsync(
  async (req, res) => {
    const grpoOrderId = req.params.id;
    const result = await grpoOrderService.getGrpoOrder(grpoOrderId, req.query.companyId);

    return successResponse(res, result, GRPO_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getGrpoOrder',
    controller: 'grpoOrder',
    failureMessage: GRPO_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const grpofromPurchaseOrder = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'vendor']);
    const result = await grpoOrderService.grpofromPurchaseOrder(filter);

    return successResponse(res, result, GRPO_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'grpofromPurchaseOrder',
    controller: 'grpoOrder',
    failureMessage: GRPO_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const grpoItems = catchAsync(
  async (req, res) => {
    const result = await grpoOrderService.grpoItems(req.query.id, req.query.companyId);

    return successResponse(res, result, GRPO_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'grpoItems',
    controller: 'grpoOrder',
    failureMessage: GRPO_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);
const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.id,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.GRPO,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createGrpoOrder,
  getAllGrpoOrders,
  getGrpoOrdersExports,
  updateGrpoOrder,
  deleteGrpoOrder,
  updateGrpoOrderStatus,
  getGrpoOrder,
  grpofromPurchaseOrder,
  grpoItems,
};
