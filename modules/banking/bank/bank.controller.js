const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const bankService = require('./bank.service');
const { successResponse } = require('../../../services/response.service');
const { BANK_MESSAGES } = require('../../../utils/messages');
const pick = require('../../../utils/pick');

const createBank = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const bank = await bankService.createNewBank({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { bank }, BANK_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createNewBank',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBanksByCompanyId = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isPrimary', 'accountType', 'isSplit']);
    const options = pick(req.query, ['limit', 'page', 'pagination']);
    const banks = await bankService.getBanksByCompanyId(req.query, filter, options);
    const { results, ...otherFields } = banks;
    return successResponse(res, results, BANK_MESSAGES.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getBanksByCompanyId',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateBank = catchAsync(
  async (req, res) => {
    const { bankId } = req.params;
    const userId = req.user._id;
    const bank = await bankService.updateBankById(bankId, { ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { bank }, BANK_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateBankById',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteBank = catchAsync(
  async (req, res) => {
    const { bankId } = req.params;
    const bank = await bankService.deleteBankById(bankId, req.query.companyId);
    return successResponse(res, { bank }, BANK_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteBankById',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const transferAmount = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    await bankService.transferAmount(req.body, userId, req.query?.companyId);
    return successResponse(res, {}, BANK_MESSAGES.TRANSFER_AMOUNT, httpStatus.OK);
  },
  {
    service: 'transferAmount',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.TRANSFER_AMOUNT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const bankDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'accountType', 'isSplit', 'isPrimary']);
    const bank = await bankService.bankDropdown(filter);
    return successResponse(res, bank, BANK_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'bankDropdown',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBankById = catchAsync(
  async (req, res) => {
    const bank = await bankService.getBankById(req.params.bankId, req.query.companyId);

    return successResponse(res, bank, BANK_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBankById',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const transaction = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    await bankService.withdrawOrDeposit(req.body, userId, req.query?.companyId);
    return successResponse(res, {}, BANK_MESSAGES.TRANSACTION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'withdrawOrDeposit',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.TRANSACTION_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTransactions = catchAsync(
  async (req, res) => {
    const transactions = await bankService.getTransactions(req.query);
    return successResponse(res, transactions, BANK_MESSAGES.FETCH_TRANSACTIONS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTransactions',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.FETCH_TRANSACTIONS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTransactionById = catchAsync(
  async (req, res) => {
    const transaction = await bankService.getTransactionById(req.params.transactionId, req.query.companyId);
    return successResponse(res, transaction, BANK_MESSAGES.FETCH_TRANSACTIONS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTransactionById',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.FETCH_TRANSACTIONS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const approveTransaction = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const response = await bankService.approveTransaction(req.body, userId, req.query?.companyId);
    return successResponse(res, response, BANK_MESSAGES.APPROVE_TRANSACTION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'approveTransaction',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.APPROVE_TRANSACTION_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const rejectTransaction = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const response = await bankService.rejectTransaction(req.body, userId, req.query?.companyId);
    return successResponse(res, response, BANK_MESSAGES.REJECT_TRANSACTION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'rejectTransaction',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.REJECT_TRANSACTION_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const cancelTransaction = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const response = await bankService.cancelTransaction(req.body, userId, req.query?.companyId);
    return successResponse(res, response, BANK_MESSAGES.CANCEL_TRANSACTION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'cancelTransaction',
    controller: 'bank',
    failureMessage: BANK_MESSAGES.CANCEL_TRANSACTION_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createBank,
  getBanksByCompanyId,
  updateBank,
  deleteBank,
  transferAmount,
  bankDropdown,
  getBankById,
  transaction,
  getTransactions,
  getTransactionById,
  approveTransaction,
  rejectTransaction,
  cancelTransaction,
};
