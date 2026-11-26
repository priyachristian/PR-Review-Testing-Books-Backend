const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { MAINTENANCE_PURCHASE_STAGE } = require('@smit9313/abss-models-core/src/utils/enum');

const idSchema = label =>
  Joi.string()
    .custom(objectId)
    .label(label)
    .messages({ 'string.base': '{{#label}} must be a valid ID', 'any.required': '{{#label}} is required' });

const numberMessages = {
  'number.base': '{{#label}} must be a number',
  'number.min': '{{#label}} cannot be negative',
  'number.greater': '{{#label}} must be greater than 0',
  'any.required': '{{#label}} is required',
};

const createMaintenancePurchase = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  body: Joi.object().keys({
    vendor: Joi.string().trim().required().label('Vendor').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} is required',
      'any.required': '{{#label}} is required',
    }),
    linkedMrId: idSchema('Linked maintenance request').allow(null),
    partRequestId: idSchema('Part request').allow(null),
    expectedDelivery: Joi.date().allow(null).label('Expected delivery'),
    items: Joi.array()
      .items(
        Joi.object().keys({
          sparePartId: idSchema('Spare part').required(),
          requestedQty: Joi.number()
            .greater(0)
            .required()
            .label('Quantity')
            .messages({ ...numberMessages }),
          rate: Joi.number()
            .min(0)
            .required()
            .label('Rate')
            .messages({ ...numberMessages }),
        }),
      )
      .min(1)
      .required()
      .label('Items')
      .messages({
        'array.min': 'At least one item is required',
        'any.required': '{{#label}} is required',
      }),
  }),
};

const approveMaintenancePurchase = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: idSchema('Purchase request ID').required(),
  }),
  body: Joi.object().keys({
    items: Joi.array()
      .items(
        Joi.object().keys({
          sparePartId: idSchema('Spare part').required(),
          approvedQty: Joi.number()
            .min(0)
            .required()
            .label('Approved quantity')
            .messages({ ...numberMessages }),
        }),
      )
      .min(1)
      .required()
      .label('Items')
      .messages({
        'array.min': 'At least one item is required',
        'any.required': '{{#label}} is required',
      }),
  }),
};

const raisePurchaseOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: idSchema('Purchase request ID').required(),
  }),
  body: Joi.object().keys({
    vendor: Joi.string().trim().required().label('Vendor').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} is required',
      'any.required': '{{#label}} is required',
    }),
    expectedDelivery: Joi.date().required().label('Expected delivery').messages({
      'date.base': '{{#label}} must be a valid date',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const receiveMaintenancePurchase = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: idSchema('Purchase request ID').required(),
  }),
  body: Joi.object().keys({
    items: Joi.array()
      .items(
        Joi.object().keys({
          sparePartId: idSchema('Spare part').required(),
          receivedQty: Joi.number()
            .min(0)
            .required()
            .label('Received quantity')
            .messages({ ...numberMessages }),
        }),
      )
      .min(1)
      .required()
      .label('Items')
      .messages({
        'array.min': 'At least one item is required',
        'any.required': '{{#label}} is required',
      }),
  }),
};

const STAGES = Object.values(MAINTENANCE_PURCHASE_STAGE);

const getAllMaintenancePurchases = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
    sortBy: Joi.string(),
    limit: Joi.number().integer().min(1),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
    search: Joi.string().trim().allow(''),
    stage: Joi.string()
      .valid(...STAGES)
      .label('Stage')
      .messages({ 'any.only': `{{#label}} must be one of: ${STAGES.join(', ')}` }),
    linkedMrId: idSchema('Linked maintenance request'),
    raisedBy: idSchema('Raised by'),
    fromDate: Joi.date().label('From date'),
    toDate: Joi.date().min(Joi.ref('fromDate')).label('To date').messages({
      'date.min': 'To date cannot be earlier than from date',
    }),
  }),
};

const getMaintenancePurchaseDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
    search: Joi.string().trim().allow(''),
    stage: Joi.string()
      .valid(...STAGES)
      .label('Stage')
      .messages({ 'any.only': `{{#label}} must be one of: ${STAGES.join(', ')}` }),
    linkedMrId: idSchema('Linked maintenance request'),
  }),
};

const getMaintenancePurchaseById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: idSchema('Purchase request ID').required(),
  }),
};

module.exports = {
  getMaintenancePurchaseDropdown,
  getAllMaintenancePurchases,
  getMaintenancePurchaseById,
  createMaintenancePurchase,
  receiveMaintenancePurchase,
  raisePurchaseOrder,
  approveMaintenancePurchase,
};
