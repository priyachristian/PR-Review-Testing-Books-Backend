const moment = require('moment');
const { getCommonModels, getAbssAdminModels } = require('./model.service');
const { SUBSCRIPTION_STATUS, PLAN_FEATURES, APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { AGGREGATION_EXCLUDED_STATUSES } = require('../utils/enum');
const { countGstPlanFeatureUsage, isGstPlanFeature } = require('./gstDocumentUsage.service');
const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');

// Shared (isCommon) features (Customer, Item, Quotation, Sales Order, ...) are backed by
// one pooled collection across BOOKS and CRM. The effective limit for those is the max of
// what either app's active plan grants - not the sum - since usage is counted company-wide,
// not per-app. See getSiblingFeatureLimit.
async function getSiblingFeatureLimit(companyId, siblingAppName, featureKey, session) {
  const { CompanySubscription, BillingCycle } = getCommonModels();
  const { Plan, AddOns } = getAbssAdminModels();

  const siblingSubscription = await CompanySubscription.findOne({
    companyId,
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.DUE] },
    appName: siblingAppName,
  })
    .lean()
    .session(session);

  if (!siblingSubscription) {
    return { planLimit: 0, addonQty: 0, isUnlimited: false };
  }

  const siblingPlan = await Plan.findById(siblingSubscription.planId).lean().session(session);
  const siblingPlanFeature = siblingPlan?.limits?.find(f => f.featureName === featureKey);

  if (!siblingPlanFeature) {
    return { planLimit: 0, addonQty: 0, isUnlimited: false };
  }

  if (siblingPlanFeature.isUnlimited) {
    return { planLimit: Infinity, addonQty: 0, isUnlimited: true };
  }

  const siblingBillingCycle = await BillingCycle.findById(siblingSubscription.currentBillingCycleId).lean().session(session);
  const siblingAddons = (siblingBillingCycle?.addons || []).filter(a => a.addonStatus === SUBSCRIPTION_STATUS.ACTIVE);
  const siblingAddonIds = siblingAddons.map(a => a.addonId);
  const siblingAddonDocs = siblingAddonIds.length ? await AddOns.find({ _id: { $in: siblingAddonIds } }).lean() : [];

  let siblingAddonQty = 0;
  const matchedSiblingAddon = siblingAddonDocs.find(a => a.featureName === featureKey);
  if (matchedSiblingAddon) {
    const subAddon = siblingAddons.find(a => a.addonId.toString() === matchedSiblingAddon._id.toString());
    siblingAddonQty = matchedSiblingAddon.unitsIncluded * (subAddon?.quantity || 0);
  }

  return { planLimit: siblingPlanFeature.limit || 0, addonQty: siblingAddonQty, isUnlimited: false };
}

async function getSiblingFeatureLimitForDisplay(companyId, siblingAppName, featureKey, session) {
  const { CompanySubscription, BillingCycle } = getCommonModels();
  const { Plan, AddOns } = getAbssAdminModels();

  const siblingSubscription = await CompanySubscription.findOne({
    companyId,
    appName: siblingAppName,
    status: { $nin: AGGREGATION_EXCLUDED_STATUSES },
  })
    .sort({ createdAt: -1 })
    .lean()
    .session(session);

  if (!siblingSubscription) {
    return { planLimit: 0, addonQty: 0, isUnlimited: false, isPaymentIncomplete: false, siblingStatus: null };
  }

  const isPaymentIncomplete = ![SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.DUE].includes(siblingSubscription.status);

  const siblingPlan = await Plan.findById(siblingSubscription.planId).lean().session(session);
  const siblingPlanFeature = siblingPlan?.limits?.find(f => f.featureName === featureKey);

  if (!siblingPlanFeature) {
    return { planLimit: 0, addonQty: 0, isUnlimited: false, isPaymentIncomplete, siblingStatus: siblingSubscription.status };
  }

  if (siblingPlanFeature.isUnlimited) {
    return {
      planLimit: Infinity,
      addonQty: 0,
      isUnlimited: true,
      isPaymentIncomplete,
      siblingStatus: siblingSubscription.status,
    };
  }

  const siblingBillingCycle = await BillingCycle.findById(siblingSubscription.currentBillingCycleId).lean().session(session);
  const siblingAddons = (siblingBillingCycle?.addons || []).filter(a => a.addonStatus === SUBSCRIPTION_STATUS.ACTIVE);
  const siblingAddonIds = siblingAddons.map(a => a.addonId);
  const siblingAddonDocs = siblingAddonIds.length ? await AddOns.find({ _id: { $in: siblingAddonIds } }).lean() : [];

  let siblingAddonQty = 0;
  const matchedSiblingAddon = siblingAddonDocs.find(a => a.featureName === featureKey);
  if (matchedSiblingAddon) {
    const subAddon = siblingAddons.find(a => a.addonId.toString() === matchedSiblingAddon._id.toString());
    siblingAddonQty = matchedSiblingAddon.unitsIncluded * (subAddon?.quantity || 0);
  }

  return {
    planLimit: siblingPlanFeature.limit || 0,
    addonQty: siblingAddonQty,
    isUnlimited: false,
    isPaymentIncomplete,
    siblingStatus: siblingSubscription.status,
  };
}

async function checkSubscriptionLimit(companyId, featureKey, model, session = null, increment = 1, featureName = null, isCommon) {
  try {
    const { CompanySubscription, BillingCycle } = getCommonModels();
    const { Plan, AddOns } = getAbssAdminModels();

    const subscription = await CompanySubscription.findOne({
      companyId,
      status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.DUE] },
      appName: 'BOOKS',
    })
      .lean()
      .session(session);

    if (!subscription) {
      throw new ApiError(httpStatus.FORBIDDEN, 'No active subscription');
    }

    const startAt = moment(subscription?.currentStart).startOf('day').toDate();
    let endAt = moment(subscription?.currentEnd).endOf('day').toDate();

    const plan = await Plan.findById(subscription.planId).lean().session(session);
    if (!plan) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Plan not found');
    }

    const planFeature = plan.limits.find(f => f.featureName === featureKey);

    if (!planFeature) {
      throw new ApiError(httpStatus.FORBIDDEN, `Feature ${featureKey} not found in plan`);
    }

    const siblingLimit = isCommon
      ? await getSiblingFeatureLimit(companyId, APP_NAME.CRM, featureKey, session)
      : { planLimit: 0, addonQty: 0, isUnlimited: false };

    if (planFeature?.isUnlimited || siblingLimit.isUnlimited) {
      return true;
    }

    const currentBillingCycle = await BillingCycle.findById(subscription.currentBillingCycleId).lean();

    if (!currentBillingCycle) {
      throw new ApiError(httpStatus.NOT_FOUND, 'No billing cycle details found for the subscription');
    }

    subscription.addons = currentBillingCycle.addons || [];

    const planLimit = planFeature?.limit || 0;
    const addons = subscription.addons || [];
    const addonIds = addons.filter(a => a.addonStatus === SUBSCRIPTION_STATUS.ACTIVE).map(a => a.addonId);

    let addonDocs = [];

    if (addonIds.length) {
      addonDocs = await AddOns.find({ _id: { $in: addonIds } }).lean();
    }

    let addonQty = 0;

    const matchedAddon = addonDocs.find(a => a.featureName === featureKey);

    if (matchedAddon) {
      const subAddon = addons.find(a => a.addonId.toString() === matchedAddon._id.toString());
      addonQty = matchedAddon.unitsIncluded * (subAddon?.quantity || 0);
    }

    const totalLimit = Math.max(planLimit, siblingLimit.planLimit) + addonQty + siblingLimit.addonQty;

    let query = { companyId };

    if (planFeature.interval === 'monthly') {
      endAt.setMonth(endAt.getMonth() + 1);
    } else if (planFeature.interval === 'yearly') {
      endAt.setFullYear(endAt.getFullYear() + 1);
    }

    if (planFeature.interval) {
      query.createdAt = {
        $gte: startAt,
        $lt: endAt,
      };
    }

    if (featureKey === PLAN_FEATURES.CUSTOMER) {
      query['Role.isCustomer'] = true;
    }
    if (featureKey === PLAN_FEATURES.VENDOR) {
      query['Role.isVendor'] = true;
    }
    const totalUsage = isGstPlanFeature(featureKey)
      ? await countGstPlanFeatureUsage({ featureKey, baseQuery: query, session })
      : await model.countDocuments(query).session(session);

    if (totalUsage + increment > totalLimit) {
      const formattedFeatureKey = featureName
        .toLowerCase()
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      if (increment > 1) {
        const remaining = Math.max(totalLimit - totalUsage, 0);
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `This upload has ${increment} ${formattedFeatureKey} records, but only ${remaining} of your ${totalLimit} limit remain. Reduce the number of records, upgrade your plan, or purchase an add-on.`,
        );
      }

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `You've reached your ${formattedFeatureKey} usage limit. Upgrade your plan or purchase add-ons to increase your limits.`,
      );
    }

    return true;
  } catch (error) {
    console.error('Error checking subscription limit:', error);
    throw error;
  }
}

// In-memory cache for CRM subscription checks.
// Keyed by companyId string; entries expire after 5 minutes so that plan
// changes take effect within a reasonable time without hammering the DB on
// every request.
const _crmCache = new Map();
const CRM_CACHE_TTL_MS = 5 * 60 * 1000;

const hasCRMSubscription = async (companyId, session = null) => {
  if (!companyId) return false;

  const key = companyId.toString();
  const cached = _crmCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { CompanySubscription } = getCommonModels();
  const { Plan } = getAbssAdminModels();

  const activePlanIds = await CompanySubscription.distinct('planId', {
    companyId,
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.DUE] },
  }).session(session);

  if (!activePlanIds.length) {
    _crmCache.set(key, { value: false, expiresAt: Date.now() + CRM_CACHE_TTL_MS });
    return false;
  }

  const exists = await Plan.exists({
    _id: { $in: activePlanIds },
    appName: APP_NAME.CRM,
  }).session(session);

  const result = Boolean(exists);
  _crmCache.set(key, { value: result, expiresAt: Date.now() + CRM_CACHE_TTL_MS });
  return result;
};

module.exports = {
  checkSubscriptionLimit,
  hasCRMSubscription,
  getSiblingFeatureLimit,
  getSiblingFeatureLimitForDisplay,
};
