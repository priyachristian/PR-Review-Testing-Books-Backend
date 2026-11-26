const Joi = require('joi');
const { objectId } = require('../../validations/custom.validation');
const { PRIORITY, SUPPORT_CATEGORY, SUPPORT_MODULES } = require('@smit9313/abss-models-core/src/utils/enum');
const { commonSchemas } = require('../../validations/common.validation');

const createSupport = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object().keys({
    bugTitle: Joi.string().trim().required().label('Bug Title / What do you need?').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    priority: Joi.string()
      .valid(...Object.values(PRIORITY))
      .required()
      .default(PRIORITY.MEDIUM)
      .label('Priority')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    description: Joi.string().trim().optional().allow('', null).label('Description').messages({
      'string.base': '{{#label}} must be a string',
    }),
    stepsToReproduce: Joi.when('category', {
      is: SUPPORT_CATEGORY.BUG,
      then: Joi.array()
        .items(
          Joi.string().trim().required().messages({
            'string.empty': 'Step cannot be empty',
          }),
        )
        .min(1)
        .required()
        .label('Steps To Reproduce')
        .messages({
          'array.min': '{{#label}} must contain at least one step',
          'any.required': '{{#label}} is required',
        }),
      otherwise: Joi.array().items(Joi.string().trim()).optional().allow(null),
    }),
    expectedBehavior: Joi.string().trim().optional().allow('', null).label('Expected Behavior').messages({
      'string.empty': '{{#label}} cannot be empty',
    }),
    actualBehavior: Joi.string().trim().optional().allow('', null).label('Actual Behavior').messages({
      'string.empty': '{{#label}} cannot be empty',
    }),
    category: Joi.string()
      .valid(...Object.values(SUPPORT_CATEGORY))
      .default(SUPPORT_CATEGORY.BUG)
      .label('Category')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    moduleName: Joi.when('category', {
      is: Joi.valid(SUPPORT_CATEGORY.NEW_MODULE),
      then: Joi.string()
        .valid(...Object.values(SUPPORT_MODULES))
        .optional()
        .allow('', null)
        .label('Module Name'),
      otherwise: Joi.string()
        .valid(...Object.values(SUPPORT_MODULES))
        .required()
        .label('Module Name')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
          'any.required': '{{#label}} is required',
          'string.empty': '{{#label}} cannot be empty',
        }),
    }),
    whyDoYouNeedIt: Joi.when('category', {
      is: Joi.valid(SUPPORT_CATEGORY.CHANGE_REQUEST, SUPPORT_CATEGORY.NEW_MODULE),
      then: Joi.string().trim().required().label('Why do you need it?').messages({
        'string.empty': '{{#label}} cannot be empty',
        'any.required': '{{#label}} is required',
      }),
      otherwise: Joi.string().trim().optional().allow('', null),
    }),
    howDoYouManageToday: Joi.string().trim().optional().allow('', null).label('How do you manage today?'),
    whatShouldChange: Joi.string().trim().optional().allow('', null).label('What should change?'),
    attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
  }),
};

const getSupports = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: false }),
    search: Joi.string().trim().optional().allow(''),
    category: Joi.string().optional(),
    status: Joi.string().optional(),
    priority: Joi.string().optional(),
    moduleName: Joi.string().optional(),
    raisedBy: Joi.string().optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getSupport = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  params: Joi.object().keys({
    supportId: commonSchemas.objectId({ label: 'Support ID', isRequired: true }),
  }),
};

const updateSupport = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  params: Joi.object().keys({
    supportId: commonSchemas.objectId({ label: 'Support ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    bugTitle: Joi.string().trim().optional().label('Bug Title / What do you need?'),
    priority: Joi.string()
      .valid(...Object.values(PRIORITY))
      .optional()
      .label('Priority')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    description: Joi.string().trim().optional().label('Description'),
    stepsToReproduce: Joi.array()
      .items(
        Joi.string().trim().required().messages({
          'string.empty': 'Step cannot be empty',
        }),
      )
      .min(1)
      .optional()
      .label('Steps To Reproduce')
      .messages({
        'array.min': '{{#label}} must contain at least one step',
      }),
    expectedBehavior: Joi.string().trim().optional().allow('', null).label('Expected Behavior'),
    actualBehavior: Joi.string().trim().optional().allow('', null).label('Actual Behavior'),
    whyDoYouNeedIt: Joi.string().trim().optional().allow('', null).label('Why do you need it?'),
    howDoYouManageToday: Joi.string().trim().optional().allow('', null).label('How do you manage today?'),
    whatShouldChange: Joi.string().trim().optional().allow('', null).label('What should change?'),
    category: Joi.string()
      .valid(...Object.values(SUPPORT_CATEGORY))
      .label('Category')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    reason: Joi.string(),
    moduleName: Joi.string()
      .valid(...Object.values(SUPPORT_MODULES))
      .label('Module Name')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
  }),
};

const addComment = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  params: Joi.object().keys({
    supportId: commonSchemas.objectId({ label: 'Support ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    description: Joi.string().trim().required().label('Description').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    userType: Joi.string().valid('USER', 'PORTAL_USER', 'SYSTEM').optional().default('USER').label('User Type').messages({
      'any.only': '{{#label}} must be one of USER, PORTAL_USER, SYSTEM',
    }),
  }),
};

const updateStatus = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  params: Joi.object().keys({
    supportId: commonSchemas.objectId({ label: 'Support ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    isUserTested: Joi.boolean().required().label('Is User Tested').messages({
      'any.required': '{{#label}} is required',
      'boolean.base': '{{#label}} must be a boolean',
    }),
  }),
};

module.exports = {
  createSupport,
  getSupports,
  getSupport,
  updateSupport,
  addComment,
  updateStatus,
};
