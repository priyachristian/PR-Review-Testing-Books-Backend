const httpStatus = require('http-status');
const catchAsync = require('../../utils/catchAsync');
const pick = require('../../utils/pick');
const { successResponse } = require('../../services/response.service');
const { COMPLAINT_MESSAGES } = require('../../utils/messages');
const { getUploadedFiles } = require('../../utils/fileUploadHelper');
const complaintService = require('./complaint.service');

const createComplaint = catchAsync(
  async (req, res) => {
    const attachments = getUploadedFiles(req, 'attachment');
    const photos = getUploadedFiles(req, 'photo');
    const complaint = await complaintService.createComplaint(
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
      attachments,
      photos,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createComplaint',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getComplaints = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'problemType', 'status', 'assignedTo', 'customerId', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await complaintService.queryComplaints(filter, options, req.complaintVisibility);
    const { results, ...meta } = result;
    return successResponse(res, results, COMPLAINT_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, meta);
  },
  {
    service: 'queryComplaints',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getComplaintsDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'customerId', 'excludeComplaintId', 'problemType']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await complaintService.getComplaintsDropdown(filter, options, req.complaintVisibility);
    const { results, ...meta } = result;
    return successResponse(res, results, COMPLAINT_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK, meta);
  },
  {
    service: 'getComplaintsDropdown',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getComplaint = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.getComplaintById(req.params.complaintId, req.query.companyId);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getComplaintById',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateComplaint = catchAsync(
  async (req, res) => {
    const attachments = getUploadedFiles(req, 'attachment');
    const photos = getUploadedFiles(req, 'photo');
    const complaint = await complaintService.updateComplaintById(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
      attachments,
      photos,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateComplaintById',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteComplaint = catchAsync(
  async (req, res) => {
    await complaintService.deleteComplaintById(req.params.complaintId, req.query.companyId);
    return successResponse(res, {}, COMPLAINT_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteComplaintById',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const assignStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.assignComplaint(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_ASSIGN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'assignComplaint',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const replyStep = catchAsync(
  async (req, res) => {
    const proofFiles = getUploadedFiles(req, 'attachment');
    const complaint = await complaintService.replyToCustomer(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
      proofFiles,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_REPLY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'replyToCustomer',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const startProgressStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.startProgress(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_START_PROGRESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'startProgress',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const warrantyStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.saveWarranty(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_WARRANTY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'saveWarranty',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const rootCauseStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.saveRootCause(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_ROOT_CAUSE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'saveRootCause',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const stopGapStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.saveStopGap(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_STOP_GAP_SUCCESS, httpStatus.OK);
  },
  {
    service: 'saveStopGap',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const recordProgressStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.recordProgress(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_RECORD_PROGRESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'recordProgress',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const settlementStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.saveSettlement(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_SETTLEMENT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'saveSettlement',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const completeActionStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.completeActionTaken(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_COMPLETE_ACTION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'completeActionTaken',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const verifyStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.verifyFix(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_VERIFY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'verifyFix',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const closeStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.closeComplaint(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_CLOSE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'closeComplaint',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const skipStep = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.skipCurrentStep(
      req.params.complaintId,
      req.query.companyId,
      req.body || {},
      req.user._id,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.STEP_SKIP_SUCCESS, httpStatus.OK);
  },
  {
    service: 'skipCurrentStep',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const addTeamNote = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.addTeamNote(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.TEAM_NOTE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'addTeamNote',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const addTeamTask = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.addTeamTask(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.TEAM_TASK_SUCCESS, httpStatus.OK);
  },
  {
    service: 'addTeamTask',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateTeamTask = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.updateTeamTask(
      req.params.complaintId,
      req.query.companyId,
      req.params.taskId,
      req.body,
      req.user._id,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.TEAM_TASK_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateTeamTask',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const handToSomeoneElse = catchAsync(
  async (req, res) => {
    const attachments = getUploadedFiles(req, 'attachment');
    const photos = getUploadedFiles(req, 'photo');
    const complaint = await complaintService.handToSomeoneElse(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
      attachments,
      photos,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.ACTION_HAND_OVER_SUCCESS, httpStatus.OK);
  },
  {
    service: 'handToSomeoneElse',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const markWaiting = catchAsync(
  async (req, res) => {
    const attachments = getUploadedFiles(req, 'attachment');
    const photos = getUploadedFiles(req, 'photo');
    const complaint = await complaintService.markWaiting(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
      attachments,
      photos,
    );
    const message = complaint.isWaiting
      ? COMPLAINT_MESSAGES.ACTION_WAITING_SUCCESS
      : COMPLAINT_MESSAGES.ACTION_WAITING_CLEARED_SUCCESS;
    return successResponse(res, complaint, message, httpStatus.OK);
  },
  {
    service: 'markWaiting',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const escalateComplaint = catchAsync(
  async (req, res) => {
    const attachments = getUploadedFiles(req, 'attachment');
    const photos = getUploadedFiles(req, 'photo');
    const complaint = await complaintService.escalateComplaint(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
      attachments,
      photos,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.ACTION_ESCALATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'escalateComplaint',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const linkComplaint = catchAsync(
  async (req, res) => {
    const attachments = getUploadedFiles(req, 'attachment');
    const photos = getUploadedFiles(req, 'photo');
    const complaint = await complaintService.linkComplaint(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
      attachments,
      photos,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.ACTION_LINK_SUCCESS, httpStatus.OK);
  },
  {
    service: 'linkComplaint',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const markNotReal = catchAsync(
  async (req, res) => {
    const attachments = getUploadedFiles(req, 'attachment');
    const photos = getUploadedFiles(req, 'photo');
    const complaint = await complaintService.markNotReal(
      req.params.complaintId,
      req.query.companyId,
      req.body,
      req.user._id,
      attachments,
      photos,
    );
    return successResponse(res, complaint, COMPLAINT_MESSAGES.ACTION_NOT_REAL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'markNotReal',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const reopenComplaint = catchAsync(
  async (req, res) => {
    const complaint = await complaintService.reopenComplaint(req.params.complaintId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, complaint, COMPLAINT_MESSAGES.ACTION_REOPEN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'reopenComplaint',
    controller: 'complaint',
    failureMessage: COMPLAINT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createComplaint,
  getComplaints,
  getComplaintsDropdown,
  getComplaint,
  updateComplaint,
  deleteComplaint,
  assignStep,
  replyStep,
  startProgressStep,
  warrantyStep,
  rootCauseStep,
  stopGapStep,
  recordProgressStep,
  settlementStep,
  completeActionStep,
  verifyStep,
  closeStep,
  skipStep,
  addTeamNote,
  addTeamTask,
  updateTeamTask,
  handToSomeoneElse,
  markWaiting,
  escalateComplaint,
  linkComplaint,
  markNotReal,
  reopenComplaint,
};
