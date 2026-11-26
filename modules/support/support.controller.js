const httpStatus = require('http-status');
const pick = require('../../utils/pick');
const catchAsync = require('../../utils/catchAsync');
const supportService = require('./support.service');
const { successResponse } = require('../../services/response.service');
const { SUPPORT_MESSAGE } = require('../../utils/messages');
const { getUploadedFiles } = require('../../utils/fileUploadHelper');

const createSupport = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const attachments = getUploadedFiles(req, 'attachment');
    const support = await supportService.createSupport(req.body, userId, req.query?.companyId, attachments);
    return successResponse(res, support, SUPPORT_MESSAGE.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createSupport',
    controller: 'support',
    failureMessage: SUPPORT_MESSAGE.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSupports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'category', 'status', 'priority', 'moduleName', 'raisedBy']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await supportService.querySupports(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, SUPPORT_MESSAGE.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'querySupports',
    controller: 'support',
    failureMessage: SUPPORT_MESSAGE.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSupport = catchAsync(
  async (req, res) => {
    const support = await supportService.getSupportById(req.params.supportId, req.query.companyId);
    return successResponse(res, support, SUPPORT_MESSAGE.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSupportById',
    controller: 'support',
    failureMessage: SUPPORT_MESSAGE.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateSupport = catchAsync(
  async (req, res) => {
    const support = await supportService.updateSupportById(req.params.supportId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, support, SUPPORT_MESSAGE.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateSupportById',
    controller: 'support',
    failureMessage: SUPPORT_MESSAGE.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const addComment = catchAsync(
  async (req, res) => {
    const support = await supportService.addCommentToSupport(req.params.supportId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, support, SUPPORT_MESSAGE.COMMENT_ADDED_SUCCESS, httpStatus.OK);
  },
  {
    service: 'addCommentToSupport',
    controller: 'support',
    failureMessage: SUPPORT_MESSAGE.COMMENT_ADDED_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const support = await supportService.updateSupportStatus(req.params.supportId, req.query.companyId, req.body);
    return successResponse(res, support, SUPPORT_MESSAGE.STATUS_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateSupportStatus',
    controller: 'support',
    failureMessage: SUPPORT_MESSAGE.STATUS_UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createSupport,
  getSupports,
  getSupport,
  updateSupport,
  addComment,
  updateStatus,
};
