const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const ledgerService = require('./ledger.service');
const { successResponse } = require('../../../services/response.service');
const { ACCOUNT_MESSAGES } = require('../../../utils/messages');

const getJournalBySource = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'sourceModule', 'sourceId']);
    const journal = await ledgerService.getJournalBySource(filter);
    return successResponse(res, journal, ACCOUNT_MESSAGES.DOCUMENT_JOURNAL_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getJournalBySource',
    controller: 'ledger',
    failureMessage: ACCOUNT_MESSAGES.DOCUMENT_JOURNAL_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getJournalBySource,
};
