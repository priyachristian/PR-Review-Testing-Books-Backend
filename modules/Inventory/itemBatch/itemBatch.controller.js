const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const itemBatchService = require('./itemBatch.service');
const { successResponse } = require('../../../services/response.service');
const { ITEM_BATCH_MESSAGES } = require('../../../utils/messages');

const getItemBatches = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'divisionId', 'branchId', 'warehouseId', 'itemId', 'sourceType', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await itemBatchService.queryItemBatches(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, ITEM_BATCH_MESSAGES.FETCH_LIST_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryItemBatches',
    controller: 'itemBatch',
    failureMessage: ITEM_BATCH_MESSAGES.FETCH_LIST_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getItemBatch = catchAsync(
  async (req, res) => {
    const batch = await itemBatchService.getItemBatchById(req.params.batchId, req.query.companyId);
    return successResponse(res, batch, ITEM_BATCH_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemBatchById',
    controller: 'itemBatch',
    failureMessage: ITEM_BATCH_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getItemBatches,
  getItemBatch,
};
