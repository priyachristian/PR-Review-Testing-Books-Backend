const { getBooksModels } = require('./model.service');
const { GST_DOCUMENT_USAGE_MODELS, GST_PLAN_FEATURE_USAGE } = require('../utils/enum');

const GENERATED_FILTERS = {
  eInvoice: { eInvoice: { $ne: null } },
  eWayBill: { eWayBill: { $ne: null } },
};

const generatedFilter = kinds =>
  kinds.length === 1 ? GENERATED_FILTERS[kinds[0]] : { $or: kinds.map(kind => GENERATED_FILTERS[kind]) };

const countGeneratedGstDocuments = async ({ baseQuery, kinds, session = null }) => {
  const models = getBooksModels();
  const filter = { ...baseQuery, ...generatedFilter(kinds) };
  const counts = await Promise.all(GST_DOCUMENT_USAGE_MODELS.map(name => models[name].countDocuments(filter).session(session)));
  return counts.reduce((total, count) => total + count, 0);
};

const isGstPlanFeature = featureKey => Boolean(GST_PLAN_FEATURE_USAGE[featureKey]);

const countGstPlanFeatureUsage = ({ featureKey, baseQuery, session = null }) =>
  countGeneratedGstDocuments({ baseQuery, kinds: GST_PLAN_FEATURE_USAGE[featureKey], session });

module.exports = { countGeneratedGstDocuments, countGstPlanFeatureUsage, isGstPlanFeature };
