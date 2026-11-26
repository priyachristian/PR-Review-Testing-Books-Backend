const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const manPowerService = require('./manPower.service');
const pick = require('../../../utils/pick');
const { MANPOWER_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');

const createManPower = catchAsync(
  async (req, res) => {
    const manPower = await manPowerService.createManPower({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, manPower, MANPOWER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createManPower',
    controller: 'manPower',
    failureMessage: MANPOWER_MESSAGES.FAILED_TO_CREATE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllManPower = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await manPowerService.getAllManPower(req.query, filter, options);
    const { results, nextWorkerNo, ...otherFields } = result;
    otherFields.nextWorkerNo = nextWorkerNo;
    return successResponse(res, results, MANPOWER_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllManPower',
    controller: 'manPower',
    failureMessage: MANPOWER_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getManPowerById = catchAsync(
  async (req, res) => {
    const manPower = await manPowerService.getManPowerById(req.params.id, req.query.companyId);
    return successResponse(res, manPower, MANPOWER_MESSAGES.RETRIEVE_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getManPowerById',
    controller: 'manPower',
    failureMessage: MANPOWER_MESSAGES.RETRIEVE_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateManPowerById = catchAsync(
  async (req, res) => {
    const updated = await manPowerService.updateManPowerById(req.params.id, req.body, req.query?.companyId);
    return successResponse(res, updated, MANPOWER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateManPowerById',
    controller: 'manPower',
    failureMessage: MANPOWER_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteManPowerById = catchAsync(
  async (req, res) => {
    await manPowerService.deleteManPowerById(req.params.id, req.query.companyId);
    return successResponse(res, null, MANPOWER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteManPowerById',
    controller: 'manPower',
    failureMessage: MANPOWER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getManPowerDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'departmentName']);
    const result = await manPowerService.getManPowerDropdown(filter);
    return successResponse(res, result, MANPOWER_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getManPowerDropdown',
    controller: 'manPower',
    failureMessage: MANPOWER_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createManPower,
  getAllManPower,
  getManPowerById,
  updateManPowerById,
  deleteManPowerById,
  getManPowerDropdown,
};
