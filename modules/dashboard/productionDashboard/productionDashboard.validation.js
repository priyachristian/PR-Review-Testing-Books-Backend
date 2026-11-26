const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');

const baseQuery = Joi.object().keys({
  companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  ...commonSchemas.dateRangeQuery(),
  branchId: Joi.string().optional(),
  divisionId: Joi.string().optional(),
});

const summaryValidation = { query: baseQuery };
const pipelineValidation = { query: baseQuery };
const salesFunnelValidation = { query: baseQuery };
const trendValidation = { query: baseQuery.keys({ groupBy: Joi.string().valid('day', 'week', 'month').optional() }) };
const topItemsValidation = { query: baseQuery.keys({ limit: Joi.number().integer().min(1).max(20).optional() }) };

module.exports = {
  summaryValidation,
  pipelineValidation,
  salesFunnelValidation,
  trendValidation,
  topItemsValidation,
};
