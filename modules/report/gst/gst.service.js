const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getCommonModels } = require('../../../services/model.service');
const { GST_MESSAGES } = require('../../../utils/messages');
const providerOrchestrator = require('../../sales/invoice/providers/providerOrchestrator.service');

const getGstDetails = async (gstin, companyId, userId) => {
  const { Company } = getCommonModels();
  const company = await Company.findOne({ _id: companyId }, { applicableFeature: 1, gstNumber: 1 }).lean();
  if (!company) {
    throw new ApiError(httpStatus.BAD_REQUEST, GST_MESSAGES.COMPANY_NOT_FOUND);
  }
  if (!company.applicableFeature) {
    throw new ApiError(httpStatus.BAD_REQUEST, GST_MESSAGES.APPLICABLE_FEATURE_NOT_CONFIGURED);
  }

  const result = await providerOrchestrator.execute('verifyGSTIN', { gstin, company }, { companyId, userId });
  return { status: 1, data: result.data };
};

module.exports = {
  getGstDetails,
};
