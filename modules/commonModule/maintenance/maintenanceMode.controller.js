const catchAsync = require('../../../utils/catchAsync');
const maintenanceModeService = require('./maintenanceMode.service');
const { successResponse } = require('../../../services/response.service');
const httpStatus = require('http-status');
const { MAINTENANCE_MODE_MESSAGES } = require('../../../utils/messages');

const getStatus = catchAsync(
  async (req, res) => {
    const status = await maintenanceModeService.getStatus();
    return successResponse(res, status, MAINTENANCE_MODE_MESSAGES.GET_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getStatus',
    controller: 'maintenanceMode',
    failureMessage: MAINTENANCE_MODE_MESSAGES.GET_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const status = await maintenanceModeService.updateStatus(req.body, req.user._id);
    return successResponse(res, status, MAINTENANCE_MODE_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateStatus',
    controller: 'maintenanceMode',
    failureMessage: MAINTENANCE_MODE_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getStatus,
  updateStatus,
};
