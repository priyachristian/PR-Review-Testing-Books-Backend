const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createCurrency = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    code: Joi.string().trim().uppercase().max(5).required().label('Currency Code').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} must be at most {{#limit}} characters',
    }),
    symbol: Joi.string().trim().max(5).required().label('Currency Symbol').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} must be at most {{#limit}} characters',
    }),
    name: Joi.string().trim().required().label('Currency Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    decimalPlaces: Joi.number().integer().min(0).max(4).optional().label('Decimal Places').messages({
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'number.min': '{{#label}} cannot be less than {{#limit}}',
      'number.max': '{{#label}} cannot be more than {{#limit}}',
    }),
    format: Joi.string().trim().optional().label('Format').messages({
      'string.base': '{{#label}} must be a string',
    }),
    exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate').messages({
      'number.base': '{{#label}} must be a number',
      'number.min': '{{#label}} cannot be negative',
    }),
  }),
};

const getCurrencies = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string().allow('', null),
  }),
};

const updateCurrency = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    currencyId: Joi.string().custom(objectId).required().label('Currency ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object()
    .keys({
      code: Joi.string().trim().uppercase().max(5).required().label('Currency Code').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
        'string.max': '{{#label}} must be at most {{#limit}} characters',
      }),
      symbol: Joi.string().trim().max(5).required().label('Currency Symbol').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
        'string.max': '{{#label}} must be at most {{#limit}} characters',
      }),
      name: Joi.string().trim().required().label('Currency Name').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
      decimalPlaces: Joi.number().integer().min(0).max(4).optional().label('Decimal Places').messages({
        'number.base': '{{#label}} must be a number',
        'number.integer': '{{#label}} must be an integer',
        'number.min': '{{#label}} cannot be less than {{#limit}}',
        'number.max': '{{#label}} cannot be more than {{#limit}}',
      }),
      format: Joi.string().trim().optional().label('Format').messages({
        'string.base': '{{#label}} must be a string',
      }),
      exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate').messages({
        'number.base': '{{#label}} must be a number',
        'number.min': '{{#label}} cannot be negative',
      }),
    })
    .min(1),
};

const deleteCurrency = {
  params: Joi.object().keys({
    currencyId: Joi.string().custom(objectId).required().label('Currency ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

module.exports = {
  createCurrency,
  getCurrencies,
  updateCurrency,
  deleteCurrency,
};
