const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createTag = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    name: Joi.string().required().label('Tag Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    color: Joi.string().optional().allow('', null),
    tagId: Joi.string().allow('').label('Tag ID'),
  }),
};

const getTags = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    appName: Joi.string().allow('', null).optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
  }),
};

const getTagDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const updateTag = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    tagId: Joi.string().custom(objectId).required().label('Tag ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().required().label('Tag Name').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
      color: Joi.string().optional().allow('', null),
    })
    .min(1),
};

const deleteTag = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    tagId: Joi.string().custom(objectId).required(),
  }),
};

const getTagById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    tagId: Joi.string().custom(objectId).required(),
  }),
};

module.exports = {
  createTag,
  getTags,
  updateTag,
  deleteTag,
  getTagDropdown,
  getTagById,
};
