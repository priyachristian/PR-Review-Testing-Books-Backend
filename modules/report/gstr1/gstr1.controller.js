const catchAsync = require('../../../utils/catchAsync');
const { successResponse } = require('../../../services/response.service');
const gstr1Service = require('./gstr1.service');
const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const { GSTR1_MESSAGES } = require('../../../utils/messages');

const generateGstr1Report = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate']);

    const report = await gstr1Service.generateGstr1Report(filter);
    return successResponse(res, report, GSTR1_MESSAGES.REPORT_GENERATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'generateGstr1Report',
    controller: 'gstr1',
    failureMessage: GSTR1_MESSAGES.REPORT_GENERATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  generateGstr1Report,
};
