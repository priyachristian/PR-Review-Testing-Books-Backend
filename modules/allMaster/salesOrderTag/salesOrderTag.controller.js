const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const salesOrderTagService = require('./salesOrderTag.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { SALES_ORDER_TAG_MESSAGES } = require('../../../utils/messages');

const createTag = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const tag = await salesOrderTagService.createTag({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { tag }, SALES_ORDER_TAG_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createTag',
    controller: 'salesOrderTag',
    failureMessage: SALES_ORDER_TAG_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTags = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'appName', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await salesOrderTagService.getTagsByCompanyId(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, SALES_ORDER_TAG_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getTagsByCompanyId',
    controller: 'salesOrderTag',
    failureMessage: SALES_ORDER_TAG_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTagDropdown = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const tags = await salesOrderTagService.getTagDropdown(companyId);
    return successResponse(res, { result: tags }, SALES_ORDER_TAG_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTagDropdown',
    controller: 'salesOrderTag',
    failureMessage: SALES_ORDER_TAG_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateTag = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const tag = await salesOrderTagService.updateTagById(
      req.params.tagId,
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, { tag }, SALES_ORDER_TAG_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateTagById',
    controller: 'salesOrderTag',
    failureMessage: SALES_ORDER_TAG_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteTag = catchAsync(
  async (req, res) => {
    await salesOrderTagService.deleteTagById(req.params.tagId, req.query.companyId);
    return successResponse(res, {}, SALES_ORDER_TAG_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteTagById',
    controller: 'salesOrderTag',
    failureMessage: SALES_ORDER_TAG_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTagById = catchAsync(
  async (req, res) => {
    const tag = await salesOrderTagService.getTagById(req.params.tagId, req.query.companyId);
    return successResponse(res, tag, SALES_ORDER_TAG_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTagById',
    controller: 'salesOrderTag',
    failureMessage: SALES_ORDER_TAG_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createTag,
  getTags,
  getTagDropdown,
  updateTag,
  deleteTag,
  getTagById,
};
