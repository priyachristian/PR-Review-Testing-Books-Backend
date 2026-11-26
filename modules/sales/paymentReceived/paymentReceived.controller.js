const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const paymentReceivedService = require('./paymentReceived.service');
const { successResponse } = require('../../../services/response.service');
const { PAYMENT_MESSAGES } = require('../../../utils/messages');
const paymentReceivedTransformers = require('./paymentReceived.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createPaymentReceived = catchAsync(
  async (req, res) => {
    const paymentBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const payment = await paymentReceivedService.createPayment(
      { ...paymentBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, payment, PAYMENT_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createPayment',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPayments = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'paymentReceivedId',
      'companyId',
      'customerId',
      'country',
      'state',
      'city',
      'paymentDate',
      'search',
      'startDate',
      'endDate',
      'status',
      'depositToAccountId',
      'isSplit',
      'paymentMode',
      'branchId',
      'divisionId',
      'isPendingMapping',
      'appName',
      'addedBy',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await paymentReceivedService.queryPayments(filter, options);
    const { results, ...otherFields } = result;
    const transformedPayments = paymentReceivedTransformers.queryPayments(results, filter?.isSplit);
    return successResponse(res, transformedPayments, PAYMENT_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryPayments',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPaymentsExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'paymentReceivedId',
      'companyId',
      'customerId',
      'country',
      'state',
      'city',
      'paymentDate',
      'search',
      'startDate',
      'endDate',
      'status',
      'depositToAccountId',
      'isSplit',
      'paymentMode',
      'branchId',
      'divisionId',
      'isPendingMapping',
      'appName',
      'addedBy',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await paymentReceivedService.queryPaymentsExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedPayments = paymentReceivedTransformers.queryPayments(results, filter?.isSplit);
    return successResponse(res, transformedPayments, PAYMENT_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryPaymentsExports',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPayment = catchAsync(
  async (req, res) => {
    const payment = await paymentReceivedService.getPaymentById(req.params.paymentReceivedId, req.query.companyId);
    return successResponse(res, payment, PAYMENT_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPaymentById',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updatePaymentReceived = catchAsync(
  async (req, res) => {
    const paymentBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const payment = await paymentReceivedService.updatePaymentById(
      req.params.paymentReceivedId,
      { ...paymentBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, payment, PAYMENT_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updatePaymentById',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deletePayment = catchAsync(
  async (req, res) => {
    await paymentReceivedService.deletePaymentById(req.params.paymentReceivedId, req.query.companyId, req.user._id);
    return successResponse(res, {}, PAYMENT_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deletePaymentById',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const approvePaymentReceived = catchAsync(
  async (req, res) => {
    const { paymentReceivedId } = req.params;
    const { approvalNote, chequeReceivedDate, depositDate, clearingDate, chequeApprovalNote } = req.body;
    const approvedPayment = await paymentReceivedService.approvePaymentReceivedById(
      paymentReceivedId,
      req.query.companyId,
      approvalNote,
      req.user._id,
      chequeReceivedDate,
      depositDate,
      clearingDate,
      chequeApprovalNote,
    );
    return successResponse(res, approvedPayment, PAYMENT_MESSAGES.APPROVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'approvePaymentReceivedById',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.APPROVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const rejectPaymentReceived = catchAsync(
  async (req, res) => {
    const { paymentReceivedId } = req.params;
    const { notes, approvalNote, chequeReceivedDate, depositDate, clearingDate, chequeApprovalNote } = req.body;
    const approvedPayment = await paymentReceivedService.rejectPaymentReceivedById(
      paymentReceivedId,
      req.query.companyId,
      notes,
      req.user._id,
      chequeReceivedDate,
      depositDate,
      clearingDate,
      chequeApprovalNote,
      approvalNote,
    );
    return successResponse(res, approvedPayment, PAYMENT_MESSAGES.REJECT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'rejectPaymentReceivedById',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.REJECT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const cancelPaymentReceived = catchAsync(
  async (req, res) => {
    const { paymentReceivedId } = req.params;
    const { notes } = req.body;
    const cancelledPayment = await paymentReceivedService.cancelPaymentReceivedById(
      paymentReceivedId,
      req.query.companyId,
      notes,
      req.user._id,
    );
    return successResponse(res, cancelledPayment, PAYMENT_MESSAGES.CANCEL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'cancelPaymentReceivedById',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.CANCEL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deletePaymentReceiveInvoice = catchAsync(
  async (req, res) => {
    await paymentReceivedService.deletePaymentReceiveInvoice(
      req.params.paymentReceivedId,
      req.query.companyId,
      req.body,
      req.user._id,
    );
    return successResponse(res, {}, PAYMENT_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deletePaymentReceiveInvoice',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const applyAdvancePaymentReceivedAgainstInvoice = catchAsync(
  async (req, res) => {
    const { invoices = [], openingBalanceTransactions = [], expenses = [] } = req.body;
    const paymentReceived = await paymentReceivedService.applyAdvancePaymentReceivedAgainstInvoice(
      req.params.paymentReceivedId,
      req.query.companyId,
      invoices,
      openingBalanceTransactions,
      req.user._id,
      expenses,
    );
    return successResponse(res, paymentReceived, PAYMENT_MESSAGES.APPLY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'applyAdvancePaymentReceivedAgainstInvoice',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.APPLY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const removeAdvancePaymentReceivedAgainstInvoice = catchAsync(
  async (req, res) => {
    const paymentReceived = await paymentReceivedService.removeAdvancePaymentReceivedAgainstInvoice(
      req.params.paymentReceivedId,
      req.query.companyId,
      req.body,
      req.user._id,
    );
    return successResponse(res, paymentReceived, PAYMENT_MESSAGES.REMOVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'removeAdvancePaymentReceivedAgainstInvoice',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.REMOVE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const autoApplyPendingAdvancePayments = catchAsync(
  async (req, res) => {
    const payload = await paymentReceivedService.autoApplyPendingAdvancePayments(
      req.query.companyId,
      req.user._id,
      req.query.customerId,
    );
    return successResponse(
      res,
      payload,
      payload?.success ? PAYMENT_MESSAGES.AUTO_APPLY_COMPLETED : PAYMENT_MESSAGES.AUTO_APPLY_PARTIAL_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'autoApplyPendingAdvancePayments',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.AUTO_APPLY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const addRefund = catchAsync(
  async (req, res) => {
    const refund = await paymentReceivedService.addRefund(req.body, req.query.companyId);
    return successResponse(res, refund, PAYMENT_MESSAGES.ADD_REFUND, httpStatus.OK);
  },
  {
    service: 'addRefund',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.ADD_REFUND_FAILED,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteRefund = catchAsync(
  async (req, res) => {
    const { paymentReceivedId, refundId } = req.params;
    await paymentReceivedService.deleteRefund(paymentReceivedId, refundId, req.query.companyId);
    return successResponse(res, {}, PAYMENT_MESSAGES.DELETE_REFUND, httpStatus.OK);
  },
  {
    service: 'deleteRefund',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.DELETE_REFUND_FAILED,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRefund = catchAsync(
  async (req, res) => {
    const { paymentReceivedId } = req.params;
    const refund = await paymentReceivedService.updateRefund(req.body, paymentReceivedId, req.query.companyId);
    return successResponse(res, refund, PAYMENT_MESSAGES.UPDATE_REFUND, httpStatus.OK);
  },
  {
    service: 'updateRefund',
    controller: 'paymentReceived',
    failureMessage: PAYMENT_MESSAGES.UPDATE_REFUND_FAILED,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createPaymentReceived,
  getPayments,
  getPaymentsExports,
  getPayment,
  updatePaymentReceived,
  deletePayment,
  approvePaymentReceived,
  rejectPaymentReceived,
  cancelPaymentReceived,
  deletePaymentReceiveInvoice,
  applyAdvancePaymentReceivedAgainstInvoice,
  removeAdvancePaymentReceivedAgainstInvoice,
  autoApplyPendingAdvancePayments,
  addRefund,
  deleteRefund,
  updateRefund,
};
