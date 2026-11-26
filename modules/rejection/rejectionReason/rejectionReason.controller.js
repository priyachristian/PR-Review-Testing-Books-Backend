const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const pick = require('../../../utils/pick');
const rejectionReasonService = require('./rejectionReason.service');
const { successResponse } = require('../../../services/response.service');
const { REJECTION_REASON_MESSAGES } = require('../../../utils/messages');

const createRejectionReason = catchAsync(
  async (req, res) => {
    const rejectionReason = await rejectionReasonService.createRejectionReason({
      ...req.body,
      companyId: req.query.companyId,
    });
    return successResponse(res, rejectionReason, REJECTION_REASON_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createRejectionReason',
    controller: 'rejectionReason',
    failureMessage: REJECTION_REASON_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRejectionReasons = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'parentReasonId', 'isActive']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await rejectionReasonService.getRejectionReasons(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, REJECTION_REASON_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getRejectionReasons',
    controller: 'rejectionReason',
    failureMessage: REJECTION_REASON_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getRejectionReasonById = catchAsync(
  async (req, res) => {
    const rejectionReason = await rejectionReasonService.getRejectionReasonById(req.params.id, req.query.companyId);
    return successResponse(res, rejectionReason, REJECTION_REASON_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionReasonById',
    controller: 'rejectionReason',
    failureMessage: REJECTION_REASON_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateRejectionReason = catchAsync(
  async (req, res) => {
    const rejectionReason = await rejectionReasonService.updateRejectionReasonById(req.params.id, req.body, req.query.companyId);
    return successResponse(res, rejectionReason, REJECTION_REASON_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRejectionReasonById',
    controller: 'rejectionReason',
    failureMessage: REJECTION_REASON_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteRejectionReason = catchAsync(
  async (req, res) => {
    await rejectionReasonService.deleteRejectionReasonById(req.params.id, req.query.companyId);
    return successResponse(res, {}, REJECTION_REASON_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteRejectionReasonById',
    controller: 'rejectionReason',
    failureMessage: REJECTION_REASON_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createRejectionReason,
  getRejectionReasons,
  getRejectionReasonById,
  updateRejectionReason,
  deleteRejectionReason,
};
