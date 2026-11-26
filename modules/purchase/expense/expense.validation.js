const Joi = require('joi');
const { EXPENSE_SUPPLY_TYPES, EXPENSE_TAX_SPLIT, TAX_TYPES } = require('@smit9313/abss-models-core/src/utils/enum');
const { ADDRESS_TYPES } = require('../../../utils/enum');
const { objectId } = require('../../../validations/custom.validation');
const { createTaxSchema } = require('../../../validations/common.validation');

const expenseFlowFields = {
  lines: Joi.array()
    .items(
      Joi.object().keys({
        accountId: Joi.string().required().custom(objectId).label('Expense Account'),
        description: Joi.string().trim().allow('', null).label('Description'),
        amount: Joi.number().positive().required().label('Amount'),
        gst: Joi.string().valid('none', 'exempted', '0', '5', '12', '18', '28').required().label('GST'),
        supplyType: Joi.string()
          .valid(...Object.values(EXPENSE_SUPPLY_TYPES))
          .allow(null)
          .label('Supply Type'),
        hsnCode: Joi.string().trim().allow('', null).label('HSN/SAC'),
        isItcEligible: Joi.boolean().label('Input Credit'),
      }),
    )
    .min(1)
    .label('Expense Lines'),
  invoiceNo: Joi.string().trim().allow('', null).label('Invoice No.'),
  invoiceDate: Joi.date()
    .allow('', null)
    .label('Invoice Date')
    .when('invoiceNo', {
      is: Joi.string().min(1).required(),
      then: Joi.date().required().invalid('', null),
    }),
  supplierGstin: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .allow('', null)
    .label('Supplier GSTIN')
    .messages({ 'string.pattern.base': '{{#label}} must be a valid GSTIN' }),
  isTaxInclusive: Joi.boolean().label('Amounts Are'),
  taxSplit: Joi.string()
    .valid(...Object.values(EXPENSE_TAX_SPLIT))
    .label('Tax Split')
    .when('lines', { is: Joi.exist(), then: Joi.required() }),
  tax: createTaxSchema({ taxTypes: Object.values(TAX_TYPES) }),
  isRoundOff: Joi.boolean().label('Round Off'),
  isBillable: Joi.boolean().label('Billable'),
};

const createExpense = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    divisionId: Joi.string().required().custom(objectId).label('Division ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    branchId: Joi.string().required().custom(objectId).label('Branch ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    warehouseId: Joi.string()
      .custom(objectId)
      .allow(null)
      .label('Warehouse ID')
      .messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      })
      .optional(),
    date: Joi.date().required().label('Date').messages({
      'date.base': '{{#label}} must be a valid date',
      'any.required': '{{#label}} is required',
    }),
    expenseAccount: Joi.string().label('Expense Account').messages({
      'any.only': '{{#label}} must be one of the valid expense accounts',
    }),
    paidThroughAccountId: Joi.string()
      .custom(objectId)
      .allow(null)
      .label('Paid Through Account')
      .messages({
        'any.required': '{{#label}} is required',
        'any.invalid': '{{#label}} is required',
      })
      .when('isBillable', { is: true, otherwise: Joi.required().invalid(null) }),
    total: Joi.number()
      .label('Total')
      .messages({
        'number.base': '{{#label}} must be a number',
        'any.required': '{{#label}} is required',
      })
      .when('lines', { is: Joi.exist(), otherwise: Joi.required() }),
    notes: Joi.string().trim().max(500).allow('').label('Notes').messages({
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} cannot exceed 500 characters',
    }),
    party: Joi.string()
      .custom(objectId)
      .allow('', null)
      .label('Party')
      .messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      })
      .when('isBillable', { is: true, then: Joi.required().invalid('', null) }),
    receipts: Joi.array().items(Joi.string()).label('Receipts').messages({
      'array.base': '{{#label}} must be an array of receipt strings',
    }),
    expenseId: Joi.string(),
    termsAndConditions: Joi.string().allow(null, '').label('Terms and Conditions').messages({
      'string.base': '{{#label}} must be a string',
    }),
    exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate'),
    ...expenseFlowFields,
  }),
};

const getExpensesValidation = {
  query: Joi.object().keys({
    companyId: Joi.string().required(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    date: Joi.date(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    addedBy: Joi.string(),
    partyId: Joi.string().custom(objectId),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
  }),
};

const getExpensesExports = {
  query: Joi.object().keys({
    companyId: Joi.string().required(),
    sortBy: Joi.string(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    date: Joi.date(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    addedBy: Joi.string(),
    partyId: Joi.string().custom(objectId),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
  }),
};

const updateExpense = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId).label('Expense ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    divisionId: Joi.string().required().custom(objectId).label('Division ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    branchId: Joi.string().required().custom(objectId).label('Branch ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    warehouseId: Joi.string()
      .custom(objectId)
      .allow(null)
      .label('Warehouse ID')
      .messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      })
      .optional(),
    date: Joi.date().required().label('Date').messages({
      'date.base': '{{#label}} must be a valid date',
      'any.required': '{{#label}} is required',
    }),
    expenseAccount: Joi.string().label('Expense Account').messages({
      'any.only': '{{#label}} must be one of the valid expense accounts',
    }),
    paidThroughAccountId: Joi.string()
      .custom(objectId)
      .allow(null)
      .label('Paid Through Account')
      .messages({
        'any.required': '{{#label}} is required',
        'any.invalid': '{{#label}} is required',
      })
      .when('isBillable', { is: true, otherwise: Joi.required().invalid(null) }),
    total: Joi.number()
      .label('Total')
      .messages({
        'number.base': '{{#label}} must be a number',
        'any.required': '{{#label}} is required',
      })
      .when('lines', { is: Joi.exist(), otherwise: Joi.required() }),
    notes: Joi.string().trim().max(500).allow('').label('Notes').messages({
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} cannot exceed 500 characters',
    }),
    party: Joi.string()
      .custom(objectId)
      .allow('', null)
      .label('Party')
      .messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      })
      .when('isBillable', { is: true, then: Joi.required().invalid('', null) }),
    receipts: Joi.array().items(Joi.string()).label('Receipts').messages({
      'array.base': '{{#label}} must be an array of receipt strings',
    }),
    expenseId: Joi.string(),
    termsAndConditions: Joi.string().allow(null, '').label('Terms and Conditions').messages({
      'string.base': '{{#label}} must be a string',
    }),
    exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate'),
    ...expenseFlowFields,
  }),
};

const deleteExpense = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const getExpenseById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

module.exports = {
  createExpense,
  getExpensesValidation,
  getExpensesExports,
  updateExpense,
  getExpenseById,
  deleteExpense,
};
