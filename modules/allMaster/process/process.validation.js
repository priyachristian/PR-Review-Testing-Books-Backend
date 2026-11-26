const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createProcess = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    processId: Joi.string().required(),
    name: Joi.string().required().label('Process Name').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const getProcesses = {
  query: Joi.object().keys({
    name: Joi.string(),
    companyId: Joi.string().custom(objectId),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
  }),
};

const getProcess = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    processId: Joi.string().custom(objectId),
  }),
};

const updateProcess = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    processId: Joi.string().required().custom(objectId).label('Process ID').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().label('Process Name').messages({
        'string.empty': '{{#label}} cannot be empty',
      }),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

const deleteProcess = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    processId: Joi.string().custom(objectId),
  }),
};

const getProcessesDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
};

module.exports = {
  createProcess,
  getProcesses,
  getProcess,
  updateProcess,
  deleteProcess,
  getProcessesDropdown,
};
