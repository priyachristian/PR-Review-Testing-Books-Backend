const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const creditNoteService = require('./creditNote.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { CREDIT_NOTE_MESSAGES } = require('../../../utils/messages');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const creditNoteTransformers = require('./creditNote.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createCreditNote = catchAsync(
  async (req, res) => {
    const creditNoteBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const creditNote = await creditNoteService.createCreditNote(
      { ...creditNoteBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, creditNote, CREDIT_NOTE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createCreditNote',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCreditNotes = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'creditNoteId',
      'companyId',
      'customerId',
      'creditNoteDate',
      'status',
      'branchId',
      'divisionId',
      'startDate',
      'endDate',
      'isSplit',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await creditNoteService.queryCreditNotes(req.query, filter, options);
    const { results, ...otherFields } = result;
    const transformedCreditNotes = creditNoteTransformers.queryCreditNotes(results, filter?.isSplit);
    return successResponse(res, transformedCreditNotes, CREDIT_NOTE_MESSAGES.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryCreditNotes',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCreditNotesExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'creditNoteId',
      'companyId',
      'customerId',
      'creditNoteDate',
      'status',
      'branchId',
      'divisionId',
      'startDate',
      'endDate',
      'isSplit',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await creditNoteService.queryCreditNotesExports(req.query, filter, options);
    const { results, ...otherFields } = result;
    const transformedCreditNotes = creditNoteTransformers.queryCreditNotes(results, filter?.isSplit);
    return successResponse(res, transformedCreditNotes, CREDIT_NOTE_MESSAGES.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryCreditNotesExports',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCreditNote = catchAsync(
  async (req, res) => {
    const creditNote = await creditNoteService.getCreditNoteById(req.params.creditNoteId, req.query.companyId);

    return successResponse(res, creditNote, CREDIT_NOTE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCreditNoteById',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateCreditNote = catchAsync(
  async (req, res) => {
    const creditNoteBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const creditNote = await creditNoteService.updateCreditNoteById(
      req.params.creditNoteId,
      { ...creditNoteBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, creditNote, CREDIT_NOTE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCreditNoteById',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteCreditNote = catchAsync(
  async (req, res) => {
    await creditNoteService.deleteCreditNoteById(req.params.creditNoteId, req.query.companyId, req.user._id);
    return successResponse(res, {}, CREDIT_NOTE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteCreditNoteById',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const applyCreditNote = catchAsync(
  async (req, res) => {
    const { applications } = req.body;
    const creditNote = await creditNoteService.applyCreditNote(
      req.params.creditNoteId,
      req.query.companyId,
      applications,
      req.user._id,
    );
    return successResponse(res, creditNote, CREDIT_NOTE_MESSAGES.APPLY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'applyCreditNote',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.APPLY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteCreditNoteInvoice = catchAsync(
  async (req, res) => {
    await creditNoteService.deleteCreditNoteInvoice(req.params.creditNoteId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, {}, CREDIT_NOTE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteCreditNoteInvoice',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateCreditNoteStatus = catchAsync(
  async (req, res) => {
    const creditNote = await creditNoteService.updateCreditNoteStatus(
      req.params.creditNoteId,
      req.query.companyId,
      req.body.status,
      req.user._id,
    );
    return successResponse(res, creditNote, CREDIT_NOTE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCreditNoteStatus',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const createCreditNoteRefund = catchAsync(
  async (req, res) => {
    const refundBody = getRequestBody(req);
    const creditNote = await creditNoteService.createCreditNoteRefund(
      req.params.creditNoteId,
      req.query.companyId,
      refundBody,
      req.user._id,
    );
    return successResponse(res, creditNote, CREDIT_NOTE_MESSAGES.REFUND_SUCCESS, httpStatus.OK);
  },
  {
    service: 'createCreditNoteRefund',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.REFUND_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteCreditNoteRefund = catchAsync(
  async (req, res) => {
    const refundBody = getRequestBody(req);
    const creditNote = await creditNoteService.deleteCreditNoteRefund(
      req.params.creditNoteId,
      req.query.companyId,
      refundBody,
      req.user._id,
    );
    return successResponse(res, creditNote, CREDIT_NOTE_MESSAGES.REFUND_DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteCreditNoteRefund',
    controller: 'creditNote',
    failureMessage: CREDIT_NOTE_MESSAGES.REFUND_DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.creditNoteId,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.CREDIT_NOTE,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createCreditNote,
  getCreditNotes,
  getCreditNotesExports,
  getCreditNote,
  updateCreditNote,
  deleteCreditNote,
  applyCreditNote,
  deleteCreditNoteInvoice,
  updateCreditNoteStatus,
  createCreditNoteRefund,
  deleteCreditNoteRefund,
};
