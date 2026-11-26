const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const ledgerService = require('./accountLedger.service');
const { successResponse } = require('../../../services/response.service');
const { LEDGER_MESSAGES } = require('../../../utils/messages');
const accountLedgerTransformers = require('./accountLedger.transformer');

const createLedger = catchAsync(
  async (req, res) => {
    const ledger = await ledgerService.createLedger({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, ledger, LEDGER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createLedger',
    controller: 'businessAccountLedgerMaster',
    failureMessage: LEDGER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateLedger = catchAsync(
  async (req, res) => {
    const ledger = await ledgerService.updateLedger(
      req.params.ledgerId,
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, ledger, LEDGER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateLedger',
    controller: 'businessAccountLedgerMaster',
    failureMessage: LEDGER_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteLedger = catchAsync(
  async (req, res) => {
    await ledgerService.deleteLedger(req.params.ledgerId, req.query.companyId);
    return successResponse(res, {}, LEDGER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteLedger',
    controller: 'businessAccountLedgerMaster',
    failureMessage: LEDGER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getLedgerById = catchAsync(
  async (req, res) => {
    const invoice = await ledgerService.getLedgerById(req.params.ledgerId, req.query.companyId);
    return successResponse(res, invoice, LEDGER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getLedgerById',
    controller: 'businessAccountLedgerMaster',
    failureMessage: LEDGER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getLedgers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await ledgerService.getLedgers(filter, options);
    const { results, ...otherFields } = result;

    const transformedLedgers = accountLedgerTransformers.getLedgers(results);

    return successResponse(res, transformedLedgers, LEDGER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getLedgers',
    controller: 'businessAccountLedgerMaster',
    failureMessage: LEDGER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getLedgersDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await ledgerService.getLedgersDropdown(filter, options);
    const transformedLedgers = accountLedgerTransformers.getLedgers(result);

    return successResponse(res, transformedLedgers, LEDGER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getLedgersDropdown',
    controller: 'businessAccountLedgerMaster',
    failureMessage: LEDGER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createLedger,
  updateLedger,
  deleteLedger,
  getLedgers,
  getLedgerById,
  getLedgersDropdown,
};
