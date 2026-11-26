const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');
const { DATA_SETUP_KEYS } = require('./dataSetup.service');

const getOnboardingStatus = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company', isRequired: true }),
  }),
};

const getDataSetupStatus = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company', isRequired: true }),
  }),
};

const getDataSetupPreview = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company', isRequired: true }),
    key: Joi.string()
      .valid(...Object.values(DATA_SETUP_KEYS))
      .required()
      .label('Step')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
        'any.required': '{{#label}} is required',
      }),
  }),
};

const runDataSetup = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company', isRequired: true }),
  }),
  body: Joi.object().keys({
    key: Joi.string()
      .valid(...Object.values(DATA_SETUP_KEYS))
      .required()
      .label('Step')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
        'any.required': '{{#label}} is required',
      }),
    params: Joi.object()
      .keys({
        divisionId: commonSchemas.objectId({ label: 'Division', isOptional: true }),
        branchId: commonSchemas.objectId({ label: 'Branch', isOptional: true }),
        warehouseId: commonSchemas.objectId({ label: 'Warehouse', isOptional: true }),
        quoteIds: Joi.array().items(Joi.string().custom(objectId).label('Quote ID')).optional(),
        soIds: Joi.array().items(Joi.string().custom(objectId).label('Sales Order ID')).optional(),
      })
      .optional(),
  }),
};

module.exports = {
  getOnboardingStatus,
  getDataSetupStatus,
  getDataSetupPreview,
  runDataSetup,
};
