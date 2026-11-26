const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { MACHINE_PM_TASK_TYPES, MACHINE_CRITICALITY } = require('@smit9313/abss-models-core/src/utils/enum');

const PM_TASK_TYPES = Object.values(MACHINE_PM_TASK_TYPES);
const CRITICALITY_LEVELS = Object.values(MACHINE_CRITICALITY);

const stringMessages = {
  'string.base': '{{#label}} must be a string',
  'string.empty': '{{#label}} cannot be empty',
  'any.required': '{{#label}} is required',
};

const numberMessages = {
  'number.base': '{{#label}} must be a number',
  'number.integer': '{{#label}} must be a whole number',
  'number.min': '{{#label}} must be greater than or equal to {{#limit}}',
  'any.required': '{{#label}} is required',
};

const booleanMessages = {
  'boolean.base': '{{#label}} must be a boolean',
  'any.required': '{{#label}} is required',
};

const dateMessages = {
  'date.base': '{{#label}} must be a valid date',
  'date.min': '{{#label}} cannot be earlier than the last PM date',
  'any.required': '{{#label}} is required',
};

const requiredString = label =>
  Joi.string()
    .trim()
    .required()
    .label(label)
    .messages({ ...stringMessages });

const optionalString = label =>
  Joi.string()
    .trim()
    .allow('', null)
    .label(label)
    .messages({ ...stringMessages });

const companyIdQuery = Joi.string().required().custom(objectId).label('Company ID');

const machineIdParams = Joi.object().keys({
  id: Joi.string().custom(objectId).required().label('Machine ID').messages({
    'string.base': '{{#label}} must be a string',
    'any.required': '{{#label}} is required',
  }),
});

const pmTaskSchema = Joi.object().keys({
  taskType: Joi.string()
    .valid(...PM_TASK_TYPES)
    .required()
    .label('PM task type')
    .messages({
      'string.base': '{{#label}} must be a string',
      'any.only': `{{#label}} must be one of: ${PM_TASK_TYPES.join(', ')}`,
      'any.required': '{{#label}} is required',
    }),
  description: optionalString('PM task description'),
  isRequired: Joi.boolean()
    .label('PM task required flag')
    .messages({ ...booleanMessages }),
});

const wearPartSchema = Joi.object().keys({
  sparePartId: Joi.string().custom(objectId).required().label('Spare part').messages({
    'string.base': '{{#label}} must be a valid ID',
    'any.required': '{{#label}} is required',
  }),
  avgLifeHours: Joi.number()
    .min(0)
    .allow(null)
    .label('Average life hours')
    .messages({ ...numberMessages }),
  uom: optionalString('Wear part unit of measure'),
});

const machineFields = {
  process: optionalString('Process'),
  criticality: Joi.string()
    .valid(...CRITICALITY_LEVELS)
    .label('Criticality')
    .messages({
      'string.base': '{{#label}} must be a string',
      'any.only': `{{#label}} must be one of: ${CRITICALITY_LEVELS.join(', ')}`,
    }),
  hasAMC: Joi.boolean()
    .label('Has AMC')
    .messages({ ...booleanMessages }),
  pmFrequencyDays: Joi.number()
    .integer()
    .min(1)
    .allow(null)
    .label('PM frequency (days)')
    .messages({ ...numberMessages }),
  lastPMDate: Joi.date()
    .allow(null)
    .label('Last PM date')
    .messages({ ...dateMessages }),
  nextPMDueDate: Joi.date()
    .allow(null)
    .when('lastPMDate', {
      is: Joi.date().required(),
      then: Joi.date().min(Joi.ref('lastPMDate')),
    })
    .label('Next PM due date')
    .messages({ ...dateMessages }),
  pmTasks: Joi.array().items(pmTaskSchema).unique('taskType').label('PM tasks').messages({
    'array.base': '{{#label}} must be an array',
    'array.unique': 'Each PM task type can be added only once',
  }),
  wearParts: Joi.array().items(wearPartSchema).unique('sparePartId').label('Wear parts').messages({
    'array.base': '{{#label}} must be an array',
    'array.unique': 'Each spare part can be added only once',
  }),
};

const createMachine = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  body: Joi.object().keys({
    machineName: requiredString('Machine name'),
    location: requiredString('Location'),
    ...machineFields,
  }),
};

const getAllMachines = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer().min(1),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
    search: Joi.string().trim().allow(''),
    criticality: Joi.string()
      .valid(...CRITICALITY_LEVELS)
      .label('Criticality'),
    hasAMC: Joi.boolean().label('Has AMC'),
    isActive: Joi.boolean().label('Is Active'),
  }),
};

const getMachineById = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: machineIdParams,
};

const updateMachine = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: machineIdParams,
  body: Joi.object()
    .keys({
      machineName: requiredString('Machine name').optional(),
      location: requiredString('Location').optional(),
      ...machineFields,
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

const updateActiveStatus = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
    isActive: Joi.boolean()
      .required()
      .label('Is Active')
      .messages({ ...booleanMessages }),
  }),
  params: machineIdParams,
};

const deleteMachine = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: machineIdParams,
};

const getMachineDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    location: Joi.string().trim().label('Location'),
    process: Joi.string().trim().label('Process'),
    criticality: Joi.string()
      .valid(...CRITICALITY_LEVELS)
      .label('Criticality'),
  }),
};

module.exports = {
  createMachine,
  getAllMachines,
  getMachineById,
  updateMachine,
  updateActiveStatus,
  deleteMachine,
  getMachineDropdown,
};
