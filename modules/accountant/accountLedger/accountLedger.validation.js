const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');

const createAccountLedger = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    businessAccountLedgerMasterId: Joi.string().required(),

    gstinUin: Joi.string().optional().allow(null, '').trim().label('GSTIN/UIN').messages({
      'string.base': '{{#label}} must be a string',
    }),

    personName: Joi.string().trim().required().label('Ledger Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),

    pan: Joi.string().trim().label('PAN').messages({
      'string.base': '{{#label}} must be a string',
    }),

    phoneNo: Joi.string().trim().label('Phone Number').messages({
      'string.base': '{{#label}} must be a string',
    }),

    email: Joi.string().email().trim().label('Email').messages({
      'string.email': '{{#label}} must be a valid email address',
    }),

    address: Joi.string().trim().label('Address').messages({
      'string.base': '{{#label}} must be a string',
    }),

    country: Joi.string().trim().label('Country').messages({
      'string.base': '{{#label}} must be a string',
    }),

    city: Joi.string().trim().label('City').messages({
      'string.base': '{{#label}} must be a string',
    }),

    state: Joi.string().trim().label('State').messages({
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

const updateAccountLedger = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    ledgerId: commonSchemas.objectId({ label: 'Ledger ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    businessAccountLedgerMasterId: Joi.string().label('Business Account Ledger Master Id'),

    gstinUin: Joi.string().optional().allow(null, '').trim().label('GSTIN/UIN').messages({
      'string.base': '{{#label}} must be a string',
    }),

    personName: Joi.string().trim().required().label('Ledger Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),

    pan: Joi.string().trim().label('PAN').messages({
      'string.base': '{{#label}} must be a string',
    }),

    phoneNo: Joi.string().trim().label('Phone Number').messages({
      'string.base': '{{#label}} must be a string',
    }),

    email: Joi.string().email().trim().label('Email').messages({
      'string.email': '{{#label}} must be a valid email address',
    }),

    address: Joi.string().trim().label('Address').messages({
      'string.base': '{{#label}} must be a string',
    }),

    country: Joi.string().trim().label('Country').messages({
      'string.base': '{{#label}} must be a string',
    }),

    city: Joi.string().trim().label('City').messages({
      'string.base': '{{#label}} must be a string',
    }),

    state: Joi.string().trim().label('State').messages({
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

const deleteAccountLedger = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    ledgerId: commonSchemas.objectId({ label: 'Ledger ID', isRequired: true }),
  }),
};

const getAccountLedgerById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    ledgerId: commonSchemas.objectId({ label: 'Ledger ID', isRequired: true }),
  }),
};

const getAccountLedger = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
  }),
};

const getAccountLedgerDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

module.exports = {
  createAccountLedger,
  updateAccountLedger,
  deleteAccountLedger,
  getAccountLedger,
  getAccountLedgerById,
  getAccountLedgerDropdown,
};
