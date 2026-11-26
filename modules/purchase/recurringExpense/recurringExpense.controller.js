const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const recurringExpenseService = require('./recurringExpense.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { RECURRING_EXPENSE_MESSAGES } = require('../../../utils/messages');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createRecurringExpense = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const recurringExpenseBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const recurringExpense = await recurringExpenseService.createRecurringExpense(
      { ...recurringExpenseBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );
    return successResponse(res, recurringExpense, RECURRING_EXPENSE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createRecurringExpense',
    controller: 'recurringExpense',
    failureMessage: RECURRING_EXPENSE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecurringExpenses = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'startDate', 'endDate', 'recurringExpenseDate', 'status']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await recurringExpenseService.queryRecurringExpenses(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, RECURRING_EXPENSE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryRecurringExpenses',
    controller: 'recurringExpense',
    failureMessage: RECURRING_EXPENSE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecurringExpense = catchAsync(
  async (req, res) => {
    const recurringExpense = await recurringExpenseService.getRecurringExpenseById(
      req.params.recurringExpenseId,
      req.query.companyId,
    );
    return successResponse(res, recurringExpense, RECURRING_EXPENSE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRecurringExpenseById',
    controller: 'recurringExpense',
    failureMessage: RECURRING_EXPENSE_MESSAGES.FETCH_NOT_FOUND,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRecurringExpense = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const updateBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const updatedExpense = await recurringExpenseService.updateRecurringExpenseById(
      req.params.recurringExpenseId,
      { ...updateBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );
    return successResponse(res, updatedExpense, RECURRING_EXPENSE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRecurringExpenseById',
    controller: 'recurringExpense',
    failureMessage: RECURRING_EXPENSE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteRecurringExpense = catchAsync(
  async (req, res) => {
    const deleted = await recurringExpenseService.deleteRecurringExpenseById(req.params.recurringExpenseId, req.query.companyId);
    return successResponse(res, null, RECURRING_EXPENSE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteRecurringExpenseById',
    controller: 'recurringExpense',
    failureMessage: RECURRING_EXPENSE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createExpenseFromRecurringDoc = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const expense = await recurringExpenseService.createExpenseFromRecurringDoc(req.params.id, userId, req.query.companyId);
    return successResponse(res, expense, RECURRING_EXPENSE_MESSAGES.CREATE_EXPENSE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createExpenseFromRecurringDoc',
    controller: 'recurringExpense',
    failureMessage: RECURRING_EXPENSE_MESSAGES.CREATE_EXPENSE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRecurringExpenseStatus = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const expense = await recurringExpenseService.updateRecurringExpenseStatus(
      req.params.recurringExpenseId,
      req.body.status,
      userId,
      req.query?.companyId,
    );
    return successResponse(res, expense, RECURRING_EXPENSE_MESSAGES.STATUS_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRecurringExpenseStatus',
    controller: 'recurringExpense',
    failureMessage: RECURRING_EXPENSE_MESSAGES.STATUS_UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createRecurringExpense,
  getRecurringExpenses,
  getRecurringExpense,
  updateRecurringExpense,
  deleteRecurringExpense,
  createExpenseFromRecurringDoc,
  updateRecurringExpenseStatus,
};
