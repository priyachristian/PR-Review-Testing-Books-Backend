const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { REPEAT_PERIODS } = require('../../../utils/enum');
const { RECURRING_DOC_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');

const createRecurringExpense = {
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
      .required(),
    expenseAccount: Joi.string().custom(objectId).required().label('Expense Account').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    paidThroughAccountId: Joi.string().custom(objectId).required().label('Paid Through Account').messages({
      'any.required': '{{#label}} is required',
    }),
    amount: Joi.number().positive().required().label('Amount').messages({
      'number.base': '{{#label}} must be a number',
      'number.positive': '{{#label}} must be greater than zero',
      'any.required': '{{#label}} is required',
    }),
    notes: Joi.string().trim().max(500).allow('').label('Notes').messages({
      'string.base': '{{#label}} must be a string',
      'string.max': '{{#label}} cannot exceed 500 characters',
    }),
    customer: Joi.string().custom(objectId).allow('', null).label('Customer').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    receipts: Joi.array().items(Joi.string()).label('Receipts').messages({
      'array.base': '{{#label}} must be an array of receipt strings',
    }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of attachment strings',
    }),
    repeatEvery: Joi.object({
      frequency: Joi.number().integer().min(1).required().default(1).label('Frequency').messages({
        'number.base': '{{#label}} must be a number',
        'number.integer': '{{#label}} must be a whole number',
        'number.min': '{{#label}} must be at least 1',
        'any.required': '{{#label}} is required',
      }),
      period: Joi.string()
        .required()
        .valid(...Object.values(REPEAT_PERIODS))
        .default(REPEAT_PERIODS.MONTH)
        .label('Period')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
    }).required(),
    startDate: Joi.date().required().label('Start Date').messages({
      'any.required': '{{#label}} is required',
      'date.base': '{{#label}} must be a valid date',
    }),
    neverExpires: Joi.boolean().default(false).label('Never Expires'),
    endDate: Joi.when('neverExpires', {
      is: true,
      then: Joi.date().allow('', null),
      otherwise: Joi.date().min(Joi.ref('startDate')).required(),
    })
      .label('End Date')
      .messages({
        'any.required': '{{#label}} is required unless the expense never expires',
        'date.min': '{{#label}} must be after the start date',
        'date.base': '{{#label}} must be a valid date',
      }),
    recurringExpenseId: Joi.string().required(),
    recurringExpenseDate: commonSchemas.date({ label: 'Recurring Expense Date', isRequired: true }),
    addressId: commonSchemas.objectId({ label: 'Address ID', isRequired: true }),
    termsAndConditions: Joi.string().allow(null, '').label('Terms and Conditions').messages({
      'string.base': '{{#label}} must be a string',
    }),
    exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate'),
  }),
};

const getRecurringExpenses = {
  query: Joi.object().keys({
    companyId: Joi.string().required(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    recurringExpenseDate: Joi.date(),
  }),
};

const getRecurringExpense = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    recurringExpenseId: Joi.string().custom(objectId).required(),
  }),
};

const updateRecurringExpense = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    recurringExpenseId: Joi.string().custom(objectId).required().label('Recurring Expense ID').messages({
      'any.required': '{{#label}} is required',
      'string.empty': '{{#label}} cannot be empty',
    }),
  }),
  body: Joi.object()
    .keys({
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
      expenseAccount: Joi.string().custom(objectId).required().label('Expense Account').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a valid ObjectId',
      }),
      paidThroughAccountId: Joi.string().custom(objectId).optional().label('Paid Through Account'),
      amount: Joi.number().positive().required().label('Amount').messages({
        'number.base': '{{#label}} must be a number',
        'number.positive': '{{#label}} must be greater than zero',
        'any.required': '{{#label}} is required',
      }),
      notes: Joi.string().trim().max(500).allow('').label('Notes').messages({
        'string.base': '{{#label}} must be a string',
        'string.max': '{{#label}} cannot exceed 500 characters',
      }),
      customer: Joi.string().custom(objectId).allow('', null).label('Customer').messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      }),
      receipts: Joi.array().items(Joi.string()).label('Receipts').messages({
        'array.base': '{{#label}} must be an array of receipt strings',
      }),
      attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
        'array.base': '{{#label}} must be an array of attachment strings',
      }),
      repeatEvery: Joi.object({
        frequency: Joi.number().integer().min(1).required().default(1).label('Frequency').messages({
          'number.base': '{{#label}} must be a number',
          'number.integer': '{{#label}} must be a whole number',
          'number.min': '{{#label}} must be at least 1',
          'any.required': '{{#label}} is required',
        }),
        period: Joi.string()
          .required()
          .valid(...Object.values(REPEAT_PERIODS))
          .default(REPEAT_PERIODS.MONTH)
          .label('Period')
          .messages({
            'any.only': '{{#label}} must be one of {{#valids}}',
          }),
      }).required(),
      startDate: Joi.date().required().label('Start Date').messages({
        'any.required': '{{#label}} is required',
        'date.base': '{{#label}} must be a valid date',
      }),
      neverExpires: Joi.boolean().default(false).label('Never Expires'),
      endDate: Joi.when('neverExpires', {
        is: true,
        then: Joi.date().allow('', null),
        otherwise: Joi.date().min(Joi.ref('startDate')).required(),
      })
        .label('End Date')
        .messages({
          'any.required': '{{#label}} is required unless the expense never expires',
          'date.min': '{{#label}} must be after the start date',
          'date.base': '{{#label}} must be a valid date',
        }),
      addressId: commonSchemas.objectId({ label: 'Address ID', isRequired: false }),
      termsAndConditions: Joi.string().allow(null, '').label('Terms and Conditions').messages({
        'string.base': '{{#label}} must be a string',
      }),
      exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate'),
    })
    .min(1),
};

const deleteRecurringExpense = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    recurringExpenseId: Joi.string().custom(objectId).required(),
  }),
};

const updateRecurringExpenseStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    recurringExpenseId: Joi.string().required().custom(objectId).label('Recurring Expense ID').messages({
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object().keys({
    status: Joi.string()
      .required()
      .valid(...Object.keys(RECURRING_DOC_STATUS))
      .label('Status')
      .messages({
        'any.required': '{{#label}} is required',
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
  }),
};

const createExpenseFromRecurringDoc = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId).label('Recurring Expense History ID').messages({
      'string.empty': '{{#label}} is required',
      'any.required': '{{#label}} is required',
    }),
  }),
};

module.exports = {
  createRecurringExpense,
  getRecurringExpenses,
  getRecurringExpense,
  updateRecurringExpense,
  deleteRecurringExpense,
  updateRecurringExpenseStatus,
  createExpenseFromRecurringDoc,
};
