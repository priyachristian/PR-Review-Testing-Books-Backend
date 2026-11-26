const catchAsync = require('../../../utils/catchAsync');
const { successResponse } = require('../../../services/response.service');
const gstService = require('./gst.service');
const httpStatus = require('http-status');
const { GST_MESSAGES } = require('../../../utils/messages');

const getGstDetails = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const { gstin } = req.params;
    const gstDetails = await gstService.getGstDetails(gstin, companyId, req.user._id);

    return successResponse(res, gstDetails, GST_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getGstDetails',
    controller: 'gst',
    failureMessage: GST_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getGstDetails,
};
