const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { ACCOUNT_CATEGORIES, BALANCE_TYPES } = require('@smit9313/abss-models-core/src/utils/enum');
const { LEDGER_SOURCE_MODULES, LEDGER_PARTY_TYPES } = require('../../../utils/enum');

const getCategories = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const createAccount = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      accountName: Joi.string().trim().required().label('Account Name').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
      accountCode: Joi.string().trim().optional().allow(null, '').label('Account Code'),
      category: Joi.string()
        .valid(...Object.keys(ACCOUNT_CATEGORIES))
        .required()
        .label('Category')
        .messages({
          'any.required': '{{#label}} is required',
          'any.only': '{{#label}} must be one of the valid account categories',
        }),
      parentAccountId: Joi.string().optional().allow(null).custom(objectId).label('Parent Account ID'),
      openingBalance: Joi.object()
        .keys({
          amount: Joi.number().greater(0).required().label('Opening Balance Amount'),
          balanceType: Joi.string()
            .valid(...Object.values(BALANCE_TYPES))
            .required()
            .label('Balance Type'),
          openingBalanceDate: Joi.date().required().label('Opening Balance Date'),
        })
        .allow(null)
        .optional(),
      isSystemAccount: Joi.forbidden(),
    })
    .unknown(false),
};

const getAccounts = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isSplit: Joi.boolean().optional().allow(null),
    search: Joi.string(),
    isActive: Joi.boolean().optional().allow(null),
    includeInactive: Joi.boolean().optional().allow(null),
    category: Joi.string(),
    isSystemAccount: Joi.boolean().optional().allow(null),
    startDate: Joi.date().optional(),
    endDate: Joi.date().min(Joi.ref('startDate')).optional().label('End Date').messages({
      'date.min': '{{#label}} cannot be before the start date',
    }),
  }),
};

const getAccountsDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isActive: Joi.boolean().optional().allow(null),
    includeInactive: Joi.boolean().optional().allow(null),
    category: Joi.string(),
    isSystemAccount: Joi.boolean().optional().allow(null),
    excludeAccountId: Joi.string().custom(objectId).optional(),
  }),
};

const getAccountsByCompany = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    category: Joi.string()
      .valid(...Object.keys(ACCOUNT_CATEGORIES))
      .optional(),
    isSystemAccount: Joi.boolean().optional(),
    parentAccountId: Joi.string().optional().custom(objectId),
  }),
};

const getAccountLedger = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isSplit: Joi.boolean().optional(),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    pagination: Joi.boolean().optional(),
    startDate: Joi.date().optional(),
    endDate: Joi.date().min(Joi.ref('startDate')).optional().label('End Date').messages({
      'date.min': '{{#label}} cannot be before the start date',
    }),
    branchId: Joi.string(),
    sourceModule: Joi.string()
      .valid(...Object.values(LEDGER_SOURCE_MODULES))
      .optional()
      .label('Source Module'),
    partyType: Joi.string()
      .valid(...Object.values(LEDGER_PARTY_TYPES))
      .optional()
      .label('Party Type'),
  }),
  params: Joi.object().keys({
    accountId: Joi.string().required().custom(objectId).label('Account ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

const updateAccount = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    accountId: Joi.string().required().custom(objectId).label('Account ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
  body: Joi.object()
    .keys({
      accountName: Joi.string().trim().optional().label('Account Name'),
      accountCode: Joi.string().trim().optional().allow(null, '').label('Account Code'),
      isActive: Joi.boolean().optional().label('Is Active'),
      parentAccountId: Joi.string().optional().allow(null).custom(objectId).label('Parent Account ID'),
      category: Joi.string()
        .valid(...Object.keys(ACCOUNT_CATEGORIES))
        .optional()
        .label('Category')
        .messages({
          'any.only': '{{#label}} must be one of the valid account categories',
        }),
      openingBalance: Joi.object()
        .keys({
          amount: Joi.number().greater(0).required().label('Opening Balance Amount'),
          balanceType: Joi.string()
            .valid(...Object.values(BALANCE_TYPES))
            .required()
            .label('Balance Type'),
          openingBalanceDate: Joi.date().required().label('Opening Balance Date'),
        })
        .allow(null)
        .optional(),
      isSystemAccount: Joi.forbidden(),
    })
    .unknown(false),
};

const deleteAccount = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    accountId: Joi.string().required().custom(objectId).label('Account ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

module.exports = {
  getCategories,
  createAccount,
  getAccounts,
  getAccountsDropdown,
  getAccountsByCompany,
  getAccountLedger,
  updateAccount,
  deleteAccount,
};
