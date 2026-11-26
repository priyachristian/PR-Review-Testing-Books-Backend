const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const manualJournalService = require('./manualJournal.service');
const { successResponse } = require('../../../services/response.service');
const { MANUAL_JOURNAL_MESSAGES } = require('../../../utils/messages');
const manualJournalTransformers = require('./manualJournal.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createManualJournal = catchAsync(
  async (req, res) => {
    const journalBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const manualJournal = await manualJournalService.createManualJournal(
      { ...journalBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, manualJournal, MANUAL_JOURNAL_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createManualJournal',
    controller: 'manualJournal',
    failureMessage: MANUAL_JOURNAL_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getManualJournals = catchAsync(
  async (req, res) => {
    const { results, ...extra } = await manualJournalService.getManualJournals(req.query);
    const transformedManualJournals = manualJournalTransformers.queryManualJournals(results);
    return successResponse(res, transformedManualJournals, MANUAL_JOURNAL_MESSAGES.GET_SUCCESS, httpStatus.OK, extra);
  },
  {
    service: 'getManualJournals',
    controller: 'manualJournal',
    failureMessage: MANUAL_JOURNAL_MESSAGES.GET_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getManualJournal = catchAsync(
  async (req, res) => {
    const manualJournal = await manualJournalService.getManualJournal(req.params.manualJournalId, req.query);
    const transformedManualJournal = manualJournalTransformers.queryManualJournal(manualJournal);
    return successResponse(res, transformedManualJournal, MANUAL_JOURNAL_MESSAGES.GET_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getManualJournal',
    controller: 'manualJournal',
    failureMessage: MANUAL_JOURNAL_MESSAGES.GET_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateManualJournal = catchAsync(
  async (req, res) => {
    const journalBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const manualJournal = await manualJournalService.updateManualJournal(
      req.params.manualJournalId,
      { ...journalBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, manualJournal, MANUAL_JOURNAL_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateManualJournal',
    controller: 'manualJournal',
    failureMessage: MANUAL_JOURNAL_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteManualJournal = catchAsync(
  async (req, res) => {
    await manualJournalService.deleteManualJournal(req.params.manualJournalId, req.query.companyId);
    return successResponse(res, null, MANUAL_JOURNAL_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteManualJournal',
    controller: 'manualJournal',
    failureMessage: MANUAL_JOURNAL_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getContactDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'branchId']);
    const contactDropdown = await manualJournalService.getContactDropdown(filter);
    return successResponse(res, contactDropdown, MANUAL_JOURNAL_MESSAGES.GET_CONTACT_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getContactDropdown',
    controller: 'manualJournal',
    failureMessage: MANUAL_JOURNAL_MESSAGES.GET_CONTACT_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createManualJournal,
  getManualJournals,
  getManualJournal,
  updateManualJournal,
  deleteManualJournal,
  getContactDropdown,
};
