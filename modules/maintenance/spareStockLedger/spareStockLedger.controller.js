const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const spareStockLedgerService = require('./spareStockLedger.service');
const pick = require('../../../utils/pick');
const { SPARE_STOCK_LEDGER_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');

const createAdjustment = catchAsync(
  async (req, res) => {
    await spareStockLedgerService.createAdjustment({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, null, SPARE_STOCK_LEDGER_MESSAGES.ADJUSTMENT_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createAdjustment',
    controller: 'spareStockLedger',
    failureMessage: SPARE_STOCK_LEDGER_MESSAGES.ADJUSTMENT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllSpareStockLedgers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await spareStockLedgerService.getAllSpareStockLedgers(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, SPARE_STOCK_LEDGER_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllSpareStockLedgers',
    controller: 'spareStockLedger',
    failureMessage: SPARE_STOCK_LEDGER_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getAllSpareStockLedgers,
  createAdjustment,
};
