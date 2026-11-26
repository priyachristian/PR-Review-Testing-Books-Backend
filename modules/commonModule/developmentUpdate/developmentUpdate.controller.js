const httpStatus = require('http-status');
const { DEVELOPMENT_UPDATE_MESSAGE } = require('../../../utils/messages');
const catchAsync = require('../../../utils/catchAsync');
const { successResponse } = require('../../../services/response.service');
const developmentUpdateService = require('./developmentUpdate.service');

const listGlobalDevelopmentUpdates = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const result = await developmentUpdateService.listDevelopmentUpdate(companyId);
    return successResponse(res, result, DEVELOPMENT_UPDATE_MESSAGE.LIST_SUCCESS, httpStatus.OK);
  },
  {
    service: 'listDevelopmentUpdate',
    controller: 'developmentUpdate',
    failureMessage: DEVELOPMENT_UPDATE_MESSAGE.LIST_FAILED,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  listGlobalDevelopmentUpdates,
};
