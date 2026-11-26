const Joi = require('joi');
const { objectId } = require('../../validations/custom.validation');

const getCountries = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getStates = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    countryId: Joi.string().required().custom(objectId).label('Country ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getCities = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    stateId: Joi.string().required().custom(objectId).label('State ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

module.exports = {
  getCountries,
  getStates,
  getCities,
};
