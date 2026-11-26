const httpStatus = require('http-status');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { getCommonModels } = require('../services/model.service');
const { checkSubscriptionLimit } = require('../services/checkSubscription.service');
const { FEATURE_MODEL_MAP } = require('../utils/featureModelMap');
const ApiError = require('../utils/ApiError');

const EWAY_BILL_FEATURES = [PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL, PLAN_FEATURES.ONLY_E_WAY_BILL];

const checkEWayBillSubscription = (increment = 1) => {
  return async (req, res, next) => {
    try {
      const companyId = req.user?.companyId || req.body?.companyId || req.params?.companyId || req.query?.companyId;
      if (!companyId) {
        return next(new ApiError(httpStatus.BAD_REQUEST, 'Company identifier is required.'));
      }

      const { Company } = getCommonModels();
      const company = await Company.findOne({ _id: companyId }, { applicableFeature: 1 }).lean();
      if (!company) {
        return next(new ApiError(httpStatus.NOT_FOUND, 'Company not found'));
      }

      const featureKey = company.applicableFeature;
      if (!EWAY_BILL_FEATURES.includes(featureKey)) {
        return next(new ApiError(httpStatus.FORBIDDEN, 'E-way bill generation is not available on your current plan.'));
      }

      const entry = FEATURE_MODEL_MAP[featureKey];
      if (!entry) {
        return next(new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `No model mapped for feature: ${featureKey}`));
      }

      const model = entry.getModels()[entry.modelName];
      await checkSubscriptionLimit(companyId, featureKey, model, null, increment, featureKey, entry.isCommon);

      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = { checkEWayBillSubscription };
