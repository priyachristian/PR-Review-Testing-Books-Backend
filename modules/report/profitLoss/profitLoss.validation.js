const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');

const getProfitLossByCustomer = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isOptional: true }),
    endDate: commonSchemas.date({ label: 'End Date', isOptional: true }),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    sortBy: Joi.string().trim(),
    limit: Joi.number().integer().min(1).max(1000),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
  }),
};

const getProfitLossSummaryByCustomer = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID', isOptional: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isOptional: true }),
    endDate: commonSchemas.date({ label: 'End Date', isOptional: true }),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    search: Joi.string().trim().optional(),
    sortBy: Joi.string().trim(),
    limit: Joi.number().integer().min(1).max(1000),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
  }),
};

const getProfitLossSummaryByItem = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    itemId: commonSchemas.objectId({ label: 'Item ID', isOptional: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isOptional: true }),
    endDate: commonSchemas.date({ label: 'End Date', isOptional: true }),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    search: Joi.string().trim().optional(),
    sortBy: Joi.string().trim(),
    limit: Joi.number().integer().min(1).max(1000),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
    itemType: Joi.string().trim().optional(),
    itemGroup: Joi.string().trim().optional(),
  }),
};

const getProfitLossByItem = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isOptional: true }),
    endDate: commonSchemas.date({ label: 'End Date', isOptional: true }),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    sortBy: Joi.string().trim(),
    limit: Joi.number().integer().min(1).max(1000),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
  }),
};

const getProfitLossByCustomerMonthWise = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isOptional: true }),
    endDate: commonSchemas.date({ label: 'End Date', isOptional: true }),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    search: Joi.string().trim().optional(),
    sortBy: Joi.string().trim(),
    limit: Joi.number().integer().min(1).max(1000),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
  }),
};

const getDocumentDetails = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    documentId: commonSchemas.objectId({ label: 'Document ID', isRequired: true }),
  }),
};

const getDocumentDetailsByItemId = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    documentId: commonSchemas.objectId({ label: 'Document ID', isRequired: true }),
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
  }),
};

const getProductionOrderDetails = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    productionOrderId: commonSchemas.objectId({ label: 'Production Order ID', isRequired: true }),
    sortBy: Joi.string().trim(),
    limit: Joi.number().integer().min(1).max(1000),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
  }),
};

const getBatchSourceDetailsBulk = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
    batches: Joi.array()
      .items(
        Joi.object().keys({
          itemBatchId: commonSchemas.objectId({ label: 'Item Batch ID', isRequired: true }),
        }),
      )
      .min(1)
      .required(),
  }),
};

module.exports = {
  getProfitLossByCustomer,
  getProfitLossSummaryByCustomer,
  getProfitLossSummaryByItem,
  getProfitLossByItem,
  getProfitLossByCustomerMonthWise,
  getDocumentDetails,
  getDocumentDetailsByItemId,
  getProductionOrderDetails,
  getBatchSourceDetailsBulk,
};
