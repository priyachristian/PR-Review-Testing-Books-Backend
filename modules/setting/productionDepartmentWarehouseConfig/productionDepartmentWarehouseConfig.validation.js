const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createProductionDepartmentWarehouseConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
  }),
  body: Joi.object().keys({
    departmentName: Joi.string().required().trim().label('Department Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    rawMaterialWarehouseId: Joi.string().custom(objectId).optional().allow(null, '').label('Raw Material Warehouse'),
    productionWarehouseId: Joi.string().custom(objectId).optional().allow(null, '').label('Production Warehouse'),
    finishedGoodsWarehouseId: Joi.string().custom(objectId).optional().allow(null, '').label('Finished Goods Warehouse'),
    isActive: Joi.boolean().optional(),
  }),
};

const getProductionDepartmentWarehouseConfigs = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
    search: Joi.string().trim(),
  }),
};

const getProductionDepartmentWarehouseDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
  }),
};

const getProductionDepartmentWarehouseConfigById = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Production Department Warehouse Configuration ID'),
  }),
};

const updateProductionDepartmentWarehouseConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Production Department Warehouse Configuration ID'),
  }),
  body: Joi.object()
    .keys({
      departmentName: Joi.string().trim().label('Department Name'),
      rawMaterialWarehouseId: Joi.string().custom(objectId).optional().allow(null, '').label('Raw Material Warehouse'),
      productionWarehouseId: Joi.string().custom(objectId).optional().allow(null, '').label('Production Warehouse'),
      finishedGoodsWarehouseId: Joi.string().custom(objectId).optional().allow(null, '').label('Finished Goods Warehouse'),
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

const updateProductionDepartmentWarehouseConfigStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Production Department Warehouse Configuration ID'),
  }),
  body: Joi.object().keys({
    isActive: Joi.boolean().required().label('Status').messages({
      'any.required': '{{#label}} is required',
      'boolean.base': '{{#label}} must be a boolean',
    }),
  }),
};

const deleteProductionDepartmentWarehouseConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Production Department Warehouse Configuration ID'),
  }),
};

module.exports = {
  createProductionDepartmentWarehouseConfig,
  getProductionDepartmentWarehouseConfigs,
  getProductionDepartmentWarehouseConfigById,
  updateProductionDepartmentWarehouseConfig,
  updateProductionDepartmentWarehouseConfigStatus,
  deleteProductionDepartmentWarehouseConfig,
  getProductionDepartmentWarehouseDropdown,
};
