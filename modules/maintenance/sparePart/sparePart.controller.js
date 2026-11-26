const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const sparePartService = require('./sparePart.service');
const pick = require('../../../utils/pick');
const { SPARE_PART_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');

const createSparePart = catchAsync(
  async (req, res) => {
    await sparePartService.createSparePart({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, null, SPARE_PART_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createSparePart',
    controller: 'sparePart',
    failureMessage: SPARE_PART_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllSpareParts = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isActive']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await sparePartService.getAllSpareParts(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, SPARE_PART_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllSpareParts',
    controller: 'sparePart',
    failureMessage: SPARE_PART_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSparePartById = catchAsync(
  async (req, res) => {
    const sparePart = await sparePartService.getSparePartById(req.params.id, req.query.companyId);
    return successResponse(res, sparePart, SPARE_PART_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSparePartById',
    controller: 'sparePart',
    failureMessage: SPARE_PART_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateSparePartById = catchAsync(
  async (req, res) => {
    await sparePartService.updateSparePartById(req.params.id, req.body, req.query.companyId, req.user._id);
    return successResponse(res, null, SPARE_PART_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateSparePartById',
    controller: 'sparePart',
    failureMessage: SPARE_PART_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateActiveStatus = catchAsync(
  async (req, res) => {
    const { isActive, companyId } = req.query;
    await sparePartService.updateActiveStatus(req.params.id, isActive, companyId, req.user._id);
    return successResponse(res, null, SPARE_PART_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateActiveStatus',
    controller: 'sparePart',
    failureMessage: SPARE_PART_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteSparePartById = catchAsync(
  async (req, res) => {
    await sparePartService.deleteSparePartById(req.params.id, req.query.companyId);
    return successResponse(res, null, SPARE_PART_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteSparePartById',
    controller: 'sparePart',
    failureMessage: SPARE_PART_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getSparePartDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'category', 'machineId']);
    const result = await sparePartService.getSparePartDropdown(filter);
    return successResponse(res, result, SPARE_PART_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getSparePartDropdown',
    controller: 'sparePart',
    failureMessage: SPARE_PART_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createSparePart,
  getAllSpareParts,
  getSparePartById,
  updateSparePartById,
  updateActiveStatus,
  deleteSparePartById,
  getSparePartDropdown,
};
