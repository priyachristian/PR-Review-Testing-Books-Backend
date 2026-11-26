const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const paymentTermService = require('./paymentTerm.service');
const { successResponse } = require('../../../services/response.service');
const { PAYMENT_TERM_MESSAGES } = require('../../../utils/messages');

const createPaymentTerm = catchAsync(
  async (req, res) => {
    const paymentTerm = await paymentTermService.createPaymentTerm({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, { paymentTerm }, PAYMENT_TERM_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createPaymentTerm',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getPaymentTerms = catchAsync(
  async (req, res) => {
    const result = await paymentTermService.queryPaymentTerms(req.query);
    const { results, ...otherFields } = result;
    return successResponse(res, results, PAYMENT_TERM_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryPaymentTerms',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getPaymentTermsDropdown = catchAsync(
  async (req, res) => {
    const paymentTerms = await paymentTermService.getPaymentTermsDropdown(req.query.companyId);
    return successResponse(res, paymentTerms, PAYMENT_TERM_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPaymentTermsDropdown',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getPaymentTermById = catchAsync(
  async (req, res) => {
    const paymentTerm = await paymentTermService.getPaymentTermById(req.params.paymentTermId, req.query.companyId);
    return successResponse(res, paymentTerm, PAYMENT_TERM_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPaymentTermById',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updatePaymentTerm = catchAsync(
  async (req, res) => {
    const paymentTerm = await paymentTermService.updatePaymentTermById(
      req.params.paymentTermId,
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, { paymentTerm }, PAYMENT_TERM_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updatePaymentTermById',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const { isActive, companyId } = req.query;
    const paymentTerm = await paymentTermService.updateStatus(req.params.paymentTermId, isActive, companyId, req.user._id);
    return successResponse(res, { paymentTerm }, PAYMENT_TERM_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateStatus',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const setDefaultPaymentTerm = catchAsync(
  async (req, res) => {
    const paymentTerm = await paymentTermService.setDefaultPaymentTerm(
      req.params.paymentTermId,
      req.query.companyId,
      req.user._id,
    );
    return successResponse(res, { paymentTerm }, PAYMENT_TERM_MESSAGES.SET_DEFAULT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'setDefaultPaymentTerm',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.SET_DEFAULT_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deletePaymentTerm = catchAsync(
  async (req, res) => {
    await paymentTermService.deletePaymentTermById(req.params.paymentTermId, req.query.companyId);
    return successResponse(res, {}, PAYMENT_TERM_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deletePaymentTermById',
    controller: 'paymentTerm',
    failureMessage: PAYMENT_TERM_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createPaymentTerm,
  getPaymentTerms,
  getPaymentTermsDropdown,
  getPaymentTermById,
  updatePaymentTerm,
  updateStatus,
  setDefaultPaymentTerm,
  deletePaymentTerm,
};
