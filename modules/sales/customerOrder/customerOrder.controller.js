const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const customerOrderService = require('./customerOrder.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { CUSTOMER_ORDER_MESSAGES } = require('../../../utils/messages');
const customerOrderTransformers = require('./customerOrder.transformer');

const getCustomerOrders = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'search',
      'status',
      'orderType',
      'sampleCatalogId',
      'startDate',
      'endDate',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await customerOrderService.queryCustomerOrders(filter, options);
    const { results, ...otherFields } = result;
    const transformedOrders = customerOrderTransformers.queryCustomerOrders(results);
    return successResponse(res, transformedOrders, CUSTOMER_ORDER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryCustomerOrders',
    controller: 'customerOrder',
    failureMessage: CUSTOMER_ORDER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateCustomerOrderStatus = catchAsync(
  async (req, res) => {
    const { status, rejectionReason } = req.body;
    const order = await customerOrderService.updateCustomerOrderStatus(
      req.params.customerOrderId,
      req.query.companyId,
      status,
      req.user._id,
      rejectionReason,
    );
    return successResponse(res, order, CUSTOMER_ORDER_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCustomerOrderStatus',
    controller: 'customerOrder',
    failureMessage: CUSTOMER_ORDER_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCustomerOrder = catchAsync(
  async (req, res) => {
    const order = await customerOrderService.getCustomerOrderById(
      req.params.customerOrderId,
      req.query.companyId,
      req.query.branchId,
    );
    return successResponse(res, order, CUSTOMER_ORDER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomerOrderById',
    controller: 'customerOrder',
    failureMessage: CUSTOMER_ORDER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  getCustomerOrders,
  getCustomerOrder,
  updateCustomerOrderStatus,
};
