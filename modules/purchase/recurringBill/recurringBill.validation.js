const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { REPEAT_PERIODS, RECURRING_INVOICE_STATUS } = require('../../../utils/enum');
const {
  purchaseBaseValidationSchema,
  purchaseActivationKeys,
  commonSchemas,
  discountValidation,
} = require('../../../validations/common.validation');

const createRecurringBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: purchaseBaseValidationSchema.keys({
    profileName: Joi.string().required().trim().label('Profile Name').messages({
      'any.required': '{{#label}} is required',
      'string.empty': '{{#label}} cannot be empty',
    }),
    referenceNumber: Joi.string().trim().allow('').label('Reference Number'),
    repeatEvery: Joi.object({
      frequency: Joi.number().required().default(1).label('Frequency').messages({
        'any.required': '{{#label}} is required',
      }),
      period: Joi.string()
        .required()
        .valid(...Object.values(REPEAT_PERIODS))
        .default(REPEAT_PERIODS.MONTH)
        .label('Period')
        .messages({
          'any.required': '{{#label}} is required',
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
    }).required(),
    startDate: Joi.date().required().label('Start Date').messages({
      'any.required': '{{#label}} is required',
    }),
    priceListId: Joi.string().custom(objectId).allow(null).optional(),
    endDate: Joi.date()
      .when('neverExpires', {
        is: false,
        then: Joi.required(),
        otherwise: Joi.optional().allow('', null),
      })
      .label('End Date')
      .messages({
        'any.required': '{{#label}} is required',
      }),
    neverExpires: Joi.boolean().default(false).label('Never Expires'),
    paymentTermsId: Joi.string().required().custom(objectId).label('Payment Terms').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    status: Joi.string()
      .valid(...Object.keys(RECURRING_INVOICE_STATUS))
      .label('Invoice Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    subject: Joi.string().trim().allow('').label('Subject'),
    customerNotes: Joi.string().trim().allow('').label('Customer Notes'),
    termsAndConditions: Joi.string().trim().allow('').label('Terms and Conditions'),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    recurringBillId: Joi.string().required(),
    recurringBillDate: commonSchemas.date({ label: 'Recurring Bill Date', isRequired: true }),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: commonSchemas.objectId({ label: 'Address ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
    ...purchaseActivationKeys,
  }),
};

const getRecurringBills = {
  query: Joi.object().keys({
    recurringBillId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID' }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    status: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    recurringBillDate: commonSchemas.date({ label: 'Recurring Bill Date' }),
  }),
};

const getRecurringBillById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
};

const updateRecurringBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().label('Bill ID').messages({
      'string.empty': '{{#label}} is required',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: purchaseBaseValidationSchema
    .keys({
      profileName: Joi.string().required().trim().label('Profile Name').messages({
        'any.required': '{{#label}} is required',
        'string.empty': '{{#label}} cannot be empty',
      }),
      referenceNumber: Joi.string().trim().allow('').label('Reference Number'),
      repeatEvery: Joi.object({
        frequency: Joi.number().required().default(1).label('Frequency').messages({
          'any.required': '{{#label}} is required',
        }),
        period: Joi.string()
          .required()
          .valid(...Object.values(REPEAT_PERIODS))
          .default(REPEAT_PERIODS.MONTH)
          .label('Period')
          .messages({
            'any.required': '{{#label}} is required',
            'any.only': '{{#label}} must be one of {{#valids}}',
          }),
      }).required(),
      startDate: Joi.date().required().label('Start Date').messages({
        'any.required': '{{#label}} is required',
      }),
      priceListId: Joi.string().custom(objectId).allow(null).optional(),
      endDate: Joi.date()
        .when('neverExpires', {
          is: false,
          then: Joi.required(),
          otherwise: Joi.optional().allow('', null),
        })
        .label('End Date')
        .messages({
          'any.required': '{{#label}} is required',
        }),
      neverExpires: Joi.boolean().default(false).label('Never Expires'),
      paymentTermsId: Joi.string().required().custom(objectId).label('Payment Terms').messages({
        'any.required': '{{#label}} is required',
        'string.objectId': '{{#label}} must be a valid ObjectId',
      }),
      status: Joi.string()
        .valid(...Object.keys(RECURRING_INVOICE_STATUS))
        .label('Invoice Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        })
        .optional(),
      subject: Joi.string().trim().allow('').label('Subject'),
      customerNotes: Joi.string().trim().allow('').label('Customer Notes'),
      termsAndConditions: Joi.string().trim().allow('').label('Terms and Conditions'),
      attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
        'array.base': '{{#label}} must be an array of strings',
      }),
      discountConfig: discountValidation,
      appliesTo: Joi.string().optional().allow(null, ''),
      addressId: commonSchemas.objectId({ label: 'Address ID', isRequired: false }),
      customerId: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
      ...purchaseActivationKeys,
    })
    .min(1),
};

const deleteRecurringBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
};

const updateRecurringBillStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().label('Recurring Bill ID').messages({
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object().keys({
    status: Joi.string()
      .required()
      .valid(...Object.keys(RECURRING_INVOICE_STATUS))
      .label('Status')
      .messages({
        'any.required': '{{#label}} is required',
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
  }),
};

const createBillFromRecurringDoc = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId).label('Recurring Bill History ID').messages({
      'string.empty': '{{#label}} is required',
      'any.required': '{{#label}} is required',
    }),
  }),
};

module.exports = {
  createRecurringBill,
  getRecurringBills,
  getRecurringBillById,
  updateRecurringBill,
  deleteRecurringBill,
  createBillFromRecurringDoc,
  updateRecurringBillStatus,
};
