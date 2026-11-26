const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { checkSubscriptionLimit } = require('../services/checkSubscription.service');
const { FEATURE_MODEL_MAP } = require('../utils/featureModelMap');
const { BULK_BODY_ARRAY_KEY } = require('../utils/enum');

/**
 * Middleware factory to check subscription limits before allowing resource creation.
 *
 * @param {string} featureKey - A PLAN_FEATURES key (e.g. PLAN_FEATURES.DIVISION)
 * @param {number} [increment=1] - Number of resources being created in this request, used only
 *   when featureKey isn't a bulk feature (see BULK_BODY_ARRAY_KEY) with a matching body array
 *
 * Usage in router:
 *   router.post('/', checkSubscription(PLAN_FEATURES.DIVISION), controller.create);
 */
const checkSubscription = (featureKey, increment = 1) => {
  return async (req, res, next) => {
    try {
      if (featureKey === PLAN_FEATURES.CUSTOMER) {
        if (req.body?.Role?.isCustomer || req.query?.isCustomer) {
          featureKey = PLAN_FEATURES.CUSTOMER;
        }
        if (req.body?.Role?.isVendor || req.query?.isVendor) {
          featureKey = PLAN_FEATURES.VENDOR;
        }
      }

      const companyId = req.user?.companyId || req.body?.companyId || req.params?.companyId || req.query?.companyId;

      const bulkArrayKey = BULK_BODY_ARRAY_KEY[featureKey];
      const bulkRecords = bulkArrayKey ? req.body?.[bulkArrayKey] : null;
      increment = Array.isArray(bulkRecords) ? bulkRecords.length : increment || 1;

      const entry = FEATURE_MODEL_MAP[featureKey];
      if (!entry) {
        return next(new Error(`No model mapped for feature: ${featureKey}`));
      }

      if (req.path === '/invite' && req.body.type && req.body.type === 'resend') {
        next();
        return;
      }

      const model = entry.getModels()[entry.modelName];
      if (
        featureKey === PLAN_FEATURES.BRANCH ||
        featureKey === PLAN_FEATURES.DIVISION ||
        featureKey === PLAN_FEATURES.WAREHOUSE
      ) {
        await checkSubscriptionLimit(companyId, PLAN_FEATURES.WAREHOUSE, model, null, increment, featureKey, entry.isCommon);
      } else {
        await checkSubscriptionLimit(companyId, featureKey, model, null, increment, featureKey, entry.isCommon);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = { checkSubscription };
