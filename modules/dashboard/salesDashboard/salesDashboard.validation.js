const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');

const baseQuerySchema = Joi.object().keys({
  companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  ...commonSchemas.dateRangeQuery(),
  branchId: Joi.string().optional(),
  divisionId: Joi.string().optional(),
  userId: Joi.string().optional().custom(objectId),
  isSplit: Joi.boolean().optional(),
});

const summaryValidation = {
  query: baseQuerySchema,
};

const stateWiseValidation = {
  query: baseQuerySchema.keys({
    sortBy: Joi.string().optional(),
  }),
};

const cityWiseValidation = {
  query: baseQuerySchema.keys({
    state: Joi.string().required(),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string().optional(),
  }),
};

const customersValidation = {
  query: baseQuerySchema.keys({
    state: Joi.string().required(),
    city: Joi.string().required(),
  }),
};

const inactiveCustomersValidation = {
  query: baseQuerySchema.keys({
    state: Joi.string().optional(),
    city: Joi.string().optional(),
  }),
};

const customerInvoicesValidation = {
  query: baseQuerySchema.keys({
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
  }),
};

const nonOrderCustomersValidation = {
  query: baseQuerySchema,
};

const nonOrderCustomerListValidation = {
  query: baseQuerySchema.keys({
    state: Joi.string().required(),
    city: Joi.string().optional(),
  }),
};

const itemGroupAnalyticsValidation = {
  query: baseQuerySchema,
};

const customerWiseValidation = {
  query: baseQuerySchema.keys({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string().optional(),
  }),
};

const itemWiseValidation = {
  query: baseQuerySchema.keys({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string().optional(),
  }),
};

const getOrderStatusSummary = {
  query: baseQuerySchema,
};

const getItemWiseDetails = {
  params: Joi.object().keys({
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
  }),
  query: baseQuerySchema.keys({
    tab: Joi.string().valid('customer', 'state').required(),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string().optional(),
  }),
};

const getCustomerWiseDetails = {
  params: Joi.object().keys({
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
  }),
  query: baseQuerySchema.keys({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string().optional(),
  }),
};

const getStateWiseDetails = {
  params: Joi.object().keys({
    stateId: commonSchemas.objectId({ label: 'State ID', isRequired: true }),
  }),
  query: baseQuerySchema.keys({
    tab: Joi.string().valid('customer', 'item').required(),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string().optional(),
  }),
};

module.exports = {
  summaryValidation,
  stateWiseValidation,
  cityWiseValidation,
  customersValidation,
  inactiveCustomersValidation,
  customerInvoicesValidation,
  nonOrderCustomersValidation,
  nonOrderCustomerListValidation,
  itemGroupAnalyticsValidation,
  customerWiseValidation,
  itemWiseValidation,
  getOrderStatusSummary,
  getItemWiseDetails,
  getCustomerWiseDetails,
  getStateWiseDetails,
};
