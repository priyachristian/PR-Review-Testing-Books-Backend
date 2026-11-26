const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const purchaseOrderService = require('./purchaseOrder.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { PURCHASE_ORDER_MESSAGES } = require('../../../utils/messages');
const purchaseOrderTransformers = require('./purchaseOrder.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

/**
 * Create an Order
 */
const createPurchaseOrder = catchAsync(async (req, res) => {
  const userId = req.user._id;
  try {
    const purchaseOrderBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const purchaseOrder = await purchaseOrderService.createPurchaseOrder(
      { ...purchaseOrderBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );
    return successResponse(res, purchaseOrder, PURCHASE_ORDER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    console.log({ error });
    return errorResponse(
      { req, error, service: 'createPurchaseOrder', controller: 'purchase' },
      res,
      error?.message || PURCHASE_ORDER_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getAllPurchaseOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'status',
      'date',
      'search',
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
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const purchaseOrder = await purchaseOrderService.getAllPurchaseOrders(filter, options);
    const { results, ...otherFields } = purchaseOrder;
    const transformedPo = purchaseOrderTransformers.queryPurchaseOrders(results);
    return successResponse(res, transformedPo, PURCHASE_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllPurchaseOrders',
    controller: 'purchase',
    failureMessage: PURCHASE_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPurchaseOrdersExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'status',
      'date',
      'search',
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
    const result = await purchaseOrderService.queryPurchaseOrdersExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedPo = purchaseOrderTransformers.queryPurchaseOrders(results);
    return successResponse(res, transformedPo, PURCHASE_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryPurchaseOrdersExports',
    controller: 'purchase',
    failureMessage: PURCHASE_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updatePurchaseOrder = catchAsync(async (req, res) => {
  const purchaseOrderId = req.params.id;
  const userId = req.user._id;

  try {
    const purchaseOrderBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const updatedPurchaseOrder = await purchaseOrderService.updatePurchaseOrder(
      purchaseOrderId,
      { ...purchaseOrderBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );
    return successResponse(res, updatedPurchaseOrder, PURCHASE_ORDER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updatePurchaseOrder', controller: 'purchase' },
      res,
      error?.message || PURCHASE_ORDER_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const deletePurchaseOrder = catchAsync(
  async (req, res) => {
    const purchaseOrderId = req.params.id;
    await purchaseOrderService.deletePurchaseOrder(purchaseOrderId, req.query.companyId);
    return successResponse(res, {}, PURCHASE_ORDER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deletePurchaseOrder',
    controller: 'purchase',
    failureMessage: PURCHASE_ORDER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updatePurchaseOrderStatus = catchAsync(
  async (req, res) => {
    const purchaseOrderId = req.params.purchaseOrderId;
    const userId = req.user._id;
    const { status } = req.body;
    const updatedPurchaseOrder = await purchaseOrderService.updatePurchaseOrderStatus(
      purchaseOrderId,
      req.query.companyId,
      status,
      userId,
    );
    return successResponse(res, updatedPurchaseOrder, PURCHASE_ORDER_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updatePurchaseOrderStatus',
    controller: 'purchase',
    failureMessage: PURCHASE_ORDER_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getPurchaseOrder = catchAsync(
  async (req, res) => {
    const purchaseOrderId = req.params.id;
    const result = await purchaseOrderService.getPurchaseOrder(purchaseOrderId, req.query.companyId);
    return successResponse(res, result, PURCHASE_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPurchaseOrder',
    controller: 'purchase',
    failureMessage: PURCHASE_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPurchaseOrderConvertDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'status', 'vendor']);
    const options = pick(req.query, ['pagination']);
    const purchaseOrder = await purchaseOrderService.getPurchaseOrderConvertDropdown(filter, options);
    return successResponse(res, purchaseOrder, PURCHASE_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPurchaseOrderConvertDropdown',
    controller: 'purchase',
    failureMessage: PURCHASE_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const partiallyConvertedItemList = catchAsync(
  async (req, res) => {
    const purchaseOrder = await purchaseOrderService.partiallyConvertedItemList(req.query.id, req.query.companyId);
    return successResponse(res, purchaseOrder, PURCHASE_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'partiallyConvertedItemList',
    controller: 'purchase',
    failureMessage: PURCHASE_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createPurchaseOrder,
  getAllPurchaseOrders,
  getPurchaseOrdersExports,
  updatePurchaseOrder,
  deletePurchaseOrder,
  updatePurchaseOrderStatus,
  getPurchaseOrder,
  getPurchaseOrderConvertDropdown,
  partiallyConvertedItemList,
};
