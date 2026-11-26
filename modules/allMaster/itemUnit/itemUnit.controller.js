const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const itemUnitService = require('./itemUnit.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { ITEM_UNIT_MESSAGES } = require('../../../utils/messages');

const createItemUnit = catchAsync(
  async (req, res) => {
    const itemUnit = await itemUnitService.createItemUnit({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, { itemUnit }, ITEM_UNIT_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createItemUnit',
    controller: 'itemUnit',
    failureMessage: ITEM_UNIT_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemUnits = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'isActive']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { results, ...otherFields } = await itemUnitService.getItemUnits(filter, options);
    return successResponse(res, results, ITEM_UNIT_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getItemUnits',
    controller: 'itemUnit',
    failureMessage: ITEM_UNIT_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemUnitsDropdown = catchAsync(
  async (req, res) => {
    const result = await itemUnitService.getItemUnitsDropdown(req.query.companyId);
    return successResponse(res, { result }, ITEM_UNIT_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemUnitsDropdown',
    controller: 'itemUnit',
    failureMessage: ITEM_UNIT_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemUnitById = catchAsync(
  async (req, res) => {
    const itemUnit = await itemUnitService.getItemUnitById(req.params.itemUnitId, req.query.companyId);
    return successResponse(res, itemUnit, ITEM_UNIT_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemUnitById',
    controller: 'itemUnit',
    failureMessage: ITEM_UNIT_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateItemUnit = catchAsync(
  async (req, res) => {
    const itemUnit = await itemUnitService.updateItemUnit(
      req.params.itemUnitId,
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, { itemUnit }, ITEM_UNIT_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateItemUnit',
    controller: 'itemUnit',
    failureMessage: ITEM_UNIT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateItemUnitStatus = catchAsync(
  async (req, res) => {
    const { isActive, companyId } = req.query;
    const itemUnit = await itemUnitService.updateItemUnitStatus(req.params.itemUnitId, isActive, companyId, req.user._id);
    return successResponse(res, { itemUnit }, ITEM_UNIT_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateItemUnitStatus',
    controller: 'itemUnit',
    failureMessage: ITEM_UNIT_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteItemUnit = catchAsync(
  async (req, res) => {
    await itemUnitService.deleteItemUnit(req.params.itemUnitId, req.query.companyId);
    return successResponse(res, {}, ITEM_UNIT_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteItemUnit',
    controller: 'itemUnit',
    failureMessage: ITEM_UNIT_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createItemUnit,
  getItemUnits,
  getItemUnitsDropdown,
  getItemUnitById,
  updateItemUnit,
  updateItemUnitStatus,
  deleteItemUnit,
};
