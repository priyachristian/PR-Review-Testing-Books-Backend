const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { BANK_TYPES, TRANSACTION_TYPES } = require('../../../utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');

const createBank = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    accountType: Joi.string()
      .required()
      .valid(...Object.values(BANK_TYPES))
      .label('Account Type')
      .messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
    accountName: Joi.string().required().label('Account Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    accountCode: Joi.string().allow('', null).optional().label('Account Code').messages({
      'string.base': '{{#label}} must be a string',
    }),
    openingBalance: Joi.number().optional().allow(null, '').default(0).label('Opening Balance').messages({
      'number.base': '{{#label}} must be a number',
    }),
    currency: Joi.string().custom(objectId).required().label('Currency').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    accountNumber: Joi.string().allow('', null).optional().label('Account Number').messages({
      'string.base': '{{#label}} must be a string',
    }),
    bankName: Joi.string().allow('', null).optional().label('Bank Name').messages({
      'string.base': '{{#label}} must be a string',
    }),
    ifsc: Joi.string().allow('', null).optional().label('IFSC Code').messages({
      'string.base': '{{#label}} must be a string',
    }),
    description: Joi.string().max(500).allow('').label('Description').messages({
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} must not exceed 500 characters',
    }),
    isPrimary: Joi.boolean().optional().label('Is Primary').messages({
      'boolean.base': '{{#label}} must be a boolean value',
    }),
    divisionId: Joi.string().custom(objectId).allow(null, '').label('Division ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    branchId: Joi.string().custom(objectId).allow(null, '').label('Branch ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    gstinUin: Joi.string().allow(null, '').optional(),
    branch: Joi.string().max(200).allow('').optional().label('Bank branch').messages({
      'string.max': '{{#label}} must not exceed 200 characters',
    }),
  }),
};

const getBanks = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isPrimary: Joi.boolean(),
    accountType: Joi.string()
      .valid(...Object.values(BANK_TYPES))
      .label('Account Type')
      .messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const updateBank = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    bankId: Joi.string().custom(objectId).required().label('Bank ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    accountType: Joi.string()
      .optional()
      .valid(...Object.values(BANK_TYPES))
      .label('Account Type')
      .messages({
        'string.base': '{{#label}} must be a string',
      }),
    accountName: Joi.string().optional().label('Account Name').messages({
      'string.base': '{{#label}} must be a string',
    }),
    accountCode: Joi.string().allow('', null).optional().label('Account Code').messages({
      'string.base': '{{#label}} must be a string',
    }),
    currency: Joi.string().custom(objectId).label('Currency').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    accountNumber: Joi.string().allow('', null).optional().label('Account Number').messages({
      'string.base': '{{#label}} must be a string',
    }),
    openingBalance: Joi.number().optional().allow(null, '').label('Opening Balance').messages({
      'number.base': '{{#label}} must be a number',
    }),
    bankName: Joi.string().allow('', null).optional().label('Bank Name').messages({
      'string.base': '{{#label}} must be a string',
    }),
    ifsc: Joi.string().allow('', null).optional().label('IFSC Code').messages({
      'string.base': '{{#label}} must be a string',
    }),
    description: Joi.string().max(500).allow('').label('Description').messages({
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} must not exceed 500 characters',
    }),
    isPrimary: Joi.boolean().optional().label('Is Primary').messages({
      'boolean.base': '{{#label}} must be a boolean value',
    }),
    divisionId: Joi.string().custom(objectId).allow(null, '').label('Division ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    branchId: Joi.string().custom(objectId).allow(null, '').label('Branch ID').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    gstinUin: Joi.string().allow(null, '').optional(),
    branch: Joi.string().max(200).allow('').optional().label('Bank branch').messages({
      'string.max': '{{#label}} must not exceed 200 characters',
    }),
  }),
};

const deleteBank = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    bankId: Joi.string().custom(objectId).required(),
  }),
};

const bankDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    accountType: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
    isPrimary: Joi.boolean(),
  }),
};

const transfer = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    fromAccountId: Joi.string().required().custom(objectId).label('Transfer From Account').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    toAccountId: Joi.string().required().custom(objectId).label('Transfer To Account').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    amount: Joi.number().required().positive().label('amount').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.positive': '{{#label}} must be greater than 0',
    }),
    fromAmount: Joi.number().optional().positive().label('fromAmount').messages({
      'number.base': '{{#label}} must be a number',
      'number.positive': '{{#label}} must be greater than 0',
    }),
    exchangeRate: Joi.number().optional().positive().label('exchangeRate').messages({
      'number.base': '{{#label}} must be a number',
      'number.positive': '{{#label}} must be greater than 0',
    }),
    date: commonSchemas.date({ label: 'Date', isRequired: true }),
  }),
};

const getBankById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    bankId: Joi.string().custom(objectId).required(),
  }),
};

const transaction = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    fromAccountId: Joi.string().required().custom(objectId).label('From Account').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    toAccountId: Joi.string().required().custom(objectId).label('To Account').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    transactionType: Joi.string()
      .required()
      .valid(...Object.values(TRANSACTION_TYPES))
      .label('Transaction Type')
      .messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
    date: commonSchemas.date({ label: 'Date', isRequired: true }),
    transactionDescription: Joi.string().required().label('Transaction Description').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    amount: Joi.number().required().positive().label('Amount').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.positive': '{{#label}} must be greater than 0',
    }),
    fromAmount: Joi.number().optional().positive().label('fromAmount').messages({
      'number.base': '{{#label}} must be a number',
      'number.positive': '{{#label}} must be greater than 0',
    }),
    exchangeRate: Joi.number().optional().positive().label('exchangeRate').messages({
      'number.base': '{{#label}} must be a number',
      'number.positive': '{{#label}} must be greater than 0',
    }),
  }),
};

const getTransactions = {
  query: Joi.object().keys({
    bankId: Joi.string().custom(objectId).optional(),
    companyId: Joi.string().custom(objectId).required(),
    transactionType: Joi.string()
      .valid(...Object.values(TRANSACTION_TYPES))
      .optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getTransactionById = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    transactionId: Joi.string().custom(objectId).required(),
  }),
};

const approveTransaction = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    transactionId: Joi.string().custom(objectId).required(),
    notes: Joi.string().allow('', null),
  }),
};

const rejectTransaction = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    transactionId: Joi.string().custom(objectId).required(),
    notes: Joi.string().allow('', null),
  }),
};

const cancelTransaction = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    transactionId: Joi.string().custom(objectId).required(),
    notes: Joi.string().allow('', null),
  }),
};

module.exports = {
  createBank,
  getBanks,
  updateBank,
  deleteBank,
  bankDropdown,
  transfer,
  getBankById,
  transaction,
  getTransactions,
  getTransactionById,
  approveTransaction,
  rejectTransaction,
  cancelTransaction,
};
