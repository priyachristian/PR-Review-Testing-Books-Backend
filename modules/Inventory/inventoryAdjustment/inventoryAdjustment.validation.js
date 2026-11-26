const Joi = require('joi');
const { STOCK_UPDATE_REASONS } = require('../../../utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

const createInventoryAdjustment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    divisionId: commonSchemas.objectId({ label: 'Division ID', isRequired: true }),
    branchId: commonSchemas.objectId({ label: 'Branch ID', isRequired: true }),
    warehouseId: commonSchemas.objectId({ label: 'Warehouse ID', isRequired: true }),
    inventoryAdjustmentNumber: commonSchemas.string({ label: 'Inventory Adjustment Number', isRequired: true }),
    referenceNumber: commonSchemas.string({ label: 'Reference Number', isOptional: true }),
    adjustmentDate: commonSchemas.date({ label: 'Adjustment Date', isRequired: true }),
    reason: Joi.string()
      .valid(...Object.values(STOCK_UPDATE_REASONS))
      .required()
      .label('Reason')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
        'any.required': '{{#label}} is required',
      }),
    accountId: commonSchemas.objectId({ label: 'Adjustment Account', isRequired: true }),
    description: commonSchemas.string({ label: 'Description', isOptional: true }),
    items: Joi.array()
      .items(
        Joi.object({
          itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
          itemUnitId: Joi.string().custom(objectId).optional().allow(null).label('Item Unit ID'),
          currentStock: commonSchemas.number({ label: 'Current Stock', isRequired: true }).min(0),
          updatedStock: commonSchemas.number({ label: 'Updated Stock', isRequired: true }).min(0),
          adjustedStock: commonSchemas.number({ label: 'Adjusted Stock', isRequired: true }),
          purchasePrice: Joi.number()
            .min(0)
            .label('Purchase Price')
            .when('adjustedStock', {
              is: Joi.number().greater(0),
              then: Joi.number().greater(0).required(),
              otherwise: Joi.number().min(0).optional().allow(null),
            }),
        }),
      )
      .min(1)
      .required()
      .label('Items')
      .messages({
        'array.base': '{{#label}} must be an array',
        'array.min': '{{#label}} must contain at least one item',
        'any.required': '{{#label}} is required',
      }),
  }),
};

const getInventoryAdjustments = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    divisionId: commonSchemas.objectId({ label: 'Division ID', isOptional: true }),
    branchId: Joi.string().optional(),
    warehouseId: Joi.string().optional(),
    status: Joi.string(),
    reason: Joi.string()
      .valid(...Object.values(STOCK_UPDATE_REASONS))
      .label('Reason'),
    referenceNumber: commonSchemas.string({ label: 'Reference Number', isOptional: true }),
    accountId: commonSchemas.objectId({ label: 'Adjustment Account', isRequired: false }),
    ...commonSchemas.dateRangeQuery(),
    ...commonSchemas.paginationQuery(),
    search: Joi.string().allow(''),
  }),
};

const getInventoryAdjustment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    adjustmentId: commonSchemas.objectId({ label: 'Adjustment ID', isRequired: true }),
  }),
};

const approveInventoryAdjustment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    adjustmentId: commonSchemas.objectId({ label: 'Adjustment ID', isRequired: true }),
  }),
};

const rejectInventoryAdjustment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    adjustmentId: commonSchemas.objectId({ label: 'Adjustment ID', isRequired: true }),
  }),
};

const updateInventoryAdjustment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    adjustmentId: commonSchemas.objectId({ label: 'Adjustment ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      divisionId: commonSchemas.objectId({ label: 'Division ID', isOptional: true }),
      branchId: commonSchemas.objectId({ label: 'Branch ID', isOptional: true }),
      warehouseId: commonSchemas.objectId({ label: 'Warehouse ID', isOptional: true }),
      inventoryAdjustmentNumber: commonSchemas.string({ label: 'Inventory Adjustment Number', isRequired: true }),
      referenceNumber: commonSchemas.string({ label: 'Reference Number', isOptional: true }),
      adjustmentDate: commonSchemas.date({ label: 'Adjustment Date', isOptional: true }),
      reason: Joi.string()
        .valid(...Object.values(STOCK_UPDATE_REASONS))
        .label('Reason')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        })
        .optional(),
      accountId: commonSchemas.objectId({ label: 'Adjustment Account', isOptional: true }),
      description: commonSchemas.string({ label: 'Description', isOptional: true }),
      items: Joi.array()
        .items(
          Joi.object({
            itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
            itemUnitId: Joi.string().custom(objectId).optional().allow(null).label('Item Unit ID'),
            currentStock: commonSchemas.number({ label: 'Current Stock', isRequired: true }).min(0),
            updatedStock: commonSchemas.number({ label: 'Updated Stock', isRequired: true }).min(0),
            adjustedStock: commonSchemas.number({ label: 'Adjusted Stock', isRequired: true }),
            purchasePrice: Joi.number()
              .min(0)
              .label('Purchase Price')
              .when('adjustedStock', {
                is: Joi.number().greater(0),
                then: Joi.number().greater(0).required(),
                otherwise: Joi.number().min(0).optional().allow(null),
              }),
          }),
        )
        .min(1)
        .label('Items')
        .messages({
          'array.base': '{{#label}} must be an array',
          'array.min': '{{#label}} must contain at least one item',
        })
        .optional(),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided for updating the adjustment',
    }),
};

module.exports = {
  createInventoryAdjustment,
  getInventoryAdjustments,
  getInventoryAdjustment,
  approveInventoryAdjustment,
  rejectInventoryAdjustment,
  updateInventoryAdjustment,
};
