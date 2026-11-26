const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createModule = {
  body: Joi.object().keys({
    name: Joi.string().required().label('Module Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    description: Joi.string().required().label('Description').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    path: Joi.string().label('Path').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    icon: Joi.string().label('Icon').messages({
      'string.base': '{{#label}} must be a string',
    }),
    parentModule: Joi.string().custom(objectId).optional().label('Parent Module').messages({
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
    sequence: Joi.number().integer().label('Sequence').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
    }),
    isActive: Joi.boolean().label('Is Active').messages({
      'any.required': '{{#label}} is required',
      'boolean.base': '{{#label}} must be a boolean',
    }),
  }),
};

const getModules = {
  query: Joi.object().keys({
    name: Joi.string(),
    description: Joi.string(),
    path: Joi.string(),
    parentModule: Joi.string().custom(objectId),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getModule = {
  params: Joi.object().keys({
    moduleId: Joi.string().custom(objectId),
  }),
};

const updateModule = {
  params: Joi.object().keys({
    moduleId: Joi.string().custom(objectId).label('Module ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId string',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().label('Module Name').messages({
        'string.base': '{{#label}} must be a string',
      }),
      description: Joi.string().label('Description').messages({
        'string.base': '{{#label}} must be a string',
      }),
      path: Joi.string().label('Path').messages({
        'string.base': '{{#label}} must be a string',
      }),
      icon: Joi.string().label('Icon').messages({
        'string.base': '{{#label}} must be a string',
      }),
      parentModule: Joi.string().custom(objectId).label('Parent Module').messages({
        'string.base': '{{#label}} must be a valid ObjectId string',
      }),
    })
    .min(1),
};

const deleteModule = {
  params: Joi.object().keys({
    moduleId: Joi.string().custom(objectId),
  }),
};

const getModuleTree = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

module.exports = {
  createModule,
  getModules,
  getModule,
  updateModule,
  deleteModule,
  getModuleTree,
};
