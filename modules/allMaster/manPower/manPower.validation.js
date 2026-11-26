const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');

const createManPower = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    workerNo: Joi.string().required().messages({
      'any.required': 'Worker number is required',
      'string.base': 'Worker number must be a string',
    }),
    workerName: Joi.string().required().messages({
      'any.required': 'Worker name is required',
      'string.base': 'Worker name must be a string',
    }),
    perHourSalary: Joi.number().required().messages({
      'any.required': 'Hourly salary is required',
      'number.base': 'Hourly salary must be a number',
    }),
    departmentName: Joi.string().trim().optional().allow('', null),
  }),
};

const getManPowerById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().messages({
      'any.required': 'Manpower ID is required',
      'string.base': 'Manpower ID must be a string',
    }),
  }),
};

const updateManPower = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().messages({
      'any.required': 'Manpower ID is required',
      'string.base': 'Manpower ID must be a string',
    }),
  }),
  body: Joi.object()
    .keys({
      workerNo: Joi.string().messages({
        'string.base': 'Worker number must be a string',
      }),
      workerName: Joi.string().messages({
        'string.base': 'Worker name must be a string',
      }),
      perHourSalary: Joi.number().messages({
        'number.base': 'Hourly salary must be a number',
      }),
      departmentName: Joi.string().trim().optional().allow('', null),
    })
    .min(1) // Ensure at least one field is provided
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

const deleteManPower = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().messages({
      'any.required': 'Manpower ID is required',
      'string.base': 'Manpower ID must be a string',
    }),
  }),
};

const getAllManPower = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
  }),
};

const getManPowerDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

module.exports = {
  createManPower,
  getManPowerById,
  updateManPower,
  deleteManPower,
  getAllManPower,
  getManPowerDropdown,
};
