const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const processService = require('./process.service');
const { successResponse } = require('../../../services/response.service');
const { PROCESS_MESSAGES } = require('../../../utils/messages');

const createProcess = catchAsync(
  async (req, res) => {
    const process = await processService.createProcess({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, process, PROCESS_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createProcess',
    controller: 'process',
    failureMessage: PROCESS_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getProcesses = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['name', 'companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await processService.queryProcesses(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, PROCESS_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryProcesses',
    controller: 'process',
    failureMessage: PROCESS_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProcess = catchAsync(
  async (req, res) => {
    const process = await processService.getProcessById(req.params.processId, req.query.companyId);
    return successResponse(res, process, PROCESS_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProcessById',
    controller: 'process',
    failureMessage: PROCESS_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateProcess = catchAsync(
  async (req, res) => {
    const process = await processService.updateProcessById(req.params.processId, req.body, req.user._id);
    return successResponse(res, process, PROCESS_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateProcessById',
    controller: 'process',
    failureMessage: PROCESS_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteProcess = catchAsync(
  async (req, res) => {
    await processService.deleteProcessById(req.params.processId, req.query.companyId);
    return successResponse(res, {}, PROCESS_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteProcessById',
    controller: 'process',
    failureMessage: PROCESS_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const processDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await processService.processDropdown(filter);
    return successResponse(res, result, PROCESS_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'processDropdown',
    controller: 'process',
    failureMessage: PROCESS_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createProcess,
  getProcesses,
  getProcess,
  updateProcess,
  deleteProcess,
  processDropdown,
};
