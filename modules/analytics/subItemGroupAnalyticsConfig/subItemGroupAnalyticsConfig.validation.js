const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createSubItemGroupAnalyticsConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object().keys({
    subItemGroupIds: Joi.array().items(Joi.string().custom(objectId)).required().label('Sub Item Group IDs').messages({
      'array.base': '{{#label}} must be an array',
      'any.required': '{{#label}} is required',
      'string.base': 'Each {{#label}} must be a string',
    }),
    groupTitle: Joi.string().max(100).required().label('Group Title').messages({
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} must be less than or equal to 100 characters',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const getSubItemGroupAnalyticsConfigs = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    startDate: Joi.date(),
    endDate: Joi.date(),
    isSplit: Joi.boolean().optional().allow(null),
    divisionId: Joi.string(),
    branchId: Joi.string(),
  }),
};

const updateSubItemGroupAnalyticsConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    subItemGroupAnalyticsConfigId: Joi.string().required().custom(objectId).label('Sub Item Group Analytics Config ID').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object()
    .keys({
      subItemGroupIds: Joi.array().items(Joi.string().custom(objectId)).optional().label('Sub Item Group IDs').messages({
        'array.base': '{{#label}} must be an array',
        'string.base': 'Each {{#label}} must be a string',
      }),
      groupTitle: Joi.string().max(100).optional().label('Group Title').messages({
        'string.base': '{{#label}} must be a string',
        'string.max': '{{#label}} must be less than or equal to 100 characters',
      }),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

const deleteSubItemGroupAnalyticsConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    subItemGroupAnalyticsConfigId: Joi.string().required().custom(objectId).label('Sub Item Group Analytics Config ID').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const getAnalyticsBySubItemGroupId = {
  params: Joi.object().keys({
    subItemGroupId: Joi.string().required().custom(objectId).label('Sub Item Group ID').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
    startDate: Joi.date(),
    endDate: Joi.date(),
    divisionId: Joi.string().custom(objectId),
    branchId: Joi.string().custom(objectId),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

module.exports = {
  createSubItemGroupAnalyticsConfig,
  getSubItemGroupAnalyticsConfigs,
  updateSubItemGroupAnalyticsConfig,
  deleteSubItemGroupAnalyticsConfig,
  getAnalyticsBySubItemGroupId,
};
