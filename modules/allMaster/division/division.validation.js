const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createDivision = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    name: Joi.string().required().label('Division Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    address: Joi.object().keys({
      street1: Joi.string().allow('').label('Street 1').messages({
        'string.base': '{{#label}} must be a string',
      }),
      street2: Joi.string().allow('').label('Street 2').messages({
        'string.base': '{{#label}} must be a string',
      }),
      country: Joi.string().allow(null, '').label('Country').messages({
        'string.base': '{{#label}} must be a string',
      }),
      city: Joi.string().allow(null, '').label('City').messages({
        'string.base': '{{#label}} must be a string',
      }),
      state: Joi.string().allow(null, '').label('State').messages({
        'string.base': '{{#label}} must be a string',
      }),
      pinCode: Joi.string()
        .pattern(/^[0-9]{5,6}$/)
        .allow('')
        .label('Pin Code')
        .messages({
          'string.pattern.base': '{{#label}} must be a valid pin code (5 or 6 digits)',
        }),
      phone: Joi.string()
        .pattern(/^[0-9]{10}$/)
        .allow('')
        .label('Phone Number')
        .messages({
          'string.pattern.base': '{{#label}} must be a valid phone number (10 digits)',
        }),
    }),
    contactEmail: Joi.string().email().allow('').label('Contact Email').messages({
      'string.email': '{{#label}} must be a valid email',
    }),
    contactPhone: Joi.string()
      .pattern(/^[0-9]{10}$/)
      .allow('')
      .label('Contact Phone')
      .messages({
        'string.pattern.base': '{{#label}} must be a valid contact phone number (10 digits)',
      }),
  }),
};

const getDivisions = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    isActive: Joi.boolean(),
    status: Joi.string(),
  }),
};

const getDivisionDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const updateDivision = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    divisionId: Joi.string().custom(objectId).required().label('Division ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().required().label('Division Name').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
      address: Joi.object().keys({
        street1: Joi.string().allow('').label('Street 1').messages({
          'string.base': '{{#label}} must be a string',
        }),
        street2: Joi.string().allow('').label('Street 2').messages({
          'string.base': '{{#label}} must be a string',
        }),
        country: Joi.string().allow('').label('Country').messages({
          'string.base': '{{#label}} must be a string',
        }),
        city: Joi.string().allow('').label('City').messages({
          'string.base': '{{#label}} must be a string',
        }),
        state: Joi.string().allow(null, '').label('State').messages({
          'string.base': '{{#label}} must be a string',
        }),
        pinCode: Joi.string()
          .pattern(/^[0-9]{5,6}$/)
          .allow('')
          .label('Pin Code')
          .messages({
            'string.pattern.base': '{{#label}} must be a valid pin code (5 or 6 digits)',
          }),
        phone: Joi.string()
          .pattern(/^[0-9]{10}$/)
          .allow('')
          .label('Phone Number')
          .messages({
            'string.pattern.base': '{{#label}} must be a valid phone number (10 digits)',
          }),
      }),
      contactEmail: Joi.string().email().allow('').label('Contact Email').messages({
        'string.email': '{{#label}} must be a valid email',
      }),
      contactPhone: Joi.string()
        .pattern(/^[0-9]{10}$/)
        .allow('')
        .label('Contact Phone')
        .messages({
          'string.pattern.base': '{{#label}} must be a valid contact phone number (10 digits)',
        }),
    })
    .min(1),
};

const deleteDivision = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    divisionId: Joi.string().custom(objectId).required(),
  }),
};

const getDivisonById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    divisionId: Joi.string().custom(objectId).required(),
  }),
};

const updateStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    isActive: Joi.boolean().required().label('Is Active').messages({
      'any.required': '{{#label}} is required',
      'boolean.base': '{{#label}} must be a boolean',
    }),
  }),
  params: Joi.object().keys({
    divisionId: Joi.string().custom(objectId).required().label('Division ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

module.exports = {
  createDivision,
  getDivisions,
  updateDivision,
  deleteDivision,
  getDivisionDropdown,
  getDivisonById,
  updateStatus,
};
