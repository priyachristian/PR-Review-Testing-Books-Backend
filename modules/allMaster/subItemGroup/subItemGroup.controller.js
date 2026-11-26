const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const subItemGroupService = require('./subItemGroup.service');
const { successResponse } = require('../../../services/response.service');
const { SUB_ITEM_GROUP_MESSAGES } = require('../../../utils/messages');
const subItemGroupTransformers = require('./subItemGroup.transformer');

const createSubItemGroup = catchAsync(
  async (req, res) => {
    const subItemGroup = await subItemGroupService.createSubItemGroup({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, subItemGroup, SUB_ITEM_GROUP_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createSubItemGroup',
    controller: 'subItemGroup',
    failureMessage: SUB_ITEM_GROUP_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getSubItemGroups = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['search', 'companyId', 'appName']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await subItemGroupService.querySubItemGroups(filter, options);
    const { results, ...otherFields } = result;
    const transformedResults = subItemGroupTransformers.querySubItemGroups(results);
    return successResponse(res, transformedResults, SUB_ITEM_GROUP_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'querySubItemGroups',
    controller: 'subItemGroup',
    failureMessage: SUB_ITEM_GROUP_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const subItemGroupDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = subItemGroupTransformers.subItemGroupDropdown(await subItemGroupService.subItemGroupDropdown(filter));
    return successResponse(res, result, SUB_ITEM_GROUP_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'subItemGroupDropdown',
    controller: 'subItemGroup',
    failureMessage: SUB_ITEM_GROUP_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getSubItemGroup = catchAsync(
  async (req, res) => {
    const subItemGroup = await subItemGroupService.getSubItemGroupById(req.params.subItemGroupId, req.query.companyId);
    return successResponse(
      res,
      subItemGroupTransformers.subItemGroup(subItemGroup),
      SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'getSubItemGroupById',
    controller: 'subItemGroup',
    failureMessage: SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateSubItemGroup = catchAsync(
  async (req, res) => {
    const subItemGroup = await subItemGroupService.updateSubItemGroupById(
      req.params.subItemGroupId,
      req.query.companyId,
      req.body,
    );
    return successResponse(res, subItemGroup, SUB_ITEM_GROUP_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateSubItemGroupById',
    controller: 'subItemGroup',
    failureMessage: SUB_ITEM_GROUP_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteSubItemGroup = catchAsync(
  async (req, res) => {
    await subItemGroupService.deleteSubItemGroupById(req.params.subItemGroupId, req.query.companyId);
    return successResponse(res, {}, SUB_ITEM_GROUP_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteSubItemGroupById',
    controller: 'subItemGroup',
    failureMessage: SUB_ITEM_GROUP_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createSubItemGroup,
  getSubItemGroups,
  getSubItemGroup,
  updateSubItemGroup,
  deleteSubItemGroup,
  subItemGroupDropdown,
};
