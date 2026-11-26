const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const maintenanceRequestService = require('./maintenanceRequest.service');
const partRequestService = require('../partRequest/partRequest.service');
const pick = require('../../../utils/pick');
const { MAINTENANCE_REQUEST_MESSAGES, PART_REQUEST_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');

const viewResult = (id, companyId) => maintenanceRequestService.getMaintenanceRequestById(id, companyId);

const createMaintenanceRequest = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const { companyId } = req.query;
    const id = await maintenanceRequestService.createMaintenanceRequest({ ...req.body, companyId }, userId);
    return successResponse(res, await viewResult(id, companyId), MAINTENANCE_REQUEST_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createMaintenanceRequest',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllMaintenanceRequests = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await maintenanceRequestService.getAllMaintenanceRequests(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, MAINTENANCE_REQUEST_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllMaintenanceRequests',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMaintenanceRequestById = catchAsync(
  async (req, res) => {
    const result = await viewResult(req.params.id, req.query.companyId);
    return successResponse(res, result, MAINTENANCE_REQUEST_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getMaintenanceRequestById',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const approveMaintenanceRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenanceRequestService.approveMaintenanceRequest(req.params.id, companyId, req.body.remark, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_REQUEST_MESSAGES.APPROVE_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'approveMaintenanceRequest',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.APPROVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const rejectMaintenanceRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenanceRequestService.rejectMaintenanceRequest(req.params.id, companyId, req.body.rejectReason, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_REQUEST_MESSAGES.REJECT_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'rejectMaintenanceRequest',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.REJECT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const assignMaintenanceRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const { assigneeId, mode, targetAt, estimatedHours } = req.body;
    await maintenanceRequestService.assignMaintenanceRequest(
      req.params.id,
      companyId,
      { assigneeId, mode, targetAt, estimatedHours },
      req.user._id,
    );
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_REQUEST_MESSAGES.ASSIGN_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'assignMaintenanceRequest',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.ASSIGN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const startWorkMaintenanceRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenanceRequestService.startWorkMaintenanceRequest(req.params.id, companyId, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_REQUEST_MESSAGES.START_WORK_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'startWorkMaintenanceRequest',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.START_WORK_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const completeMaintenanceRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenanceRequestService.completeMaintenanceRequest(req.params.id, companyId, req.body, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_REQUEST_MESSAGES.COMPLETE_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'completeMaintenanceRequest',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.COMPLETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const closeMaintenanceRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenanceRequestService.closeMaintenanceRequest(req.params.id, companyId, req.body, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_REQUEST_MESSAGES.CLOSE_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'closeMaintenanceRequest',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.CLOSE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const requestPartMaintenanceRequest = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await partRequestService.createPartRequest({ ...req.body, companyId, mrId: req.params.id }, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      PART_REQUEST_MESSAGES.CREATE_SUCCESS,
      httpStatus.CREATED,
    );
  },
  {
    service: 'createPartRequest',
    controller: 'maintenanceRequest',
    failureMessage: PART_REQUEST_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMaintenanceRequestDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'status', 'type', 'priority', 'machineId']);
    const result = await maintenanceRequestService.getMaintenanceRequestDropdown(filter);
    return successResponse(res, result, MAINTENANCE_REQUEST_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getMaintenanceRequestDropdown',
    controller: 'maintenanceRequest',
    failureMessage: MAINTENANCE_REQUEST_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getMaintenanceRequestDropdown,
  createMaintenanceRequest,
  getAllMaintenanceRequests,
  getMaintenanceRequestById,
  approveMaintenanceRequest,
  rejectMaintenanceRequest,
  assignMaintenanceRequest,
  startWorkMaintenanceRequest,
  completeMaintenanceRequest,
  closeMaintenanceRequest,
  requestPartMaintenanceRequest,
};
