const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { SPARE_STOCK_TRANSACTION_TYPE, SPARE_STOCK_REFERENCE_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');

const createAdjustment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  body: Joi.object().keys({
    sparePartId: Joi.string().required().custom(objectId).label('Spare part').messages({
      'string.base': '{{#label}} must be a valid ID',
      'any.required': '{{#label}} is required',
    }),
    // Positive adds stock, negative removes it.
    qty: Joi.number().invalid(0).required().label('Quantity').messages({
      'number.base': '{{#label}} must be a number',
      'any.invalid': '{{#label}} cannot be 0',
      'any.required': '{{#label}} is required',
    }),
    date: Joi.date().label('Date').messages({ 'date.base': '{{#label}} must be a valid date' }),
    remarks: Joi.string().trim().required().label('Remarks').messages({
      'string.empty': '{{#label}} is required',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const TRANSACTION_TYPES = Object.values(SPARE_STOCK_TRANSACTION_TYPE);
const REFERENCE_TYPES = Object.values(SPARE_STOCK_REFERENCE_TYPE);

const getAllSpareStockLedgers = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer().min(1),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
    search: Joi.string().trim().allow(''),
    sparePartId: Joi.string().custom(objectId).label('Spare part').messages({ 'string.base': '{{#label}} must be a valid ID' }),
    transactionType: Joi.string()
      .valid(...TRANSACTION_TYPES)
      .label('Transaction type')
      .messages({ 'any.only': `{{#label}} must be one of: ${TRANSACTION_TYPES.join(', ')}` }),
    referenceType: Joi.string()
      .valid(...REFERENCE_TYPES)
      .label('Reference type')
      .messages({ 'any.only': `{{#label}} must be one of: ${REFERENCE_TYPES.join(', ')}` }),
    referenceId: Joi.string().custom(objectId).label('Reference').messages({ 'string.base': '{{#label}} must be a valid ID' }),
    fromDate: Joi.date().label('From date'),
    toDate: Joi.date().min(Joi.ref('fromDate')).label('To date').messages({
      'date.min': 'To date cannot be earlier than from date',
    }),
  }),
};

module.exports = {
  getAllSpareStockLedgers,
  createAdjustment,
};
