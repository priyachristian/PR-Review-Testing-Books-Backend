const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');

const getInventoryLogs = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    branchId: Joi.string(),
    createdAt: Joi.date(),
    divisionId: commonSchemas.objectId({ label: 'Division ID', isRequired: false }),
    warehouseId: Joi.string().custom(objectId).label('Warehouse ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    itemId: Joi.string().custom(objectId).label('Item ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getInventoryLogById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    inventoryLogId: Joi.string().required().custom(objectId).label('Inventory Log ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

module.exports = {
  getInventoryLogs,
  getInventoryLogById,
};
