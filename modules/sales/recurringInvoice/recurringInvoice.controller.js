const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const recurringInvoiceService = require('./recurringInvoice.service');
const { successResponse } = require('../../../services/response.service');
const { RECURRING_INVOICE_MESSAGES } = require('../../../utils/messages');

const createRecurringInvoice = catchAsync(
  async (req, res) => {
    const recurringInvoice = await recurringInvoiceService.createRecurringInvoice(
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, recurringInvoice, RECURRING_INVOICE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createRecurringInvoice',
    controller: 'recurringInvoice',
    failureMessage: RECURRING_INVOICE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecurringInvoices = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'recurringInvoiceId',
      'companyId',
      'customerId',
      'search',
      'status',
      'recurringInvoiceDate',
      'startDate',
      'endDate',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await recurringInvoiceService.queryRecurringInvoices(filter, options);
    const { results, nextRecNo, ...otherFields } = result;
    otherFields.nextRecNo = nextRecNo;
    return successResponse(res, results, RECURRING_INVOICE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryRecurringInvoices',
    controller: 'recurringInvoice',
    failureMessage: RECURRING_INVOICE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecurringInvoice = catchAsync(
  async (req, res) => {
    const recurringInvoice = await recurringInvoiceService.getRecurringInvoiceById(
      req.params.recurringInvoiceId,
      req.query.companyId,
    );
    return successResponse(res, recurringInvoice, RECURRING_INVOICE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRecurringInvoiceById',
    controller: 'recurringInvoice',
    failureMessage: RECURRING_INVOICE_MESSAGES.FETCH_NOT_FOUND,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRecurringInvoice = catchAsync(
  async (req, res) => {
    const recurringInvoice = await recurringInvoiceService.updateRecurringInvoiceById(
      req.params.recurringInvoiceId,
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, recurringInvoice, RECURRING_INVOICE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRecurringInvoiceById',
    controller: 'recurringInvoice',
    failureMessage: RECURRING_INVOICE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteRecurringInvoice = catchAsync(
  async (req, res) => {
    await recurringInvoiceService.deleteRecurringInvoiceById(req.params.recurringInvoiceId, req.query.companyId);
    return successResponse(res, {}, RECURRING_INVOICE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteRecurringInvoiceById',
    controller: 'recurringInvoice',
    failureMessage: RECURRING_INVOICE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createInvoiceFromRecurringDoc = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const invoice = await recurringInvoiceService.createInvoiceFromRecurringDoc(req.params.id, userId, req.query.companyId);
    return successResponse(res, invoice, RECURRING_INVOICE_MESSAGES.CREATE_INVOICE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createInvoiceFromRecurringDoc',
    controller: 'recurringInvoice',
    failureMessage: RECURRING_INVOICE_MESSAGES.CREATE_INVOICE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRecurringInvoiceStatus = catchAsync(
  async (req, res) => {
    const recurringInvoice = await recurringInvoiceService.updateRecurringInvoiceStatus(
      req.params.recurringInvoiceId,
      req.body.status,
      req.user._id,
      req.query?.companyId,
    );
    return successResponse(res, recurringInvoice, RECURRING_INVOICE_MESSAGES.STATUS_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRecurringInvoiceStatus',
    controller: 'recurringInvoice',
    failureMessage: RECURRING_INVOICE_MESSAGES.STATUS_UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createRecurringInvoice,
  getRecurringInvoices,
  getRecurringInvoice,
  updateRecurringInvoice,
  deleteRecurringInvoice,
  createInvoiceFromRecurringDoc,
  updateRecurringInvoiceStatus,
};
