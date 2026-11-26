const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const accountService = require('./account.service');
const ledgerService = require('../ledger/ledger.service');
const { successResponse } = require('../../../services/response.service');
const { ACCOUNT_MESSAGES } = require('../../../utils/messages');

const getCategories = catchAsync(
  async (req, res) => {
    const categories = await accountService.getCategories(req.query.companyId);
    return successResponse(res, categories, ACCOUNT_MESSAGES.CATEGORIES_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCategories',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.CATEGORIES_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createAccount = catchAsync(
  async (req, res) => {
    const account = await accountService.createAccount({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, account, ACCOUNT_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createAccount',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const ACCOUNT_LIST_QUERY_FIELDS = [
  'companyId',
  'isSplit',
  'search',
  'isActive',
  'includeInactive',
  'category',
  'isSystemAccount',
  'startDate',
  'endDate',
];

const ACCOUNT_DROPDOWN_QUERY_FIELDS = [
  'companyId',
  'isActive',
  'includeInactive',
  'category',
  'isSystemAccount',
  'excludeAccountId',
];

const getAccounts = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ACCOUNT_LIST_QUERY_FIELDS);
    const accounts = await accountService.getAccounts(filter);
    return successResponse(res, accounts, ACCOUNT_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAccounts',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAccountsDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ACCOUNT_DROPDOWN_QUERY_FIELDS);
    const accounts = await accountService.getAccountsDropdown(filter);
    return successResponse(res, accounts, ACCOUNT_MESSAGES.DROPDOWN_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAccountsDropdown',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.DROPDOWN_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAccountsByCompany = catchAsync(
  async (req, res) => {
    const { companyId, ...filters } = req.query;
    const accounts = await accountService.getAccountsByCompany(companyId, filters);
    return successResponse(res, accounts, ACCOUNT_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAccountsByCompany',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAccountLedger = catchAsync(
  async (req, res) => {
    const ledger = await ledgerService.getAccountLedger({ ...req.query, accountId: req.params.accountId });
    return successResponse(res, ledger, ACCOUNT_MESSAGES.LEDGER_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAccountLedger',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.LEDGER_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateAccount = catchAsync(
  async (req, res) => {
    const account = await accountService.updateAccount(req.params.accountId, req.query.companyId, req.body, req.user._id);
    return successResponse(res, account, ACCOUNT_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateAccount',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteAccount = catchAsync(
  async (req, res) => {
    const account = await accountService.deleteAccount(req.params.accountId, req.query.companyId, req.user._id);
    return successResponse(res, account, ACCOUNT_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteAccount',
    controller: 'account',
    failureMessage: ACCOUNT_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getCategories,
  createAccount,
  getAccounts,
  getAccountsDropdown,
  getAccountsByCompany,
  getAccountLedger,
  updateAccount,
  deleteAccount,
};
