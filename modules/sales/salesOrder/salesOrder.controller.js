const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const salesOrderService = require('./salesOrder.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { SALES_ORDER_MESSAGES, PRODUCTION_ORDER_MESSAGES } = require('../../../utils/messages');
const salesTransformers = require('./salesOrder.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createSalesOrder = catchAsync(async (req, res) => {
  try {
    const orderBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const order = await salesOrderService.createSalesOrder(
      { ...orderBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, order, SALES_ORDER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createSalesOrder', controller: 'salesOrder' },
      res,
      error?.message || SALES_ORDER_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getSalesOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'orderId',
      'companyId',
      'customerId',
      'search',
      'orderDate',
      'status',
      'productionOrderStatus',
      'materialStatus',
      'withMaterialStatus',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'tagId',
      'appName',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await salesOrderService.querySalesOrders(filter, options);
    const { results, ...otherFields } = result;
    const transformedSalesOrder = salesTransformers.querySales(results);
    return successResponse(res, transformedSalesOrder, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'querySalesOrders',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSalesOrdersExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'orderId',
      'companyId',
      'customerId',
      'search',
      'orderDate',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'tagId',
      'appName',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
      'materialStatus',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await salesOrderService.querySalesOrdersExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedSalesOrder = salesTransformers.querySales(results);
    return successResponse(res, transformedSalesOrder, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'querySalesOrdersExports',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSalesOrder = catchAsync(
  async (req, res) => {
    const order = await salesOrderService.getSalesOrderById(req.params.orderId, req.query.companyId);
    return successResponse(res, order, SALES_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSalesOrderById',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_NOT_FOUND,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateSalesOrder = catchAsync(async (req, res) => {
  try {
    const orderBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const order = await salesOrderService.updateSalesOrderById(
      req.params.orderId,
      { ...orderBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, order, SALES_ORDER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updateSalesOrderById', controller: 'salesOrder' },
      res,
      error?.message || SALES_ORDER_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const updateSalesOrderStatus = catchAsync(
  async (req, res) => {
    const { status } = req.body;
    const order = await salesOrderService.updateSalesOrderStatus(req.params.orderId, req.query.companyId, status, req.user._id);
    return successResponse(res, order, SALES_ORDER_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateSalesOrderStatus',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const revertSalesOrderClose = catchAsync(
  async (req, res) => {
    const order = await salesOrderService.revertSalesOrderClose(req.params.orderId, req.query.companyId, req.user._id);
    return successResponse(res, order, SALES_ORDER_MESSAGES.REVERT_CLOSE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'revertSalesOrderClose',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.REVERT_CLOSE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteSalesOrder = catchAsync(
  async (req, res) => {
    await salesOrderService.deleteSalesOrderById(req.params.orderId, req.query.companyId, req.user._id);
    return successResponse(res, {}, SALES_ORDER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteSalesOrderById',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSalesOrderDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await salesOrderService.getSalesOrdersForDropdown(filter);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSalesOrdersForDropdown',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const openSalesOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'status', 'customerId']);
    const result = await salesOrderService.openSalesOrders(filter);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'openSalesOrders',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const partiallyConvertedItemList = catchAsync(
  async (req, res) => {
    const salesOrder = await salesOrderService.partiallyConvertedItemList(req.query.id, req.query.companyId);
    return successResponse(res, salesOrder, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'partiallyConvertedItemList',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSalesOrderWiseItemAnalysis = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'itemId',
      'customerId',
      'isSplit',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, pagination } = await salesOrderService.getSalesOrderWiseItemAnalysis(filter, options);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, pagination);
  },
  {
    service: 'getSalesOrderWiseItemAnalysis',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemWiseSalesOrderAnalysis = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'itemId',
      'customerId',
      'itemType',
      'itemGroupId',
      'isSplit',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, pagination } = await salesOrderService.getItemWiseSalesOrderAnalysis(filter, options);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, pagination);
  },
  {
    service: 'getItemWiseSalesOrderAnalysis',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerWiseSalesOrderAnalysis = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'branchId', 'divisionId', 'itemId', 'customerId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { result, pagination } = await salesOrderService.getCustomerWiseSalesOrderAnalysis(filter, options);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, pagination);
  },
  {
    service: 'getCustomerWiseSalesOrderAnalysis',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getNewVsOldCustomerReport = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'customerId',
      'itemId',
      'customerType',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination', 'oldPage', 'oldLimit', 'newPage', 'newLimit']);
    const { result, pagination } = await salesOrderService.getNewVsOldCustomerReport(filter, options);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, pagination);
  },
  {
    service: 'getNewVsOldCustomerReport',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getNewVsOldCustomerReportModuleData = catchAsync(
  async (req, res) => {
    const filter = {
      ...pick(req.query, ['companyId']),
      ...pick(req.body, ['customerId', 'moduleName', 'page', 'limit']),
    };
    const { data, ...pagination } = await salesOrderService.getNewVsOldCustomerReportModuleData(filter);
    return successResponse(res, data, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, pagination);
  },
  {
    service: 'getNewVsOldCustomerReportModuleData',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const salesOrderAnalysis = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'customerId',
      'itemId',
    ]);
    const result = await salesOrderService.salesOrderAnalysis(filter);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'salesOrderAnalysis',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const salesItemAnalysis = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'customerId',
      'itemId',
    ]);
    const result = await salesOrderService.salesItemAnalysis(filter);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'salesItemAnalysis',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const salesOrderRMAnalysis = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'customerId',
      'itemId',
    ]);
    const result = await salesOrderService.salesOrderRMAnalysis(filter);
    return successResponse(res, result, SALES_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'salesOrderRMAnalysis',
    controller: 'salesOrder',
    failureMessage: SALES_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createProductionOrder = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const productionOrder = await salesOrderService.createProductionOrder(
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, { productionOrder }, PRODUCTION_ORDER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createProductionOrder',
    controller: 'salesOrder',
    failureMessage: PRODUCTION_ORDER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createSalesOrder,
  getSalesOrders,
  getSalesOrdersExports,
  getSalesOrder,
  updateSalesOrder,
  updateSalesOrderStatus,
  revertSalesOrderClose,
  deleteSalesOrder,
  getSalesOrderDropdown,
  openSalesOrders,
  partiallyConvertedItemList,
  getSalesOrderWiseItemAnalysis,
  getItemWiseSalesOrderAnalysis,
  getCustomerWiseSalesOrderAnalysis,
  getNewVsOldCustomerReport,
  getNewVsOldCustomerReportModuleData,
  salesOrderAnalysis,
  salesItemAnalysis,
  salesOrderRMAnalysis,
  createProductionOrder,
};
