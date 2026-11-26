const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createPaymentTerm = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    name: Joi.string().trim().required().label('Payment Term Name').messages({
      'any.required': '{{#label}} is required',
      'string.empty': '{{#label}} cannot be empty',
    }),
    days: Joi.number().integer().min(0).required().label('Days').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.min': '{{#label}} cannot be negative',
    }),
  }),
};

const getPaymentTerms = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    name: Joi.string().trim().allow('', null),
    isActive: Joi.boolean(),
    isDefault: Joi.boolean(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getPaymentTermsDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getPaymentTermById = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    paymentTermId: Joi.string().custom(objectId).required().label('Payment Term ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const updatePaymentTerm = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    paymentTermId: Joi.string().custom(objectId).required().label('Payment Term ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().label('Payment Term Name').messages({
        'string.empty': '{{#label}} cannot be empty',
      }),
      days: Joi.number().integer().min(0).label('Days').messages({
        'number.base': '{{#label}} must be a number',
        'number.min': '{{#label}} cannot be negative',
      }),
    })
    .min(1),
};

const updateStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    isActive: Joi.boolean().required().label('Is Active').messages({
      'any.required': '{{#label}} is required',
    }),
  }),
  params: Joi.object().keys({
    paymentTermId: Joi.string().custom(objectId).required().label('Payment Term ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const setDefaultPaymentTerm = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    paymentTermId: Joi.string().custom(objectId).required().label('Payment Term ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const deletePaymentTerm = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    paymentTermId: Joi.string().custom(objectId).required().label('Payment Term ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

module.exports = {
  createPaymentTerm,
  getPaymentTerms,
  getPaymentTermsDropdown,
  getPaymentTermById,
  updatePaymentTerm,
  updateStatus,
  setDefaultPaymentTerm,
  deletePaymentTerm,
};
