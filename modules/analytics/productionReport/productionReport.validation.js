const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');

const monthlySummaryValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    year: Joi.number().integer().min(2000).max(2100).required().label('Year').messages({
      'any.required': '"Year" is required',
      'number.base': '"Year" must be a number',
    }),
    branchId: Joi.string().optional().allow('', null),
    divisionId: Joi.string().optional().allow('', null),
  }),
};

const monthlyDetailValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    year: Joi.number().integer().min(2000).max(2100).required().label('Year').messages({
      'any.required': '"Year" is required',
    }),
    month: Joi.number().integer().min(1).max(12).required().label('Month').messages({
      'any.required': '"Month" is required',
      'number.min': '"Month" must be between 1 and 12',
      'number.max': '"Month" must be between 1 and 12',
    }),
    branchId: Joi.string().optional().allow('', null),
    divisionId: Joi.string().optional().allow('', null),
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
    sortBy: Joi.string().optional(),
    pagination: Joi.boolean().optional(),
  }),
};

const monthlyDetailByItemValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    year: Joi.number().integer().min(2000).max(2100).required().label('Year').messages({
      'any.required': '"Year" is required',
    }),
    month: Joi.number().integer().min(1).max(12).required().label('Month').messages({
      'any.required': '"Month" is required',
    }),
    branchId: Joi.string().optional().allow('', null),
    divisionId: Joi.string().optional().allow('', null),
    page: Joi.number().optional().min(1),
    limit: Joi.number().optional().min(1),
    pagination: Joi.boolean().optional(),
  }),
};

module.exports = {
  monthlySummaryValidation,
  monthlyDetailValidation,
  monthlyDetailByItemValidation,
};
