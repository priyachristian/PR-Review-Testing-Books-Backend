const Joi = require('joi');
const { BILL_STATUSES, ADDRESS_TYPES } = require('../../../utils/enum');
const {
  commonSchemas,
  createItemSchema,
  baseValidationSchema,
  discountValidation,
  commaSeparatedObjectIds,
  purchaseActivationKeys,
} = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

const billBaseSchema = baseValidationSchema.keys({
  vendor: commonSchemas.objectId({ label: 'Vendor', isRequired: true }),
});

const splitSchema = Joi.object({
  splitWiseType: Joi.string().valid('Split By Qty', 'Split By Price').required().label('Split Wise Type'),
  items: Joi.array()
    .items(createItemSchema({ forCreation: true }))
    .label('Split Items')
    .messages({
      'array.base': '{{#label}} must be an array of valid items',
    }),
  subTotal: Joi.number().required().label('Split SubTotal'),
  cgst: Joi.number().required().label('Split CGST'),
  sgst: Joi.number().required().label('Split SGST'),
  igst: Joi.number().required().label('Split IGST'),
  totalTax: Joi.number().required().label('Split Tax Total'),
  total: Joi.number().required().label('Split Total'),
  isRoundOff: Joi.boolean().default(true).label('Is Round Off'),
  roundOffAmount: commonSchemas.number({ label: 'Round Off Amount', allowEmpty: true }),
});

const createBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: billBaseSchema.keys({
    billId: Joi.string().required(),
    billDate: commonSchemas.date({ label: 'Bill Date', isRequired: true }),
    dueDate: commonSchemas.date({ label: 'Due Date', isOptional: true }).allow(null),
    paymentTermsId: Joi.string().custom(objectId).required().label('Payment Terms').messages({
      'string.objectId': '{{#label}} must be a valid ObjectId',
      'any.required': '{{#label}} is required',
    }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true }),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    status: Joi.string()
      .valid(...Object.values(BILL_STATUSES))
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    paidAmount: commonSchemas.number({ label: 'Paid Amount', isOptional: true }).min(0),
    purchaseOrders: Joi.alternatives()
      .try(
        Joi.array().items(
          Joi.object({
            purchaseOrderId: commonSchemas.objectId({ label: 'Purchase Order ID' }),
            purchaseOrderNo: commonSchemas.string({ label: 'Purchase Order No' }),
          }),
        ),
        Joi.valid(null),
      )
      .optional()
      .label('Purchase Orders')
      .messages({
        'array.base': '{{#label}} must be an array of purchase order objects or null',
        'object.base': 'Each item in {{#label}} must be an object',
      }),
    isSplit: Joi.boolean().optional().allow(null),
    split: Joi.when('isSplit', {
      is: true,
      then: splitSchema.required(),
      otherwise: Joi.forbidden(),
    }),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    customer: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
    grpoIds: Joi.alternatives()
      .try(
        Joi.array().items(
          Joi.object({
            grpoId: commonSchemas.objectId({ label: 'Grpo ID' }),
            grpoNo: commonSchemas.string({ label: 'Grpo No' }),
          }),
        ),
        Joi.valid(null),
      )
      .optional()
      .label('GrpoOrder')
      .messages({
        'array.base': '{{#label}} must be an array of GrpoOrder objects or null',
        'object.base': 'Each item in {{#label}} must be an object',
      }),
    isInventoryEnabled: Joi.boolean().required(),
    ...purchaseActivationKeys,
  }),
};

const getBills = {
  query: Joi.object().keys({
    billId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    isSplit: Joi.boolean().optional().allow(null),
    customerId: Joi.string(),
    status: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    billDate: commonSchemas.date({ label: 'Bill Date' }),
    search: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    ...commonSchemas.paginationQuery(),
  }),
};

const getBillsExports = {
  query: Joi.object().keys({
    billId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    isSplit: Joi.boolean().optional().allow(null),
    customerId: Joi.string().custom(commaSeparatedObjectIds).allow('').label('Customer ID'),
    status: Joi.string(),
    billDate: commonSchemas.date({ label: 'Bill Date' }),
    search: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    sortBy: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    ...commonSchemas.dateRangeQuery(),
  }),
};
const getBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
  }),
};

const getVendorWisePendingBills = {
  params: Joi.object().keys({
    vendorId: commonSchemas.objectId({ label: 'Vendor ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    pagination: Joi.boolean(),
    isAdd: Joi.boolean(),
    forCreditMapping: Joi.boolean(),
    allowCrossBranchMapping: Joi.boolean(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    isSplit: Joi.boolean().optional().allow(null),
    branchId: commonSchemas.objectId({ label: 'Branch ID', isOptional: true }),
    warehouseId: commonSchemas.objectId({ label: 'Warehosue ID', isOptional: true }),
    divisionId: commonSchemas.objectId({ label: 'Division ID', isOptional: true }),
  }),
};

const applyVendorCreditToBill = {
  params: Joi.object().keys({
    vendorId: commonSchemas.objectId({ label: 'Vendor ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    branchId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    applications: Joi.array()
      .items(
        Joi.object({
          openingBalanceTransactionId: commonSchemas.objectId({ label: 'Credit Transaction ID', isRequired: true }),
          billId: commonSchemas.objectId({ label: 'Bill ID', isOptional: true }),
          targetOpeningBalanceTransactionId: commonSchemas.objectId({ label: 'Opening Balance Target ID', isOptional: true }),
          amountApplied: commonSchemas
            .number({ label: 'Amount Applied', isRequired: true })
            .positive()
            .messages({ 'number.positive': '{{#label}} must be greater than zero' }),
        })
          .xor('billId', 'targetOpeningBalanceTransactionId')
          .messages({ 'object.xor': 'Provide either bill or opening balance target' }),
      )
      .min(1)
      .required()
      .label('Applications'),
    contextBillId: commonSchemas.objectId({ label: 'Context Bill ID', isOptional: true }),
  }),
};

const getPendingBills = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    vendor: commonSchemas.objectId({ label: 'Vendor', isRequired: true }),
    branchId: commonSchemas.objectId({ label: 'Branch ID', isOptional: true }),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).optional(),
    sortBy: Joi.string().optional(),
    populate: Joi.string().optional(),
    isSplit: Joi.boolean().optional().allow(null),
    forCreditMapping: Joi.boolean(),
    allowCrossBranchMapping: Joi.boolean(),
    creditBranchId: commonSchemas.objectId({ label: 'Credit Branch ID', isOptional: true }),
  }),
};

const getBillsDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    vendor: commonSchemas.objectId({ label: 'Vendor', isOptional: true }),
    search: Joi.string().allow(''),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const updateBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
  }),
  body: billBaseSchema
    .keys({
      billDate: commonSchemas.date({ label: 'Bill Date', isOptional: true }),
      dueDate: commonSchemas.date({ label: 'Due Date', isOptional: true }).allow(null),
      paymentTermsId: Joi.string()
        .custom(objectId)
        .label('Payment Terms')
        .messages({
          'string.objectId': '{{#label}} must be a valid ObjectId',
        })
        .optional(),
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
      status: Joi.string()
        .valid(...Object.values(BILL_STATUSES))
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        })
        .optional(),
      paidAmount: commonSchemas.number({ label: 'Paid Amount', isOptional: true }).min(0),
      items: Joi.array()
        .items(createItemSchema({ forCreation: false }))
        .label('Items')
        .messages({
          'array.base': '{{#label}} must be an array of valid items',
        }),
      purchaseOrders: Joi.alternatives()
        .try(
          Joi.array().items(
            Joi.object({
              purchaseOrderId: commonSchemas.objectId({ label: 'Purchase Order ID' }),
              purchaseOrderNo: commonSchemas.string({ label: 'Purchase Order No' }),
            }),
          ),
          Joi.valid(null),
        )
        .optional()
        .label('Purchase Orders')
        .messages({
          'array.base': '{{#label}} must be an array of purchase order objects or null',
          'object.base': 'Each item in {{#label}} must be an object',
        }),
      discountConfig: discountValidation,
      appliesTo: Joi.string().optional().allow(null, ''),
      isSplit: Joi.boolean().optional().allow(null),
      addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
        'any.required': '{{#label}} is required',
        'string.objectId': '{{#label}} must be a valid ObjectId',
      }),
      customer: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
      grpoIds: Joi.alternatives()
        .try(
          Joi.array().items(
            Joi.object({
              grpoId: commonSchemas.objectId({ label: 'Grpo ID' }),
              grpoNo: commonSchemas.string({ label: 'Grpo No' }),
            }),
          ),
          Joi.valid(null),
        )
        .optional()
        .label('GrpoOrder')
        .messages({
          'array.base': '{{#label}} must be an array of GrpoOrder objects or null',
          'object.base': 'Each item in {{#label}} must be an object',
        }),
      isInventoryEnabled: Joi.boolean().required(),
      ...purchaseActivationKeys,
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the bill',
    }),
};

const deleteBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
  }),
};

const updateBillStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    status: Joi.string()
      .valid(...Object.values(BILL_STATUSES))
      .label('Status')
      .required()
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
  }),
};

const paymentHistoryForBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
  }),
};

const createSplitBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: billBaseSchema.keys({
    billId: Joi.string().required(),
    billDate: commonSchemas.date({ label: 'Bill Date', isRequired: true }),
    dueDate: commonSchemas.date({ label: 'Due Date', isOptional: true }).allow(null),
    paymentTermsId: Joi.string().custom(objectId).required().label('Payment Terms').messages({
      'string.objectId': '{{#label}} must be a valid ObjectId',
      'any.required': '{{#label}} is required',
    }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true }),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    status: Joi.string()
      .valid(...Object.values(BILL_STATUSES))
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    paidAmount: commonSchemas.number({ label: 'Paid Amount', isOptional: true }).min(0),
    isSplit: Joi.boolean().optional().allow(null),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    customer: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
    isInventoryEnabled: Joi.boolean().required(),
  }),
};

const getPaymentHistoryForBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
  }),
};

const removeOpeningBalanceApplicationFromBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
    applicationId: commonSchemas.objectId({ label: 'Application ID', isRequired: true }),
  }),
};

const removeOpeningBalanceApplicationFromOb = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    creditTxnId: commonSchemas.objectId({ label: 'Credit Opening Balance ID', isRequired: true }),
    applicationId: commonSchemas.objectId({ label: 'Application ID', isRequired: true }),
  }),
};

const autoMapOpeningBalanceToBills = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    vendorId: Joi.string().custom(objectId),
    branchId: Joi.string().custom(objectId),
    isSplit: Joi.boolean(),
  }),
};
module.exports = {
  createBill,
  getBills,
  getBillsExports,
  getBill,
  getVendorWisePendingBills,
  applyVendorCreditToBill,
  getPendingBills,
  getBillsDropdown,
  updateBill,
  deleteBill,
  updateBillStatus,
  paymentHistoryForBill,
  createSplitBill,
  getPaymentHistoryForBill,
  removeOpeningBalanceApplicationFromBill,
  removeOpeningBalanceApplicationFromOb,
  autoMapOpeningBalanceToBills,
};
