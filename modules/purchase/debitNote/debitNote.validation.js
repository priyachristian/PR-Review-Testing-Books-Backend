const Joi = require('joi');
const {
  commonSchemas,
  createItemSchema,
  baseValidationSchema,
  purchaseActivationKeys,
} = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');
const { DEBIT_NOTE_STATUS, CREDIT_NOTE_TYPE, ADDRESS_TYPES } = require('../../../utils/enum');

const debitNoteBaseSchema = baseValidationSchema.keys({
  vendorId: commonSchemas.objectId({ label: 'Vendor ID', isRequired: true }),
});

const createDebitNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: debitNoteBaseSchema.keys({
    debitNoteId: Joi.string(),
    billId: commonSchemas.objectId({ label: 'Bill ID', isOptional: true, allow: [null, ''] }),
    billNo: Joi.string().allow(null, '').label('Bill No').messages({
      'string.base': '{{#label}} must be a string',
    }),
    referenceNumber: commonSchemas.string({ label: 'Reference Number', allowEmpty: true }),
    debitNoteDate: commonSchemas.date({ label: 'Debit Note Date', isRequired: true }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true }),
    notes: commonSchemas.string({ label: 'Notes', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string().label('Attachment')).label('Attachments'),
    addressId: commonSchemas.objectId({ label: 'Address ID', isOptional: false }),
    customer: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
    termsAndConditions: Joi.string().allow(null, '').label('Terms and Conditions').messages({
      'string.base': '{{#label}} must be a string',
    }),
    type: Joi.string()
      .valid(...Object.values(CREDIT_NOTE_TYPE))
      .required()
      .label('Debit Note Type')
      .messages({
        'any.required': '{{#label}} is required',
        'any.only': `{{#label}} must be one of: ${Object.values(CREDIT_NOTE_TYPE).join(', ')}`,
      }),
    isSplit: Joi.boolean().optional().allow(null),
    ...purchaseActivationKeys,
  }),
};

const getDebitNotes = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID' }),
    customerId: Joi.string(),
    search: Joi.string(),
    debitNoteDate: commonSchemas.date({ label: 'Debit Note Date' }),
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
    ...commonSchemas.dateRangeQuery(),
    ...commonSchemas.paginationQuery(),
  }),
};

const getDebitNotesExports = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID' }),
    customerId: Joi.string(),
    search: Joi.string(),
    debitNoteDate: commonSchemas.date({ label: 'Debit Note Date' }),
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

const getDebitNoteById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
};

const updateDebitNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
  body: debitNoteBaseSchema.keys({
    vendorId: commonSchemas.objectId({ label: 'Vendor ID', isOptional: true }),
    billId: Joi.alternatives()
      .try(
        Joi.string().custom(objectId).label('Bill ID'),
        Joi.string().allow('').label('Bill ID'),
        Joi.valid(null).label('Bill ID'),
      )
      .optional()
      .custom((value, helpers) => {
        const { billNo } = helpers.state.ancestors[0];
        const hasBillId = value !== null && value !== undefined && value !== '';
        const hasBillNo =
          billNo !== null && billNo !== undefined && billNo !== '' && typeof billNo === 'string' && billNo.trim() !== '';

        // Only validate mutual exclusivity if at least one has a value
        // For updates, if both are empty, that's acceptable (not updating these fields)
        if (hasBillId || hasBillNo) {
          // If both are provided, return error
          if (hasBillId && hasBillNo) {
            return helpers.error('custom.mutuallyExclusive');
          }
        }

        return value;
      })
      .messages({
        'alternatives.match': '{{#label}} must be a valid ObjectId',
        'custom.mutuallyExclusive': 'Either Bill ID or Bill No is required, but not both',
      }),
    billNo: Joi.string()
      .label('Bill No')
      .allow('', null)
      .optional()
      .custom((value, helpers) => {
        const { billId } = helpers.state.ancestors[0];
        const hasBillId = billId !== null && billId !== undefined && billId !== '';
        const hasBillNo =
          value !== null && value !== undefined && value !== '' && typeof value === 'string' && value.trim() !== '';

        // Only validate mutual exclusivity if at least one has a value
        // For updates, if both are empty, that's acceptable (not updating these fields)
        if (hasBillId || hasBillNo) {
          // If both are provided, return error
          if (hasBillId && hasBillNo) {
            return helpers.error('custom.mutuallyExclusive');
          }
        }

        return value;
      })
      .messages({
        'string.base': '{{#label}} must be a string',
        'custom.mutuallyExclusive': 'Either Bill ID or Bill No is required, but not both',
      }),
    referenceNumber: commonSchemas.string({
      label: 'Reference Number',
      allowEmpty: true,
      isOptional: true,
    }),
    debitNoteDate: commonSchemas.date({ label: 'Debit Note Date', isOptional: true }),
    items: Joi.array()
      .items(createItemSchema({ forCreation: false }))
      .label('Items')
      .messages({
        'array.base': '{{#label}} must be an array of valid items',
      }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true, isOptional: true }),
    notes: commonSchemas.string({ label: 'Notes', allowEmpty: true, isOptional: true }),
    attachments: Joi.array().items(Joi.string().label('Attachment')).label('Attachments'),
    addressId: commonSchemas.objectId({ label: 'Address ID', isOptional: false }),
    customer: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
    termsAndConditions: Joi.string().allow(null, '').label('Terms and Conditions').messages({
      'string.base': '{{#label}} must be a string',
    }),
    type: Joi.string()
      .valid(...Object.values(CREDIT_NOTE_TYPE))
      .required()
      .label('Debit Note Type')
      .messages({
        'any.required': '{{#label}} is required',
        'any.only': `{{#label}} must be one of: ${Object.values(CREDIT_NOTE_TYPE).join(', ')}`,
      }),
    isSplit: Joi.boolean().optional().allow(null),
    ...purchaseActivationKeys,
  }),
};

const deleteDebitNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
};

const applyDebitNote = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    debitNoteId: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    applications: Joi.array()
      .items(
        Joi.object({
          billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: false }),
          billNo: commonSchemas.string({ label: 'Bill No', isRequired: false }),
          openingBalanceTransactionId: commonSchemas.objectId({
            label: 'Opening Balance Transaction ID',
            isRequired: false,
          }),
          transactionNo: commonSchemas.string({ label: 'Transaction No', isRequired: false }),
          amountApplied: commonSchemas.number({ label: 'Amount Applied', isRequired: true }).min(0),
        })
          .xor('billId', 'openingBalanceTransactionId')
          .messages({
            'object.missing': 'Each application must include either billId or openingBalanceTransactionId',
            'object.xor': 'Provide either billId or openingBalanceTransactionId, not both',
          }),
      )
      .min(1)
      .label('Applications'),
  }),
};

const deleteDebitNoteBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    debitNoteId: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: false }),
      documentId: commonSchemas.objectId({ label: 'Document ID', isRequired: true }),
      openingBalanceTransactionId: commonSchemas.objectId({
        label: 'Opening Balance Transaction ID',
        isRequired: false,
      }),
    })
    .xor('billId', 'openingBalanceTransactionId')
    .messages({
      'object.missing': 'Provide either billId or openingBalanceTransactionId',
      'object.xor': 'Provide either billId or openingBalanceTransactionId, not both',
    }),
};

const updateDebitNoteNoteStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    debitNoteId: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    status: Joi.string()
      .valid(...Object.keys(DEBIT_NOTE_STATUS))
      .required()
      .label('Debit Note Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
  }),
};

const createDebitNoteRefund = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    debitNoteId: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    refundAmount: commonSchemas.number({ label: 'Refund Amount', isRequired: true }).min(0.01),
    refundDate: commonSchemas.date({ label: 'Refund Date', isRequired: true }),
    toAccountId: commonSchemas.objectId({ label: 'To Account', isRequired: true }),
    reference: commonSchemas.string({ label: 'Reference', allowEmpty: true }),
    notes: commonSchemas.string({ label: 'Notes', allowEmpty: true }),
  }),
};

const deleteDebitNoteRefund = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    debitNoteId: commonSchemas.objectId({ label: 'Debit Note ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    refundId: commonSchemas.objectId({ label: 'Refund ID', isRequired: true }),
  }),
};

module.exports = {
  createDebitNote,
  getDebitNotes,
  getDebitNotesExports,
  getDebitNoteById,
  updateDebitNote,
  deleteDebitNote,
  applyDebitNote,
  deleteDebitNoteBill,
  updateDebitNoteNoteStatus,
  createDebitNoteRefund,
  deleteDebitNoteRefund,
};
