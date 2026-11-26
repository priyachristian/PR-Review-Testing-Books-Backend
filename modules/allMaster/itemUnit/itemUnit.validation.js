const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const companyQuery = Joi.object().keys({
  companyId: Joi.string().required().custom(objectId),
});

const itemUnitIdParams = Joi.object().keys({
  itemUnitId: Joi.string().custom(objectId).required().label('Item Unit ID').messages({
    'any.required': '{{#label}} is required',
    'string.base': '{{#label}} must be a valid ObjectId',
  }),
});

const nameSchema = Joi.string().trim().required().label('Unit Name').messages({
  'any.required': '{{#label}} is required',
  'string.base': '{{#label}} must be a string',
  'string.empty': '{{#label}} is required',
});

const createItemUnit = {
  query: companyQuery,
  body: Joi.object().keys({
    name: nameSchema,
    isActive: Joi.boolean().optional(),
  }),
};

const getItemUnits = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    search: Joi.string().allow('', null),
    isActive: Joi.boolean(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getItemUnitsDropdown = {
  query: companyQuery,
};

const getItemUnitById = {
  query: companyQuery,
  params: itemUnitIdParams,
};

const updateItemUnit = {
  query: companyQuery,
  params: itemUnitIdParams,
  body: Joi.object()
    .keys({
      name: nameSchema,
    })
    .min(1),
};

const updateItemUnitStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isActive: Joi.boolean().required(),
  }),
  params: itemUnitIdParams,
};

const deleteItemUnit = {
  query: companyQuery,
  params: itemUnitIdParams,
};

module.exports = {
  createItemUnit,
  getItemUnits,
  getItemUnitsDropdown,
  getItemUnitById,
  updateItemUnit,
  updateItemUnitStatus,
  deleteItemUnit,
};
