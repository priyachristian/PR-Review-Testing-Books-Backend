const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const warehouseAddress = Joi.object()
  .keys({
    street1: Joi.string().trim().allow('').label('Street 1'),
    street2: Joi.string().trim().allow('').label('Street 2'),
    country: Joi.string().trim().allow('').label('Country'),
    city: Joi.string().trim().allow('').label('City'),
    state: Joi.string().trim().allow('').label('State'),
    pinCode: Joi.string()
      .trim()
      .pattern(/^[0-9]{6}$/)
      .allow('')
      .label('Pin Code')
      .messages({ 'string.pattern.base': '{{#label}} must be a 6-digit pin code' }),
  })
  .label('Address');

const createWarehouse = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    divisionId: Joi.string().required().custom(objectId),
    branchId: Joi.string().required().custom(objectId),
    name: Joi.string().trim().label('Warehouse Name').messages({
      'string.empty': '{{#label}} cannot be empty',
    }),
    address: warehouseAddress.optional(),
  }),
};

const updateWarehouse = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    warehouseId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      branchId: Joi.string().optional().custom(objectId),
      name: Joi.string().optional().trim().label('Warehouse Name'),
      address: warehouseAddress.optional(),
    })
    .min(1),
};

const deleteWarehouse = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    warehouseId: Joi.string().custom(objectId).required(),
  }),
};

const getWarehouse = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
    isActive: Joi.boolean(),
    status: Joi.string(),
    divisionId: Joi.string().custom(objectId),
    branchId: Joi.string().custom(objectId),
  }),
};

const getWarehousesDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    branchId: Joi.string().custom(objectId).optional(),
    isSplit: Joi.boolean().optional().allow(null),
    // Settings/rejection-config screen passes true to see the reuse/return/scrap warehouses;
    // every other document leaves it off so those reserved warehouses stay hidden.
    includeRejectionWarehouses: Joi.boolean().optional(),
  }),
};

const warehouseById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    warehouseId: Joi.string().custom(objectId).required(),
  }),
};

const updateStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isActive: Joi.boolean().required(),
  }),
  params: Joi.object().keys({
    warehouseId: Joi.string().custom(objectId).required(),
  }),
};

module.exports = {
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  getWarehouse,
  getWarehousesDropdown,
  warehouseById,
  updateStatus,
};
