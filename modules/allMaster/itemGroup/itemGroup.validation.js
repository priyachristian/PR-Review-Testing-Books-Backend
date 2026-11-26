const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    itemGroupId: Joi.string().required(),
    name: Joi.string().required().label('Item Group Name').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const getItemGroups = {
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

const getItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
  params: Joi.object().keys({
    itemGroupId: Joi.string().custom(objectId),
  }),
};

const updateItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
  params: Joi.object().keys({
    itemGroupId: Joi.required().custom(objectId).label('Item Group ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId string',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().label('Item Group Name').messages({
        'string.base': '{{#label}} must be a string',
      }),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided to update the item group.',
    }),
};

const deleteItemGroup = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
  params: Joi.object().keys({
    itemGroupId: Joi.string().custom(objectId),
  }),
};

const getItemGroupsDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
};

module.exports = {
  createItemGroup,
  getItemGroups,
  getItemGroup,
  updateItemGroup,
  deleteItemGroup,
  getItemGroupsDropdown,
};
