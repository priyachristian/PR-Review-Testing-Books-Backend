const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const inventoryLogsService = require('./inventoryLogs.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { INVENTORY_LOGS_MESSAGES } = require('../../../utils/messages');

const getAllInventoryLogs = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'branchId',
      'divisionId',
      'warehouseId',
      'itemId',
      'startDate',
      'endDate',
      'createdAt',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { results, ...otherFields } = await inventoryLogsService.getAllInventoryLogs(req.query, filter, options);
    return successResponse(res, results, INVENTORY_LOGS_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllInventoryLogs',
    controller: 'inventoryLogs',
    failureMessage: INVENTORY_LOGS_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getInventoryLogById = catchAsync(
  async (req, res) => {
    const inventoryLog = await inventoryLogsService.getInventoryLogById(req.params.inventoryLogId, req.query.companyId);
    return successResponse(res, inventoryLog, INVENTORY_LOGS_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getInventoryLogById',
    controller: 'inventoryLogs',
    failureMessage: INVENTORY_LOGS_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getAllInventoryLogs,
  getInventoryLogById,
};
