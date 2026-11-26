const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');

const dateOnly = label =>
  Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .required()
    .label(label)
    .messages({
      'any.required': `"${label}" is required`,
      'string.base': `"${label}" must be a string`,
      'string.pattern.base': `"${label}" must be in YYYY-MM-DD format`,
    });

const stockSummaryValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    fromDate: dateOnly('From Date'),
    toDate: dateOnly('To Date'),
    branchId: Joi.string().optional().allow('', null),
    divisionId: Joi.string().optional().allow('', null),
    warehouseId: Joi.string().optional().allow('', null),
    itemId: Joi.string().optional().allow('', null),
    itemGroupId: Joi.string().optional().allow('', null),
    search: Joi.string().optional().allow('', null),
    stockStatus: Joi.string().optional().allow('', null),
    isSplit: Joi.boolean().optional().allow(null),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().optional().allow('', null),
    sortBy: Joi.string().optional().allow('', null),
  }),
};

const dateWiseValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    fromDate: dateOnly('From Date'),
    toDate: dateOnly('To Date'),
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
    warehouseId: commonSchemas.objectId({ label: 'Warehouse ID', isRequired: true }),
    branchId: Joi.string().optional().allow('', null),
    divisionId: Joi.string().optional().allow('', null),
    isSplit: Joi.boolean().optional().allow(null),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    pagination: Joi.string().optional().allow('', null),
  }),
};

module.exports = { stockSummaryValidation, dateWiseValidation };
