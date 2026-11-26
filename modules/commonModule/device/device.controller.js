const httpStatus = require('http-status');

const catchAsync = require('../../../utils/catchAsync');
const deviceService = require('./device.service');
const { successResponse } = require('../../../services/response.service');
const { DEVICE_MESSAGES } = require('../../../utils/messages');

const storeDeviceToken = catchAsync(
  async (req, res) => {
    const userId = req.user._id;

    const device = await deviceService.storeDeviceToken(userId, req.body);

    return successResponse(res, device, DEVICE_MESSAGES.STORE_TOKEN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'storeDeviceToken',
    controller: 'device',
    failureMessage: DEVICE_MESSAGES.STORE_TOKEN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  storeDeviceToken,
};
