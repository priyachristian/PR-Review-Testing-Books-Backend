const Joi = require('joi');
const { commonSchemas, createItemSchema, salesBaseValidationSchema } = require('../../../validations/common.validation');
const { CREDIT_NOTE_TYPE, CREDIT_NOTE_STATUS, ADDRESS_TYPES } = require('../../../utils/enum');
const { objectId } = require('../../../validations/custom.validation');

const createCreditNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: salesBaseValidationSchema.keys({
    creditNoteId: Joi.string(),
    invoiceId: Joi.alternatives()
      .try(
        Joi.string().custom(objectId).label('Invoice ID'),
        Joi.string().allow('').label('Invoice ID'),
        Joi.valid(null).label('Invoice ID'),
      )
      .optional()
      .custom((value, helpers) => {
        const { invoiceNo } = helpers.state.ancestors[0];
        const hasInvoiceId = value !== null && value !== undefined && value !== '';
        const hasInvoiceNo =
          invoiceNo !== null &&
          invoiceNo !== undefined &&
          invoiceNo !== '' &&
          typeof invoiceNo === 'string' &&
          invoiceNo.trim() !== '';

        // If both are provided, return error
        if (hasInvoiceId && hasInvoiceNo) {
          return helpers.error('custom.mutuallyExclusive');
        }

        // If neither is provided, return error
        if (!hasInvoiceId && !hasInvoiceNo) {
          return helpers.error('custom.eitherRequired');
        }

        return value;
      })
      .messages({
        'alternatives.match': '{{#label}} must be a valid ObjectId',
        'custom.mutuallyExclusive': 'Either Invoice ID or Invoice No is required, but not both',
        'custom.eitherRequired': 'Either Invoice ID or Invoice No is required',
      }),
    invoiceNo: Joi.string()
      .label('Invoice No')
      .allow('', null)
      .optional()
      .custom((value, helpers) => {
        const { invoiceId } = helpers.state.ancestors[0];
        const hasInvoiceId = invoiceId !== null && invoiceId !== undefined && invoiceId !== '';
        const hasInvoiceNo =
          value !== null && value !== undefined && value !== '' && typeof value === 'string' && value.trim() !== '';

        // If both are provided, return error
        if (hasInvoiceId && hasInvoiceNo) {
          return helpers.error('custom.mutuallyExclusive');
        }

        // If neither is provided, return error
        if (!hasInvoiceId && !hasInvoiceNo) {
          return helpers.error('custom.eitherRequired');
        }

        return value;
      })
      .messages({
        'string.base': '{{#label}} must be a string',
        'custom.mutuallyExclusive': 'Either Invoice ID or Invoice No is required, but not both',
        'custom.eitherRequired': 'Either Invoice ID or Invoice No is required',
      }),
    referenceNumber: commonSchemas.string({ label: 'Reference Number', allowEmpty: true }),
    creditNoteDate: commonSchemas.date({ label: 'Credit Note Date', isRequired: true }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true }),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    type: Joi.string()
      .valid(...Object.values(CREDIT_NOTE_TYPE))
      .required()
      .label('Credit Note Type')
      .messages({
        'any.required': '{{#label}} is required',
        'any.only': `{{#label}} must be one of: ${Object.values(CREDIT_NOTE_TYPE).join(', ')}`,
      }),
    addressId: commonSchemas.objectId({ label: 'Address ID', isRequired: true }),
    isSplit: Joi.boolean().optional().allow(null),
    rejectionOrderDetails: Joi.object({
      rejectionOrderRef: commonSchemas.objectId({ label: 'Rejection Order ID', isOptional: true }),
      rejectionOrderId: commonSchemas.string({ label: 'Rejection Order No', isOptional: true }),
    })
      .and('rejectionOrderRef', 'rejectionOrderId')
      .optional()
      .allow(null),
  }),
};

const getCreditNotes = {
  query: Joi.object().keys({
    creditNoteId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string(),
    search: Joi.string(),
    creditNoteDate: commonSchemas.date({ label: 'Credit Note Date' }),
    status: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    ...commonSchemas.paginationQuery(),
    ...commonSchemas.dateRangeQuery(),
  }),
};

const getCreditNotesExports = {
  query: Joi.object().keys({
    creditNoteId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string(),
    search: Joi.string(),
    creditNoteDate: commonSchemas.date({ label: 'Credit Note Date' }),
    status: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    sortBy: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
  }),
};

const getCreditNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
};

const updateCreditNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
  body: salesBaseValidationSchema
    .keys({
      invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isOptional: true, allow: [null, ''] }),
      invoiceNo: Joi.string().allow(null, '').label('Invoice No').messages({
        'string.base': '{{#label}} must be a string',
      }),
      referenceNumber: commonSchemas.string({ label: 'Reference Number', allowEmpty: true, isOptional: true }),
      creditNoteDate: commonSchemas.date({ label: 'Credit Note Date', isOptional: true }),
      subject: commonSchemas.string({ label: 'Subject', allowEmpty: true, isOptional: true }),
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
      attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
        'array.base': '{{#label}} must be an array of strings',
      }),
      items: Joi.array()
        .items(createItemSchema({ forCreation: false }))
        .label('Items')
        .messages({
          'array.base': '{{#label}} must be an array of valid items',
        }),
      type: Joi.string()
        .valid(...Object.values(CREDIT_NOTE_TYPE))
        .required()
        .label('Credit Note Type')
        .messages({
          'any.required': '{{#label}} is required',
          'any.only': `{{#label}} must be one of: ${Object.values(CREDIT_NOTE_TYPE).join(', ')}`,
        }),
      addressId: commonSchemas.objectId({ label: 'Address ID', isRequired: false, allow: [null, ''] }),
      isSplit: Joi.boolean().optional().allow(null),
      rejectionOrderDetails: Joi.object({
        rejectionOrderRef: commonSchemas.objectId({ label: 'Rejection Order ID', isOptional: true }),
        rejectionOrderId: commonSchemas.string({ label: 'Rejection Order No', isOptional: true }),
      })
        .and('rejectionOrderRef', 'rejectionOrderId')
        .optional()
        .allow(null),
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the credit note',
    }),
};

const deleteCreditNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
};

const applyCreditNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    applications: Joi.array()
      .items(
        Joi.object({
          invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: false }),
          invoiceNo: commonSchemas.string({ label: 'Invoice No', isRequired: false }),
          openingBalanceTransactionId: commonSchemas.objectId({
            label: 'Opening Balance Transaction ID',
            isRequired: false,
          }),
          transactionNo: commonSchemas.string({ label: 'Transaction No', isRequired: false }),
          amountApplied: commonSchemas.number({ label: 'Amount Applied', isRequired: true }),
        })
          .xor('invoiceId', 'openingBalanceTransactionId')
          .messages({
            'object.missing': 'Each application must include either invoiceId or openingBalanceTransactionId',
            'object.xor': 'Provide either invoiceId or openingBalanceTransactionId, not both',
          }),
      )
      .min(1)
      .label('Applications')
      .messages({
        'array.base': '{{#label}} must be an array of valid applications',
        'array.min': '{{#label}} must contain at least one application',
      }),
  }),
};

const deleteCreditNoteInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      documentId: commonSchemas.objectId({ label: 'Document ID', isRequired: true }),
      invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: false }),
      openingBalanceTransactionId: commonSchemas.objectId({
        label: 'Opening Balance Transaction ID',
        isRequired: false,
      }),
    })
    .xor('invoiceId', 'openingBalanceTransactionId')
    .messages({
      'object.missing': 'Provide either invoiceId or openingBalanceTransactionId',
      'object.xor': 'Provide either invoiceId or openingBalanceTransactionId, not both',
    }),
};

const updateCreditNoteStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    status: Joi.string()
      .valid(...Object.keys(CREDIT_NOTE_STATUS))
      .required()
      .label('Invoice Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
  }),
};

const createCreditNoteRefund = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    refundAmount: commonSchemas.number({ label: 'Refund Amount', isRequired: true }).min(0.01),
    refundDate: commonSchemas.date({ label: 'Refund Date', isRequired: true }),
    fromAccountId: commonSchemas.objectId({ label: 'From Account', isRequired: true }),
    reference: commonSchemas.string({ label: 'Reference', allowEmpty: true }),
    notes: commonSchemas.string({ label: 'Notes', allowEmpty: true }),
  }),
};

const deleteCreditNoteRefund = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditNoteId: commonSchemas.objectId({ label: 'Credit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    refundId: commonSchemas.objectId({ label: 'Refund ID', isRequired: true }),
  }),
};

module.exports = {
  createCreditNote,
  getCreditNotes,
  getCreditNotesExports,
  getCreditNote,
  updateCreditNote,
  deleteCreditNote,
  applyCreditNote,
  deleteCreditNoteInvoice,
  updateCreditNoteStatus,
  createCreditNoteRefund,
  deleteCreditNoteRefund,
};
