const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const machineService = require('./machine.service');
const pick = require('../../../utils/pick');
const { MACHINE_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');

const createMachine = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    await machineService.createMachine({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, null, MACHINE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createMachine',
    controller: 'machine',
    failureMessage: MACHINE_MESSAGES.FAILED_TO_CREATE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllMachines = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isActive']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await machineService.getAllMachines(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, MACHINE_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllMachines',
    controller: 'machine',
    failureMessage: MACHINE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMachineById = catchAsync(
  async (req, res) => {
    const machine = await machineService.getMachineById(req.params.id, req.query.companyId);
    return successResponse(res, machine, MACHINE_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getMachineById',
    controller: 'machine',
    failureMessage: MACHINE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateMachineById = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    await machineService.updateMachineById(req.params.id, req.body, req.query?.companyId, userId);
    return successResponse(res, null, MACHINE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateMachineById',
    controller: 'machine',
    failureMessage: MACHINE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateActiveStatus = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const { isActive, companyId } = req.query;
    await machineService.updateActiveStatus(req.params.id, isActive, companyId, userId);
    return successResponse(res, null, MACHINE_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateActiveStatus',
    controller: 'machine',
    failureMessage: MACHINE_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteMachineById = catchAsync(
  async (req, res) => {
    await machineService.deleteMachineById(req.params.id, req.query.companyId);
    return successResponse(res, null, MACHINE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteMachineById',
    controller: 'machine',
    failureMessage: MACHINE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMachineDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'location', 'process', 'criticality']);
    const result = await machineService.getMachineDropdown(filter);
    return successResponse(res, result, MACHINE_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getMachineDropdown',
    controller: 'machine',
    failureMessage: MACHINE_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createMachine,
  getAllMachines,
  getMachineById,
  updateMachineById,
  updateActiveStatus,
  deleteMachineById,
  getMachineDropdown,
};
