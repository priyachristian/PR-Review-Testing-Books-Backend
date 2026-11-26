const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { MODULE_NAMES } = require('../../../utils/enum');

const ITEM_MODULEWISE_SUPPORTED_MODULES = [
  MODULE_NAMES.QUOTATION,
  MODULE_NAMES.SALES_ORDER,
  MODULE_NAMES.DELIVERY_CHALLAN,
  MODULE_NAMES.INVOICE,
  MODULE_NAMES.PURCHASE_ORDER,
  MODULE_NAMES.BILL,
  MODULE_NAMES.GRPO,
  MODULE_NAMES.PRODUCTION_ORDER,
];

const VALID_CATEGORIES = ['Capital / Equity', 'Non-Current Liabilities', 'Current Liabilities', 'Fixed Assets', 'Current Assets'];

const getLedgerReport = {
  query: Joi.object().keys({
    customerId: Joi.string()
      .required()
      .custom(objectId)
      .label('Customer ID')
      .messages({ 'any.required': '"Customer ID" is required' }),

    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.date()
      .label('Start Date')
      .messages({
        'date.base': '{{#label}} must be a valid date',
      })
      .optional(),
    endDate: Joi.date()
      .label('End Date')
      .messages({
        'date.base': '{{#label}} must be a valid date',
      })
      .optional(),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
    includeLinkedData: Joi.string().valid('true', 'false').optional().label('Include Linked Data').messages({
      'any.only': '{{#label}} must be either "true" or "false"',
    }),
  }),
};

const invoiceBarGraph = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    FY: Joi.string()
      .required()
      .pattern(/^\d{4}$/)
      .label('Financial Year')
      .messages({
        'any.required': '{{#label}} is required',
        'string.pattern.base': '{{#label}} must be in format YYYY (e.g. 2025)',
      }),
    divisionId: Joi.string().optional().label('Division Id'),
    branchId: Joi.string().optional().label('Branch Id'),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const invoiceBarGraphDetail = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.date().optional().label('Start Date'),
    endDate: Joi.date().optional().label('End Date'),
    divisionId: Joi.string().optional().label('Division Id'),
    branchId: Joi.string().optional().label('Branch Id'),
    sortField: Joi.string().required().label('Sort Field').messages({
      'any.required': '{{#label}} is required',
    }),
    sortOrder: Joi.string().valid('asc', 'desc').required().label('Sort Order').messages({
      'any.only': '{{#label}} must be either "asc" or "desc"',
      'any.required': '{{#label}} is required',
    }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const billBarGraph = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    FY: Joi.string()
      .required()
      .pattern(/^\d{4}$/)
      .label('Financial Year')
      .messages({
        'any.required': '{{#label}} is required',
        'string.pattern.base': '{{#label}} must be in format YYYY (e.g. 2025)',
      }),
    divisionId: Joi.string().optional().label('Division Id'),
    branchId: Joi.string().optional().label('Branch Id'),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const billBarGraphDetail = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.date().optional().label('Start Date'),
    endDate: Joi.date().optional().label('End Date'),
    divisionId: Joi.string().optional().label('Division Id'),
    branchId: Joi.string().optional().label('Branch Id'),
    sortField: Joi.string().required().label('Sort Field').messages({
      'any.required': '{{#label}} is required',
    }),
    sortOrder: Joi.string().valid('asc', 'desc').required().label('Sort Order').messages({
      'any.only': '{{#label}} must be either "asc" or "desc"',
      'any.required': '{{#label}} is required',
    }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const creditorsReport = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.date().optional().allow(null).label('Start Date').messages({
      'date.base': '{{#label}} must be a valid date',
    }),
    endDate: Joi.date().optional().allow(null).label('End Date').messages({
      'date.base': '{{#label}} must be a valid date',
    }),
    divisionId: Joi.string().optional().label('Division Id'),
    branchId: Joi.string().optional().label('Branch Id'),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
    withZeroBalance: Joi.boolean().required(),
    column: Joi.string().optional().valid('DEBIT', 'CREDIT').optional().label('Column').messages({
      'any.only': '{{#label}} must be either "DEBIT" or "CREDIT"',
    }),
    includeLinkedData: Joi.boolean().optional().label('Include Linked Data'),
  }),
};

const getBankHistory = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    accountId: Joi.string().required().custom(objectId).label('Account ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    ...commonSchemas.paginationQuery(),
    isSplit: Joi.boolean().optional().allow(null),
    sortOrder: Joi.string().valid('asc', 'desc').optional().label('Sort Order'),
  }),
};

const itemModulewiseDetails = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
    }),
    itemId: Joi.string().optional().custom(objectId).label('Item ID'),
    moduleName: Joi.string()
      .valid(...ITEM_MODULEWISE_SUPPORTED_MODULES)
      .optional()
      .label('Module Name')
      .messages({
        'any.only': '{{#label}} must be one of the supported modules',
      }),
    startDate: Joi.date().optional().label('Start Date'),
    endDate: Joi.date().optional().label('End Date'),
    branchId: Joi.string().optional().label('Branch Id'),
    divisionId: Joi.string().optional().label('Division Id'),
    ...commonSchemas.paginationQuery(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const getProfitLossSheet = {
  query: Joi.object().keys({
    // Required: Company identification
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),

    // Required: Report period dates
    startDate: commonSchemas.date({ label: 'Start Date', isRequired: true }),
    endDate: commonSchemas.date({ label: 'End Date', isRequired: true }),

    // Optional: Product/Category filters (affects stock calculations)
    productId: commonSchemas.objectId({ label: 'Product ID', isOptional: true }),
    categoryId: commonSchemas.objectId({ label: 'Category ID', isOptional: true }),

    // Optional: Location filters
    warehouseId: commonSchemas.objectId({ label: 'Warehouse ID', isOptional: true }),
    branchId: Joi.string().optional(), // Can be comma-separated for multiple branches
    divisionId: commonSchemas.objectId({ label: 'Division ID', isOptional: true }),
  }),
};

const getBalanceSheetSummary = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isRequired: true }),
    endDate: commonSchemas.date({ label: 'End Date', isRequired: true }),
    category: Joi.string()
      .optional()
      .valid(...VALID_CATEGORIES),
    branchId: Joi.string().optional(),
    divisionId: commonSchemas.objectId({ label: 'Division ID', isOptional: true }),
  }),
};

module.exports = {
  getLedgerReport,
  invoiceBarGraph,
  billBarGraph,
  invoiceBarGraphDetail,
  billBarGraphDetail,
  creditorsReport,
  getBankHistory,
  itemModulewiseDetails,
  getProfitLossSheet,
  getBalanceSheetSummary,
};
