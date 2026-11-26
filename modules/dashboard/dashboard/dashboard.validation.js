const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');

const getPurchaseOrderValidation = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    startDate: Joi.date(),
    endDate: Joi.date(),
  }),
};

const getSalesOrderValidation = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    startDate: Joi.date(),
    endDate: Joi.date(),
  }),
};

const getInvoiceValidation = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    startDate: Joi.date(),
    endDate: Joi.date(),
  }),
};

const getBillValidation = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    startDate: Joi.date(),
    endDate: Joi.date(),
  }),
};

const salesAnalyticsValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const dashboardSummaryValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    isSplit: Joi.boolean().optional().allow(null),
    ...commonSchemas.dateRangeQuery(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
  }),
};

const userWiseSummaryValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

module.exports = {
  getPurchaseOrderValidation,
  getSalesOrderValidation,
  getInvoiceValidation,
  getBillValidation,
  salesAnalyticsValidation,
  dashboardSummaryValidation,
  userWiseSummaryValidation,
};
