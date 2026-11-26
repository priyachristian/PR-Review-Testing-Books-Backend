const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const partRequestService = require('./partRequest.service');
const pick = require('../../../utils/pick');
const { PART_REQUEST_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');

const getAllPartRequests = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await partRequestService.getAllPartRequests(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, PART_REQUEST_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllPartRequests',
    controller: 'partRequest',
    failureMessage: PART_REQUEST_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPartRequestById = catchAsync(
  async (req, res) => {
    const result = await partRequestService.getPartRequestById(req.params.id, req.query.companyId);
    return successResponse(res, result, PART_REQUEST_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPartRequestById',
    controller: 'partRequest',
    failureMessage: PART_REQUEST_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const approvePartRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await partRequestService.approvePartRequest(req.params.id, companyId, req.body, req.user._id);
    const result = await partRequestService.getPartRequestById(req.params.id, companyId);
    return successResponse(res, result, PART_REQUEST_MESSAGES.APPROVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'approvePartRequest',
    controller: 'partRequest',
    failureMessage: PART_REQUEST_MESSAGES.APPROVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const issuePartRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await partRequestService.issuePartRequest(req.params.id, companyId, req.body, req.user._id);
    const result = await partRequestService.getPartRequestById(req.params.id, companyId);
    return successResponse(res, result, PART_REQUEST_MESSAGES.ISSUE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'issuePartRequest',
    controller: 'partRequest',
    failureMessage: PART_REQUEST_MESSAGES.ISSUE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const shortPartRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await partRequestService.shortPartRequest(req.params.id, companyId, req.user._id);
    const result = await partRequestService.getPartRequestById(req.params.id, companyId);
    return successResponse(res, result, PART_REQUEST_MESSAGES.SHORT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'shortPartRequest',
    controller: 'partRequest',
    failureMessage: PART_REQUEST_MESSAGES.SHORT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getAllPartRequests,
  getPartRequestById,
  approvePartRequest,
  issuePartRequest,
  shortPartRequest,
};
