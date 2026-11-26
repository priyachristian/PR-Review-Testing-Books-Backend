const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { SPARE_PART_CATEGORY } = require('@smit9313/abss-models-core/src/utils/enum');

const SPARE_PART_CATEGORIES = Object.values(SPARE_PART_CATEGORY);

const stringMessages = {
  'string.base': '{{#label}} must be a string',
  'string.empty': '{{#label}} cannot be empty',
  'any.required': '{{#label}} is required',
};

const numberMessages = {
  'number.base': '{{#label}} must be a number',
  'number.integer': '{{#label}} must be a whole number',
  'number.min': '{{#label}} must be greater than or equal to {{#limit}}',
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

const nonNegativeNumber = label =>
  Joi.number()
    .min(0)
    .allow(null)
    .label(label)
    .messages({ ...numberMessages });

const companyIdQuery = Joi.string().required().custom(objectId).label('Company ID');

const sparePartIdParams = Joi.object().keys({
  id: Joi.string().custom(objectId).required().label('Spare part ID').messages({
    'string.base': '{{#label}} must be a string',
    'any.required': '{{#label}} is required',
  }),
});

const categorySchema = Joi.string()
  .valid(...SPARE_PART_CATEGORIES)
  .label('Category')
  .messages({
    'string.base': '{{#label}} must be a string',
    'any.only': `{{#label}} must be one of: ${SPARE_PART_CATEGORIES.join(', ')}`,
  });

const sparePartFields = {
  category: categorySchema,
  uom: Joi.string().custom(objectId).label('Unit of measure').messages({
    'string.base': '{{#label}} must be a valid ID',
    'string.empty': '{{#label}} is required',
    'any.required': '{{#label}} is required',
  }),
  standardRate: nonNegativeNumber('Standard rate'),
  minStockLevel: nonNegativeNumber('Minimum stock level'),
  maxStockLevel: nonNegativeNumber('Maximum stock level')
    .when('minStockLevel', {
      is: Joi.number().required(),
      then: Joi.number().min(Joi.ref('minStockLevel')),
    })
    .messages({
      ...numberMessages,
      'number.min': '{{#label}} cannot be less than the minimum stock level',
    }),
  preferredVendor: optionalString('Preferred vendor'),
  leadDays: Joi.number()
    .integer()
    .min(0)
    .allow(null)
    .label('Lead days')
    .messages({ ...numberMessages }),
  drawingReference: optionalString('Drawing reference'),
  fitsOnMachines: Joi.array()
    .items(Joi.string().custom(objectId).label('Machine').messages({ 'string.base': '{{#label}} must be a valid ID' }))
    .unique()
    .label('Fits on machines')
    .messages({
      'array.base': '{{#label}} must be an array',
      'array.unique': 'Each machine can be added only once',
    }),
};

const createSparePart = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  body: Joi.object().keys({
    name: requiredString('Spare part name'),
    ...sparePartFields,
    category: sparePartFields.category.required().messages({ 'any.required': '{{#label}} is required' }),
    uom: sparePartFields.uom.required(),
    stock: Joi.number()
      .min(0)
      .allow(null)
      .label('Stock')
      .messages({ ...numberMessages }),
  }),
};

const getAllSpareParts = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer().min(1),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
    search: Joi.string().trim().allow(''),
    category: categorySchema,
    machineId: Joi.string().custom(objectId).label('Machine ID'),
    isActive: Joi.boolean().label('Is Active'),
  }),
};

const getSparePartById = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: sparePartIdParams,
};

const updateSparePart = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: sparePartIdParams,
  body: Joi.object()
    .keys({
      name: requiredString('Spare part name').optional(),
      ...sparePartFields,
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

const updateActiveStatus = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
    isActive: Joi.boolean().required().label('Is Active').messages({
      'boolean.base': '{{#label}} must be a boolean',
      'any.required': '{{#label}} is required',
    }),
  }),
  params: sparePartIdParams,
};

const deleteSparePart = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: sparePartIdParams,
};

const getSparePartDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    category: categorySchema,
    machineId: Joi.string().custom(objectId).label('Machine ID'),
  }),
};

module.exports = {
  createSparePart,
  getAllSpareParts,
  getSparePartById,
  updateSparePart,
  updateActiveStatus,
  deleteSparePart,
  getSparePartDropdown,
};
