const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { PRODUCTION_MANAGE_METHOD } = require('../../../utils/enum');

const baseQuery = {
  companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  branchId: Joi.string().optional(),
  divisionId: Joi.string().optional(),
  itemId: Joi.string().optional(),
  productionManageMethod: Joi.string()
    .valid(...Object.values(PRODUCTION_MANAGE_METHOD))
    .optional(),
  ...commonSchemas.dateRangeQuery(),
};

const summaryValidation = {
  query: Joi.object().keys(baseQuery),
};

const trendValidation = {
  query: Joi.object().keys({
    ...baseQuery,
    groupBy: Joi.string().valid('day', 'week', 'month').default('month'),
  }),
};

const byItemValidation = {
  query: Joi.object().keys({
    ...baseQuery,
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
  }),
};

const byRawMaterialValidation = {
  query: Joi.object().keys({
    ...baseQuery,
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
  }),
};

const byProcessValidation = {
  query: Joi.object().keys({
    ...baseQuery,
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
  }),
};

const byBranchValidation = {
  query: Joi.object().keys({
    ...baseQuery,
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
  }),
};

const itemRejectionReportOfProductionOrder = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    itemId: commonSchemas.objectId({ label: 'Item ID', isOptional: true }),
    itemType: Joi.string().valid('RM', 'FG').optional().label('Item Type'),
    startDate: Joi.date().optional().label('Start Date'),
    endDate: Joi.date().optional().label('End Date'),
    pagination: Joi.boolean().optional(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const itemRejectionProductionOrderList = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
    startDate: Joi.date().optional().label('Start Date'),
    endDate: Joi.date().optional().label('End Date'),
  }),
};

module.exports = {
  summaryValidation,
  trendValidation,
  byItemValidation,
  byRawMaterialValidation,
  byProcessValidation,
  byBranchValidation,
  itemRejectionReportOfProductionOrder,
  itemRejectionProductionOrderList,
};
