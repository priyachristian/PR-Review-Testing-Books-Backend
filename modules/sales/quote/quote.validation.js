const Joi = require('joi');
const { QUOTE_STATUS, ADDRESS_TYPES } = require('../../../utils/enum');
const {
  commonSchemas,
  salesBaseValidationSchema,
  createItemSchema,
  discountValidation,
  commaSeparatedObjectIds,
} = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

const customerIdFilter = Joi.string().custom(commaSeparatedObjectIds).allow('').label('Customer ID');

const createQuote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: salesBaseValidationSchema.keys({
    quoteId: Joi.string(),
    reference: commonSchemas.string({ label: 'Reference', allowEmpty: true }),
    quoteDate: commonSchemas.date({ label: 'Quote Date', isRequired: true }),
    expiryDate: commonSchemas
      .date({ label: 'Expiry Date', isOptional: true })
      .greater(Joi.ref('quoteDate'))
      .allow(null)
      .messages({
        'date.greater': '{{#label}} must be after the Quote Date',
      }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true }),
    status: Joi.string()
      .valid(...Object.keys(QUOTE_STATUS))
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments'),
    paymentTermsId: Joi.string().allow(null).custom(objectId).label('Payment Terms').messages({
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    priceListId: Joi.string().custom(objectId).allow(null).optional(),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: Joi.string().required().custom(objectId).label('Address').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getQuotes = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    appName: Joi.string().allow('', null).optional(),
    quoteId: Joi.string(),
    customerId: customerIdFilter,
    status: Joi.string(),
    addedBy: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    search: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    quoteDate: commonSchemas.date({ label: 'Quote Date' }),
    ...commonSchemas.paginationQuery(),
    ...commonSchemas.dateRangeQuery(),
  }),
};

const getQuotesExports = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    appName: Joi.string().allow('', null).optional(),
    quoteId: Joi.string(),
    customerId: customerIdFilter,
    status: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    search: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    quoteDate: commonSchemas.date({ label: 'Quote Date' }),
    sortBy: Joi.string(),
    addedBy: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
  }),
};
const getQuote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    quoteId: commonSchemas.objectId({ label: 'Quote ID', isRequired: true }),
  }),
};

const updateQuote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    quoteId: commonSchemas.objectId({ label: 'Quote ID', isRequired: true }),
  }),
  body: salesBaseValidationSchema
    .keys({
      subject: commonSchemas.string({ label: 'Subject', allowEmpty: true, isOptional: true }),
      reference: commonSchemas.string({ label: 'Reference', allowEmpty: true, isOptional: true }),
      quoteDate: commonSchemas.date({ label: 'Quote Date', isOptional: true }),
      expiryDate: Joi.when('quoteDate', {
        is: Joi.exist(),
        then: commonSchemas.date({ label: 'Expiry Date', isOptional: true }).greater(Joi.ref('quoteDate')).allow(null).messages({
          'date.greater': '{{#label}} must be after the Quote Date',
        }),
        otherwise: commonSchemas.date({ label: 'Expiry Date', isOptional: true }).allow(null),
      }),
      status: Joi.string()
        .valid(...Object.keys(QUOTE_STATUS))
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        })
        .optional(),
      customerNotes: commonSchemas.string({
        label: 'Customer Notes',
        allowEmpty: true,
        isOptional: true,
      }),
      termsAndConditions: commonSchemas.string({
        label: 'Terms and Conditions',
        allowEmpty: true,
        isOptional: true,
      }),
      attachments: Joi.array().items(Joi.string()).label('Attachments'),
      items: Joi.array()
        .items(createItemSchema({ forCreation: false }))
        .label('Items')
        .messages({
          'array.base': '{{#label}} must be an array of valid items',
        }),
      paymentTermsId: Joi.string()
        .custom(objectId)
        .allow(null)
        .label('Payment Terms')
        .messages({
          'string.objectId': '{{#label}} must be a valid ObjectId',
        })
        .optional(),
      priceListId: Joi.string().custom(objectId).allow(null).optional(),
      discountConfig: discountValidation,
      appliesTo: Joi.string().optional().allow(null, ''),
      addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
        'any.required': '{{#label}} is required',
        'string.objectId': '{{#label}} must be a valid ObjectId',
      }),
    })

    .min(1)
    .label('Update Body')
    .messages({ 'object.min': 'At least one field must be provided for update' }),
};

const sendQuote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    quoteId: commonSchemas.objectId({ label: 'Quote ID', isRequired: true }),
  }),
};

const updateQuoteStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    quoteId: commonSchemas.objectId({ label: 'Quote ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...Object.values(QUOTE_STATUS))
        .required()
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
      rejectionReason: Joi.when('status', {
        is: QUOTE_STATUS.REJECTED,
        then: Joi.string().trim().required().label('Rejection Reason'),
        otherwise: Joi.string().trim().allow('').optional(),
      }),
    })
    .required(),
};

const deleteQuote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    quoteId: commonSchemas.objectId({ label: 'Quote ID', isRequired: true }),
  }),
};

module.exports = {
  createQuote,
  getQuotes,
  getQuotesExports,
  getQuote,
  updateQuote,
  sendQuote,
  updateQuoteStatus,
  deleteQuote,
};
