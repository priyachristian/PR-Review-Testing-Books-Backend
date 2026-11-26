const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');

const createRejectionReason = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    name: Joi.string().required().trim().messages({
      'any.required': 'Reason name is required',
      'string.base': 'Reason name must be a string',
    }),
    description: Joi.string().trim().allow('').optional(),
    parentReasonId: Joi.string().custom(objectId).allow(null, '').optional(),
    isActive: Joi.boolean().optional(),
  }),
};

const getRejectionReasons = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    parentReasonId: Joi.string(),
    isActive: Joi.boolean(),
  }),
};

const getRejectionReasonById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().messages({
      'any.required': 'Rejection reason ID is required',
    }),
  }),
};

const updateRejectionReason = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().messages({
      'any.required': 'Rejection reason ID is required',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim(),
      description: Joi.string().trim().allow(''),
      parentReasonId: Joi.string().custom(objectId).allow(null, ''),
      isActive: Joi.boolean(),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

const deleteRejectionReason = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().messages({
      'any.required': 'Rejection reason ID is required',
    }),
  }),
};

module.exports = {
  createRejectionReason,
  getRejectionReasons,
  getRejectionReasonById,
  updateRejectionReason,
  deleteRejectionReason,
};
