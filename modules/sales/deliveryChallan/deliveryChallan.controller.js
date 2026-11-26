const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const deliveryChallanService = require('./deliveryChallan.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const { DELIVERY_CHALLAN_MESSAGES } = require('../../../utils/messages');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const deliveryChallanTransformers = require('./deliveryChallan.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createDeliveryChallan = catchAsync(async (req, res) => {
  try {
    const challanBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const challan = await deliveryChallanService.createDeliveryChallan(
      { ...challanBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, challan, DELIVERY_CHALLAN_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createDeliveryChallan', controller: 'deliveryChallan' },
      res,
      error?.message || DELIVERY_CHALLAN_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getDeliveryChallans = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'challanId',
      'companyId',
      'customerId',
      'search',
      'challanDate',
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
    const result = await deliveryChallanService.queryDeliveryChallans(filter, options);
    const { results, ...otherFields } = result;
    const transformedDeliveryChallan = deliveryChallanTransformers.queryDeliveryChallan(results);
    return successResponse(
      res,
      transformedDeliveryChallan,
      DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_SUCCESS,
      httpStatus.OK,
      otherFields,
    );
  },
  {
    service: 'queryDeliveryChallans',
    controller: 'deliveryChallan',
    failureMessage: DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getDeliveryChallansExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'challanId',
      'companyId',
      'customerId',
      'search',
      'challanDate',
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
    const result = await deliveryChallanService.queryDeliveryChallansExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedDeliveryChallan = deliveryChallanTransformers.queryDeliveryChallan(results);
    return successResponse(
      res,
      transformedDeliveryChallan,
      DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_SUCCESS,
      httpStatus.OK,
      otherFields,
    );
  },
  {
    service: 'queryDeliveryChallansExports',
    controller: 'deliveryChallan',
    failureMessage: DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getDeliveryChallan = catchAsync(
  async (req, res) => {
    const challan = await deliveryChallanService.getDeliveryChallanById(req.params.challanId, req.query.companyId);
    return successResponse(res, challan, DELIVERY_CHALLAN_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getDeliveryChallanById',
    controller: 'deliveryChallan',
    failureMessage: DELIVERY_CHALLAN_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateDeliveryChallan = catchAsync(async (req, res) => {
  try {
    const challanBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const challan = await deliveryChallanService.updateDeliveryChallanById(
      req.params.challanId,
      { ...challanBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, challan, DELIVERY_CHALLAN_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updateDeliveryChallanById', controller: 'deliveryChallan' },
      res,
      error?.message || DELIVERY_CHALLAN_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const updateDeliveryChallanStatus = catchAsync(
  async (req, res) => {
    const challan = await deliveryChallanService.updateDeliveryChallanStatus(
      req.params.challanId,
      req.query.companyId,
      req.body.status,
      req.user._id,
    );
    return successResponse(res, challan, DELIVERY_CHALLAN_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateDeliveryChallanStatus',
    controller: 'deliveryChallan',
    failureMessage: DELIVERY_CHALLAN_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteDeliveryChallan = catchAsync(
  async (req, res) => {
    await deliveryChallanService.deleteDeliveryChallanById(req.params.challanId, req.query.companyId, req.user._id);
    return successResponse(res, {}, DELIVERY_CHALLAN_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteDeliveryChallanById',
    controller: 'deliveryChallan',
    failureMessage: DELIVERY_CHALLAN_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deliveryChallanfromSalesOrder = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'customerId']);
    const result = await deliveryChallanService.deliveryChallanfromSalesOrder(filter);
    return successResponse(res, result, DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'deliveryChallanfromSalesOrder',
    controller: 'deliveryChallan',
    failureMessage: DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deliveryChallanItems = catchAsync(
  async (req, res) => {
    const result = await deliveryChallanService.deliveryChallanItems(req.query.challanId, req.query.companyId);
    return successResponse(res, result, DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'deliveryChallanItems',
    controller: 'deliveryChallan',
    failureMessage: DELIVERY_CHALLAN_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.challanId,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.DELIVERY_CHALLAN,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createDeliveryChallan,
  getDeliveryChallans,
  getDeliveryChallansExports,
  getDeliveryChallan,
  updateDeliveryChallan,
  deleteDeliveryChallan,
  updateDeliveryChallanStatus,
  deliveryChallanfromSalesOrder,
  deliveryChallanItems,
};
