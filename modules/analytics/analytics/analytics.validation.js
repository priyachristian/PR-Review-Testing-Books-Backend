const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');
const { GENERAL_SALES_ANALYTICS_BASIS, GENERAL_SALES_ANALYTICS_MODULES } = require('../../../utils/enum');

const salesAnalyticsValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
    isSplit: Joi.boolean().optional().allow(null),
    sortBy: Joi.string().optional(),
    itemId: Joi.string().optional(),
    itemGroupId: Joi.string().optional(),
    customerId: Joi.string().optional(),
  }),
};

const itemProcessAnalyticsValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    itemId: Joi.string().optional(),
    process: Joi.string().optional().allow(''),
    ...commonSchemas.dateRangeQuery(),
    pagination: Joi.boolean().optional(),
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
  }),
};

const customersWithSingleInvoiceValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const partyWiseBusinessPerformanceValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    branchId: Joi.string().optional().allow(''),
    divisionId: Joi.string().optional().allow(''),
    customerId: Joi.string().optional().allow(''),
    addedBy: Joi.string().optional().allow('').custom(objectId).label('Added By'),
    state: Joi.string().optional().allow(''),
    city: Joi.string().optional().allow(''),
    ...commonSchemas.dateRangeQuery(),
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
    sortBy: Joi.string().optional().allow(''),
  }),
};

const exportPartyWiseBusinessPerformanceValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    branchId: Joi.string().optional().allow(''),
    divisionId: Joi.string().optional().allow(''),
    customerId: Joi.string().optional().allow(''),
    addedBy: Joi.string().optional().allow('').custom(objectId).label('Added By'),
    state: Joi.string().optional().allow(''),
    city: Joi.string().optional().allow(''),
    ...commonSchemas.dateRangeQuery(),
    sortBy: Joi.string().optional().allow(''),
    fileName: Joi.string().optional().allow('').max(120),
  }),
};

const documentConfigSchema = Joi.object().keys({
  module: Joi.string()
    .required()
    .valid(...Object.values(GENERAL_SALES_ANALYTICS_MODULES))
    .label('Document module')
    .messages({ 'any.required': 'Document module is required' }),
  statuses: Joi.array().items(Joi.string()).optional().default([]).label('Statuses'),
});

const createGeneralSalesAnalytics = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    reportName: Joi.string()
      .required()
      .trim()
      .min(1)
      .max(200)
      .label('Report name')
      .messages({ 'any.required': '"Report name" is required' }),
    reportBasis: Joi.string()
      .required()
      .valid(...Object.values(GENERAL_SALES_ANALYTICS_BASIS))
      .label('Report basis')
      .messages({ 'any.required': 'Report basis is required', 'any.only': 'Report basis must be ITEM or ITEM_GROUP' }),
    basisIds: Joi.array()
      .items(Joi.string().custom(objectId))
      .min(1)
      .required()
      .label('Basis IDs (items or item groups)')
      .messages({ 'array.min': 'At least one basis record is required' }),
    documents: Joi.array()
      .items(documentConfigSchema)
      .min(1)
      .required()
      .label('Documents')
      .messages({ 'array.min': 'At least one document is required' }),
  }),
};

const getGeneralSalesAnalytics = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const getGeneralSalesAnalyticsById = {
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Report ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isRequired: false }),
    endDate: commonSchemas.date({ label: 'End Date', isRequired: false }),
    page: commonSchemas.number({ label: 'Page', isRequired: false }),
    limit: commonSchemas.number({ label: 'Limit', isRequired: false }),
  }),
};

const updateGeneralSalesAnalytics = {
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Report ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      reportName: commonSchemas.string({ label: 'Report name', isRequired: false }),
      reportBasis: commonSchemas.string({
        label: 'Report basis',
        isRequired: false,
        allow: Object.values(GENERAL_SALES_ANALYTICS_BASIS),
      }),
      basisIds: Joi.array()
        .items(Joi.string().custom(objectId))
        .min(1)
        .optional()
        .label('Basis IDs (items or item groups)')
        .messages({ 'array.min': 'At least one basis record is required' }),
      documents: Joi.array()
        .items(documentConfigSchema)
        .min(1)
        .optional()
        .label('Documents')
        .messages({ 'array.min': 'At least one document is required' }),
    })
    .min(1)
    .messages({ 'object.min': 'At least one field is required to update' }),
};

const deleteGeneralSalesAnalytics = {
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Report ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

module.exports = {
  salesAnalyticsValidation,
  itemProcessAnalyticsValidation,
  customersWithSingleInvoiceValidation,
  partyWiseBusinessPerformanceValidation,
  exportPartyWiseBusinessPerformanceValidation,
  createGeneralSalesAnalytics,
  getGeneralSalesAnalytics,
  getGeneralSalesAnalyticsById,
  updateGeneralSalesAnalytics,
  deleteGeneralSalesAnalytics,
};
