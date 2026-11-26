const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');

const createInventoryTransferRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      itemId: Joi.string().custom(objectId).required().label('Item ID'),
      fromWarehouseId: Joi.string().custom(objectId).required().label('From Warehouse'),
      toWarehouseId: Joi.string().custom(objectId).required().label('To Warehouse'),
      itemUnitId: Joi.string().custom(objectId).optional().allow(null).label('Item Unit ID'),
      quantity: Joi.number().positive().required().label('Quantity'),
      batchNumber: Joi.string().optional().label('Batch Number'),
      notes: Joi.string().allow('').optional().label('Transfer Notes'),
      referenceNumber: Joi.string().optional().label('Reference Number'),
      date: commonSchemas.date({ label: 'Date', isRequired: true }).allow(null),
    })
    .custom((value, helpers) => {
      if (value.fromWarehouseId && value.toWarehouseId && value.fromWarehouseId === value.toWarehouseId) {
        return helpers.error('any.invalid');
      }
      return value;
    })
    .messages({ 'any.invalid': 'Source and destination warehouse must be different' }),
};

const getInventoryTransferRequests = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean().optional(),
    search: Joi.string(),
    status: Joi.string(),
    warehouseId: Joi.string().custom(objectId).optional().allow(null),
    divisionId: commonSchemas.objectId({ label: 'Division ID', isRequired: false }),
    branchId: Joi.string(),
    startDate: Joi.string().optional(),
    endDate: Joi.string().optional(),
    isProductionOrderReq: Joi.boolean().optional(),
  }),
};

const getInventoryTransfer = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    transferId: commonSchemas.objectId({ label: 'Transfer ID', isRequired: true }),
  }),
};

const approveInventoryTransfer = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    transferId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    manPower_inventoryTransfer: Joi.array().items(Joi.string().custom(objectId)).optional(),
  }),
};

const rejectInventoryTransfer = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    transferId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    manPower_inventoryTransfer: Joi.array().items(Joi.string().custom(objectId)).optional(),
  }),
};

module.exports = {
  createInventoryTransferRequest,
  getInventoryTransferRequests,
  getInventoryTransfer,
  approveInventoryTransfer,
  rejectInventoryTransfer,
};
