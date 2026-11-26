const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const quoteService = require('./quote.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { QUOTE_MESSAGES } = require('../../../utils/messages');
const quoteTransformers = require('./quote.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createQuote = catchAsync(async (req, res) => {
  try {
    const quoteBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const quote = await quoteService.createQuote({ ...quoteBody, companyId: req.query.companyId }, req.user._id, uploadedFiles);
    return successResponse(res, quote, QUOTE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createQuote', controller: 'quote' },
      res,
      error?.message || QUOTE_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getQuotes = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'quoteId',
      'companyId',
      'customerId',
      'search',
      'quoteDate',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'appName',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await quoteService.queryQuotes(filter, options);
    const { results, ...otherFields } = result;
    const transformedQuotes = quoteTransformers.queryQuotes(results);
    return successResponse(res, transformedQuotes, QUOTE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryQuotes',
    controller: 'quote',
    failureMessage: QUOTE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getQuotesExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'quoteId',
      'companyId',
      'customerId',
      'search',
      'quoteDate',
      'status',
      'startDate',
      'endDate',
      'branchId',
      'divisionId',
      'appName',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await quoteService.queryQuotesExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedQuotes = quoteTransformers.queryQuotes(results);
    return successResponse(res, transformedQuotes, QUOTE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryQuotesExports',
    controller: 'quote',
    failureMessage: QUOTE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getQuote = catchAsync(
  async (req, res) => {
    const quote = await quoteService.getQuoteById(req.params.quoteId, req.query.companyId);
    return successResponse(res, quote, QUOTE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getQuoteById',
    controller: 'quote',
    failureMessage: QUOTE_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateQuote = catchAsync(async (req, res) => {
  try {
    const quoteBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const quote = await quoteService.updateQuoteById(
      req.params.quoteId,
      { ...quoteBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, quote, QUOTE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updateQuoteById', controller: 'quote' },
      res,
      error?.message || QUOTE_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const deleteQuote = catchAsync(
  async (req, res) => {
    await quoteService.deleteQuoteById(req.params.quoteId, req.query.companyId);
    return successResponse(res, {}, QUOTE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteQuoteById',
    controller: 'quote',
    failureMessage: QUOTE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const sendQuote = catchAsync(
  async (req, res) => {
    const quote = await quoteService.sendQuote(req.params.quoteId, req.query.companyId, req.user._id);
    return successResponse(res, quote, QUOTE_MESSAGES.SEND_SUCCESS, httpStatus.OK);
  },
  {
    service: 'sendQuote',
    controller: 'quote',
    failureMessage: QUOTE_MESSAGES.SEND_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateQuoteStatus = catchAsync(
  async (req, res) => {
    const { status, rejectionReason } = req.body;
    const quote = await quoteService.updateQuoteStatus(
      req.params.quoteId,
      req.query.companyId,
      status,
      req.user._id,
      rejectionReason,
    );
    return successResponse(res, quote, QUOTE_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateQuoteStatus',
    controller: 'quote',
    failureMessage: QUOTE_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createQuote,
  getQuotes,
  getQuotesExports,
  getQuote,
  updateQuote,
  deleteQuote,
  sendQuote,
  updateQuoteStatus,
};
