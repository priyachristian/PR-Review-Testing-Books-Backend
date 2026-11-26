const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const customerPaymentService = require('./customerPayment.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');

const CUSTOMER_PAYMENT_MESSAGES = {
  FETCH_ALL_SUCCESS: 'Customer payments retrieved successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving customer payments',
  FETCH_ONE_SUCCESS: 'Customer payment fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch customer payment',
  REJECT_SUCCESS: 'Customer payment rejected',
  REJECT_FAILURE: 'Failed to reject customer payment',
  RECORD_SUCCESS: 'Customer payment recorded',
  RECORD_FAILURE: 'Failed to record customer payment',
};

const getCustomerPayments = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'search',
      'status',
      'paymentMode',
      'paymentDate',
      'startDate',
      'endDate',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await customerPaymentService.queryCustomerPayments(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, CUSTOMER_PAYMENT_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryCustomerPayments',
    controller: 'customerPayment',
    failureMessage: CUSTOMER_PAYMENT_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCustomerPayment = catchAsync(
  async (req, res) => {
    const payment = await customerPaymentService.getCustomerPaymentById(req.params.customerPaymentId, req.query.companyId);
    return successResponse(res, payment, CUSTOMER_PAYMENT_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomerPaymentById',
    controller: 'customerPayment',
    failureMessage: CUSTOMER_PAYMENT_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const rejectCustomerPayment = catchAsync(
  async (req, res) => {
    const payment = await customerPaymentService.rejectCustomerPayment(
      req.params.customerPaymentId,
      req.query.companyId,
      req.body.rejectionReason,
      req.user._id,
    );
    return successResponse(res, payment, CUSTOMER_PAYMENT_MESSAGES.REJECT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'rejectCustomerPayment',
    controller: 'customerPayment',
    failureMessage: CUSTOMER_PAYMENT_MESSAGES.REJECT_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const recordCustomerPayment = catchAsync(
  async (req, res) => {
    const { paymentReceivedId, paymentReceivedNo } = req.body;
    const payment = await customerPaymentService.recordCustomerPayment(
      req.params.customerPaymentId,
      req.query.companyId,
      { paymentReceivedId, paymentReceivedNo },
      req.user._id,
    );
    return successResponse(res, payment, CUSTOMER_PAYMENT_MESSAGES.RECORD_SUCCESS, httpStatus.OK);
  },
  {
    service: 'recordCustomerPayment',
    controller: 'customerPayment',
    failureMessage: CUSTOMER_PAYMENT_MESSAGES.RECORD_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  getCustomerPayments,
  getCustomerPayment,
  rejectCustomerPayment,
  recordCustomerPayment,
};
