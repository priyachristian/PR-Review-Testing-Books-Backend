const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createSubItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    name: Joi.string().required().label('Sub Item Group Name').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const getSubItemGroups = {
  query: Joi.object().keys({
    search: Joi.string(),
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
    appName: Joi.string().allow('', null).optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getSubItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
  params: Joi.object().keys({
    subItemGroupId: Joi.string().custom(objectId),
  }),
};

const updateSubItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
  params: Joi.object().keys({
    subItemGroupId: Joi.required().custom(objectId).label('Sub Item Group ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId string',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().label('Sub Item Group Name').messages({
        'string.base': '{{#label}} must be a string',
      }),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided to update the sub item group.',
    }),
};

const deleteSubItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
  params: Joi.object().keys({
    subItemGroupId: Joi.string().custom(objectId),
  }),
};

const getSubItemGroupsDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
};

module.exports = {
  createSubItemGroup,
  getSubItemGroups,
  getSubItemGroup,
  updateSubItemGroup,
  deleteSubItemGroup,
  getSubItemGroupsDropdown,
};
