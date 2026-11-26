const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const debitNoteService = require('./debitNote.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { DEBIT_NOTE_MESSAGES } = require('../../../utils/messages');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const debitNoteTransformers = require('./debitNote.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createDebitNote = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const debitNoteBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const debitNote = await debitNoteService.createDebitNote(
      { ...debitNoteBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );
    return successResponse(res, debitNote, DEBIT_NOTE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createDebitNote',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDebitNotes = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'debitNoteDate',
      'status',
      'branchId',
      'divisionId',
      'isSplit',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
      'startDate',
      'endDate',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await debitNoteService.queryDebitNotes(req.query, filter, options);
    const { results, ...otherFields } = result;
    const transformedDebitNote = debitNoteTransformers.queryDebitNotes(results, filter?.isSplit);
    return successResponse(res, transformedDebitNote, DEBIT_NOTE_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryDebitNotes',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDebitNotesExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'debitNoteDate',
      'status',
      'branchId',
      'divisionId',
      'isSplit',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
      'startDate',
      'endDate',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await debitNoteService.queryDebitNotesExports(req.query, filter, options);
    const { results, ...otherFields } = result;
    const transformedDebitNote = debitNoteTransformers.queryDebitNotes(results, filter?.isSplit);
    return successResponse(res, transformedDebitNote, DEBIT_NOTE_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryDebitNotesExports',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDebitNoteById = catchAsync(
  async (req, res) => {
    const debitNote = await debitNoteService.getDebitNoteById(req.params.id, req.query.companyId);
    return successResponse(res, debitNote, DEBIT_NOTE_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getDebitNoteById',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateDebitNote = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const debitNoteBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const updatedDebitNote = await debitNoteService.updateDebitNote(
      req.params.id,
      { ...debitNoteBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );
    return successResponse(res, updatedDebitNote, DEBIT_NOTE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateDebitNote',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteDebitNote = catchAsync(
  async (req, res) => {
    await debitNoteService.deleteDebitNote(req.params.id, req.query.companyId);
    return successResponse(res, {}, DEBIT_NOTE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteDebitNote',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const applyDebitNote = catchAsync(
  async (req, res) => {
    const { applications } = req.body;
    const debitNote = await debitNoteService.applyDebitNote(
      req.params.debitNoteId,
      req.query.companyId,
      applications,
      req.user._id,
    );
    return successResponse(res, debitNote, DEBIT_NOTE_MESSAGES.APPLY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'applyDebitNote',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.APPLY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteDebitNoteBill = catchAsync(
  async (req, res) => {
    await debitNoteService.deleteDebitNoteBill(req.params.debitNoteId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, {}, DEBIT_NOTE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteDebitNoteBill',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateDebitNoteNoteStatus = catchAsync(
  async (req, res) => {
    const updatedDebitNote = await debitNoteService.updateDebitNoteNoteStatus(
      req.params.debitNoteId,
      req.query.companyId,
      req.body.status,
      req.user._id,
    );
    return successResponse(res, updatedDebitNote, DEBIT_NOTE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateDebitNoteNoteStatus',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createDebitNoteRefund = catchAsync(
  async (req, res) => {
    const refundBody = getRequestBody(req);
    const debitNote = await debitNoteService.createDebitNoteRefund(
      req.params.debitNoteId,
      req.query.companyId,
      refundBody,
      req.user._id,
    );
    return successResponse(res, debitNote, DEBIT_NOTE_MESSAGES.REFUND_SUCCESS, httpStatus.OK);
  },
  {
    service: 'createDebitNoteRefund',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.REFUND_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteDebitNoteRefund = catchAsync(
  async (req, res) => {
    const refundBody = getRequestBody(req);
    const debitNote = await debitNoteService.deleteDebitNoteRefund(
      req.params.debitNoteId,
      req.query.companyId,
      refundBody,
      req.user._id,
    );
    return successResponse(res, debitNote, DEBIT_NOTE_MESSAGES.REFUND_DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteDebitNoteRefund',
    controller: 'debitNote',
    failureMessage: DEBIT_NOTE_MESSAGES.REFUND_DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.id,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.DEBIT_NOTE,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createDebitNote,
  getDebitNotes,
  getDebitNotesExports,
  getDebitNoteById,
  updateDebitNote,
  deleteDebitNote,
  applyDebitNote,
  deleteDebitNoteBill,
  updateDebitNoteNoteStatus,
  createDebitNoteRefund,
  deleteDebitNoteRefund,
};
