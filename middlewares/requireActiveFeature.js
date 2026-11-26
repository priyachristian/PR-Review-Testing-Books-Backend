const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { activeFeatureList } = require('../modules/setting/companyProfile/companyProfile.service');

/**
 * Gate a route on a plan feature actually being ACTIVE for the company — the same
 * source the frontend reads via GET company/activeFeatureList — independent of any
 * usage/limit count (unlike checkSubscription, which counts resource creation).
 *
 * @param {string} featureName - A PLAN_FEATURES key (e.g. PLAN_FEATURES.CUSTOMER_ORDER)
 */
const requireActiveFeature = featureName => async (req, res, next) => {
  try {
    const companyId = req.user?.companyId || req.body?.companyId || req.params?.companyId || req.query?.companyId;
    if (!companyId) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Company is required'));
    }

    const features = await activeFeatureList(companyId);
    if (!features?.[featureName]) {
      return next(new ApiError(httpStatus.FORBIDDEN, 'Please upgrade your plan to access this feature'));
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = { requireActiveFeature };
