const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const expenseService = require('./expense.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { EXPENSE_MESSAGES } = require('../../../utils/messages');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

/**
 * Create an expense
 */
const createExpense = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const expenseBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const expense = await expenseService.createExpense({ ...expenseBody, companyId: req.query.companyId }, userId, uploadedFiles);
    return successResponse(res, expense, EXPENSE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createExpense',
    controller: 'expense',
    failureMessage: EXPENSE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllExpenses = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'date', 'branchId', 'divisionId', 'addedBy']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { results, ...otherFields } = await expenseService.getAllExpenses(req.query, filter, options);

    return successResponse(res, results, EXPENSE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllExpenses',
    controller: 'expense',
    failureMessage: EXPENSE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getExpensesExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'date', 'branchId', 'divisionId', 'addedBy']);
    const options = pick(req.query, ['sortBy']);
    const { results, ...otherFields } = await expenseService.getExpensesExports(req.query, filter, options);
    return successResponse(res, results, EXPENSE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getExpensesExports',
    controller: 'expense',
    failureMessage: EXPENSE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getExpenseById = catchAsync(
  async (req, res) => {
    const expense = await expenseService.getExpenseById(req.params.id, req.query.companyId);

    return successResponse(res, expense, EXPENSE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getExpenseById',
    controller: 'expense',
    failureMessage: EXPENSE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateExpense = catchAsync(
  async (req, res) => {
    const expenseId = req.params.id;
    const userId = req.user._id;
    const expenseBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const updatedExpense = await expenseService.updateExpense(
      expenseId,
      { ...expenseBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
    );

    return successResponse(res, updatedExpense, EXPENSE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateExpense',
    controller: 'expense',
    failureMessage: EXPENSE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteExpense = catchAsync(
  async (req, res) => {
    const expenseId = req.params.id;
    const deletedExpense = await expenseService.deleteExpense(expenseId, req.query.companyId);

    return successResponse(res, deletedExpense, EXPENSE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteExpense',
    controller: 'expense',
    failureMessage: EXPENSE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createExpense,
  getAllExpenses,
  getExpensesExports,
  updateExpense,
  deleteExpense,
  getExpenseById,
};
