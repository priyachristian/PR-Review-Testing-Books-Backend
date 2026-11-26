const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const openingBalanceTransactionService = require('./openingBalanceTransaction.service');
const { successResponse } = require('../../../services/response.service');
const { OPENING_BALANCE_TRANSACTION_MESSAGES } = require('../../../utils/messages');

const getOpeningBalanceTransactionHistory = catchAsync(
  async (req, res) => {
    const data = await openingBalanceTransactionService.getOpeningBalanceTransactionHistory(
      req.params.contactId,
      req.query.companyId,
      req.query.contactType,
    );
    return successResponse(res, data, OPENING_BALANCE_TRANSACTION_MESSAGES.FETCH_HISTORY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getOpeningBalanceTransactionHistory',
    controller: 'openingBalanceTransaction',
    failureMessage: OPENING_BALANCE_TRANSACTION_MESSAGES.FETCH_HISTORY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getOpeningBalanceTransactionHistory,
};
