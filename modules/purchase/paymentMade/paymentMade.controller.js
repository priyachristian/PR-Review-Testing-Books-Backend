const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const paymentMadeService = require('./paymentMade.service');
const { successResponse } = require('../../../services/response.service');
const { PAYMENT_MADE_MESSAGES, PAYMENT_MESSAGES } = require('../../../utils/messages');
const paymentMadeTransformers = require('./paymentMade.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createPaymentMade = catchAsync(
  async (req, res) => {
    const paymentBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const paymentMade = await paymentMadeService.createPaymentMade(
      { ...paymentBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, paymentMade, PAYMENT_MADE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createPaymentMade',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPaymentMades = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'paymentMadeId',
      'companyId',
      'customerId',
      'country',
      'state',
      'city',
      'status',
      'paymentDate',
      'paidThroughAccountId',
      'isSplit',
      'paymentMode',
      'branchId',
      'divisionId',
      'isPendingMapping',
      'startDate',
      'endDate',
      'addedBy',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await paymentMadeService.queryPaymentMades(req.query, filter, options);
    const { results, ...otherFields } = result;
    const transformedPayments = paymentMadeTransformers.getPaymentMades(results, filter?.isSplit);
    return successResponse(res, transformedPayments, PAYMENT_MADE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryPaymentMades',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPaymentMadesExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'paymentMadeId',
      'companyId',
      'customerId',
      'country',
      'state',
      'city',
      'status',
      'paymentDate',
      'paidThroughAccountId',
      'isSplit',
      'paymentMode',
      'branchId',
      'divisionId',
      'isPendingMapping',
      'startDate',
      'endDate',
      'addedBy',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await paymentMadeService.queryPaymentMadesExports(req.query, filter, options);
    const { results, ...otherFields } = result;
    const transformedPayments = paymentMadeTransformers.getPaymentMades(results, filter?.isSplit);
    return successResponse(res, transformedPayments, PAYMENT_MADE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryPaymentMadesExports',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPaymentMade = catchAsync(
  async (req, res) => {
    const paymentMade = await paymentMadeService.getPaymentMadeById(req.params.paymentMadeId, req.query.companyId);
    return successResponse(res, paymentMade, PAYMENT_MADE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPaymentMadeById',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updatePaymentMade = catchAsync(
  async (req, res) => {
    const paymentBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const paymentMade = await paymentMadeService.updatePaymentMadeById(
      req.params.paymentMadeId,
      { ...paymentBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, paymentMade, PAYMENT_MADE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updatePaymentMadeById',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deletePaymentMade = catchAsync(
  async (req, res) => {
    await paymentMadeService.deletePaymentMadeById(req.params.paymentMadeId, req.query.companyId, req.user._id);
    return successResponse(res, {}, PAYMENT_MADE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deletePaymentMadeById',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const approvePaymentMade = catchAsync(
  async (req, res) => {
    const { paymentMadeId } = req.params;
    const paymentBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const approvedPayment = await paymentMadeService.approvePaymentMadeById(
      paymentMadeId,
      req.query.companyId,
      paymentBody,
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, approvedPayment, PAYMENT_MADE_MESSAGES.APPROVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'approvePaymentMadeById',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.APPROVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const rejectPaymentMade = catchAsync(
  async (req, res) => {
    const { paymentMadeId } = req.params;
    const paymentBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const approvedPayment = await paymentMadeService.rejectPaymentMadeById(
      paymentMadeId,
      req.query.companyId,
      paymentBody,
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, approvedPayment, PAYMENT_MADE_MESSAGES.REJECT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'rejectPaymentMadeById',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.REJECT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const cancelPaymentMade = catchAsync(
  async (req, res) => {
    const { paymentMadeId } = req.params;
    const { notes } = req.body;
    const cancelledPayment = await paymentMadeService.cancelPaymentMadeById(
      paymentMadeId,
      req.query.companyId,
      notes,
      req.user._id,
    );
    return successResponse(res, cancelledPayment, PAYMENT_MADE_MESSAGES.CANCEL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'cancelPaymentMadeById',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.CANCEL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deletePaymentMadeBill = catchAsync(
  async (req, res) => {
    const { paymentMadeId } = req.params;
    const cancelledPayment = await paymentMadeService.deletePaymentMadeBill(
      paymentMadeId,
      req.query.companyId,
      req.body,
      req.user._id,
    );
    return successResponse(res, cancelledPayment, PAYMENT_MADE_MESSAGES.DELETE_BILL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deletePaymentMadeBill',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.DELETE_BILL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const applyAdvancePaymentMadeAgainstBill = catchAsync(
  async (req, res) => {
    const { bills = [], openingBalanceTransactions = [], expenses = [] } = req.body;
    const paymentMade = await paymentMadeService.applyAdvancePaymentMadeAgainstBill(
      req.params.paymentMadeId,
      req.query.companyId,
      bills,
      openingBalanceTransactions,
      req.user._id,
      expenses,
    );
    return successResponse(res, paymentMade, PAYMENT_MADE_MESSAGES.APPLY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'applyAdvancePaymentMadeAgainstBill',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.APPLY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const removeAdvancePaymentMadeAgainstBill = catchAsync(
  async (req, res) => {
    const paymentMade = await paymentMadeService.removeAdvancePaymentMadeAgainstBill(
      req.params.paymentMadeId,
      req.query.companyId,
      req.body,
      req.user._id,
    );
    return successResponse(res, paymentMade, PAYMENT_MADE_MESSAGES.REMOVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'removeAdvancePaymentMadeAgainstBill',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.REMOVE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const autoApplyPendingAdvancePaymentMade = catchAsync(
  async (req, res) => {
    const payload = await paymentMadeService.autoApplyPendingAdvancePaymentMade(
      req.query.companyId,
      req.user._id,
      req.query.customerId,
    );
    return successResponse(
      res,
      payload,
      payload?.success ? PAYMENT_MADE_MESSAGES.AUTO_APPLY_COMPLETED : PAYMENT_MADE_MESSAGES.AUTO_APPLY_PARTIAL_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'autoApplyPendingAdvancePaymentMade',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MADE_MESSAGES.AUTO_APPLY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const addRefund = catchAsync(
  async (req, res) => {
    const refund = await paymentMadeService.addRefund(req.body, req.query.companyId);
    return successResponse(res, refund, PAYMENT_MESSAGES.ADD_REFUND, httpStatus.OK);
  },
  {
    service: 'addRefund',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MESSAGES.ADD_REFUND_FAILED,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteRefund = catchAsync(
  async (req, res) => {
    const { paymentMadeId, refundId } = req.params;
    await paymentMadeService.deleteRefund(paymentMadeId, refundId, req.query.companyId);
    return successResponse(res, {}, PAYMENT_MESSAGES.DELETE_REFUND, httpStatus.OK);
  },
  {
    service: 'deleteRefund',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MESSAGES.DELETE_REFUND_FAILED,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRefund = catchAsync(
  async (req, res) => {
    const { paymentMadeId } = req.params;
    const refund = await paymentMadeService.updateRefund(req.body, paymentMadeId, req.query.companyId);
    return successResponse(res, refund, PAYMENT_MESSAGES.UPDATE_REFUND, httpStatus.OK);
  },
  {
    service: 'updateRefund',
    controller: 'paymentMade',
    failureMessage: PAYMENT_MESSAGES.UPDATE_REFUND_FAILED,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createPaymentMade,
  getPaymentMades,
  getPaymentMadesExports,
  getPaymentMade,
  updatePaymentMade,
  deletePaymentMade,
  approvePaymentMade,
  rejectPaymentMade,
  cancelPaymentMade,
  deletePaymentMadeBill,
  applyAdvancePaymentMadeAgainstBill,
  removeAdvancePaymentMadeAgainstBill,
  autoApplyPendingAdvancePaymentMade,
  addRefund,
  deleteRefund,
  updateRefund,
};
