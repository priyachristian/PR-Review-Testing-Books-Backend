const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const itemGroupService = require('./itemGroup.service');
const { successResponse } = require('../../../services/response.service');
const { ITEM_GROUP_MESSAGES } = require('../../../utils/messages');
const itemGroupTransformers = require('./itemGroup.transformer');

const createItemGroup = catchAsync(
  async (req, res) => {
    const itemGroup = await itemGroupService.createItemGroup({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, itemGroup, ITEM_GROUP_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createItemGroup',
    controller: 'itemGroup',
    failureMessage: ITEM_GROUP_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemGroups = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['search', 'companyId', 'appName']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await itemGroupService.queryItemGroups(filter, options);
    const { results, ...otherFields } = result;
    const transformedResults = itemGroupTransformers.queryItemGroups(results);
    return successResponse(res, transformedResults, ITEM_GROUP_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryItemGroups',
    controller: 'itemGroup',
    failureMessage: ITEM_GROUP_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const itemGroupDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await itemGroupService.itemGroupDropdown(filter);
    return successResponse(res, result, ITEM_GROUP_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'itemGroupDropdown',
    controller: 'itemGroup',
    failureMessage: ITEM_GROUP_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemGroup = catchAsync(
  async (req, res) => {
    const itemGroup = await itemGroupService.getItemGroupById(req.params.itemGroupId, req.query.companyId);
    return successResponse(res, itemGroup, ITEM_GROUP_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemGroupById',
    controller: 'itemGroup',
    failureMessage: ITEM_GROUP_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateItemGroup = catchAsync(
  async (req, res) => {
    const itemGroup = await itemGroupService.updateItemGroupById(req.params.itemGroupId, req.query.companyId, req.body);
    return successResponse(res, itemGroup, ITEM_GROUP_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateItemGroupById',
    controller: 'itemGroup',
    failureMessage: ITEM_GROUP_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteItemGroup = catchAsync(
  async (req, res) => {
    const deleted = await itemGroupService.deleteItemGroupById(req.params.itemGroupId, req.query.companyId);
    return successResponse(res, {}, ITEM_GROUP_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteItemGroupById',
    controller: 'itemGroup',
    failureMessage: ITEM_GROUP_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createItemGroup,
  getItemGroups,
  getItemGroup,
  updateItemGroup,
  deleteItemGroup,
  itemGroupDropdown,
};
