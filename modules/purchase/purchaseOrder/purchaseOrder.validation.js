const Joi = require('joi');
const { PO_STATUSES, ADDRESS_TYPES } = require('../../../utils/enum');
const {
  commonSchemas,
  createItemSchema,
  baseValidationSchema,
  discountValidation,
  commaSeparatedObjectIds,
  purchaseActivationKeys,
} = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

const convertedToSchema = Joi.object({
  type: Joi.string().valid('GRPO', 'BILL').required().label('Conversion Type').messages({
    'any.required': '{{#label}} is required',
    'any.only': '{{#label}} must be either "GRPO" or "BILL"',
  }),
  documentId: commonSchemas.objectId({ label: 'Document ID', isRequired: true }),
  documentNo: commonSchemas.string({ label: 'Document Number', isRequired: true }),
  convertedAt: commonSchemas.date({ label: 'Converted At', isOptional: true }).default(Date.now),
}).label('Converted To Entry');

const purchaseOrderBaseSchema = baseValidationSchema.keys({
  vendor: commonSchemas.objectId({ label: 'Vendor', isRequired: true }),
});

const createPurchaseOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: purchaseOrderBaseSchema.keys({
    purchaseOrderId: Joi.string().required(),
    reference: commonSchemas.string({ label: 'Reference', allowEmpty: true }),
    status: Joi.string()
      .valid(...Object.values(PO_STATUSES))
      .default(PO_STATUSES.DRAFT)
      .optional()
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    batchNo: commonSchemas.string({ label: 'Batch No', allowEmpty: true }),
    date: commonSchemas.date({ label: 'Date', required: true }).allow(null),
    deliveryDate: commonSchemas.date({ label: 'Delivery Date', required: true }).allow(null),
    paymentTermsId: Joi.string()
      .custom(objectId)
      .label('Payment Terms')
      .messages({
        'string.objectId': '{{#label}} must be a valid ObjectId',
      })
      .required(),
    shipmentPreference: commonSchemas.string({ label: 'Shipment Preference', allowEmpty: true }),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    convertedTo: Joi.array().items(convertedToSchema).optional().label('Converted To'),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    customer: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
    ...purchaseActivationKeys,
  }),
};

const getPurchaseOrderValidation = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    customerId: Joi.string(),
    page: Joi.number().integer(),
    search: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    date: commonSchemas.date({ label: 'Date' }),
    status: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
  }),
};

const getPurchaseOrdersExports = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    search: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    date: commonSchemas.date({ label: 'Date' }),
    status: Joi.string(),
    customerId: Joi.string().custom(commaSeparatedObjectIds).allow('').label('Customer ID'),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
  }),
};
const updatePurchaseOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Purchase Order ID', isRequired: true }),
  }),
  body: purchaseOrderBaseSchema
    .keys({
      purchaseOrderId: commonSchemas.objectId({ label: 'Purchase Order ID', isOptional: true }),
      reference: commonSchemas.string({ label: 'Reference', allowEmpty: true, isOptional: true }),
      status: Joi.string()
        .valid(...Object.values(PO_STATUSES))
        .optional()
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
      batchNo: commonSchemas.string({ label: 'Batch No', allowEmpty: true, isOptional: true }),
      date: commonSchemas.date({ label: 'Date', isOptional: true }).allow(null),
      deliveryDate: commonSchemas.date({ label: 'Delivery Date', isOptional: true }).allow(null),
      paymentTermsId: Joi.string()
        .custom(objectId)
        .label('Payment Terms')
        .messages({
          'string.objectId': '{{#label}} must be a valid ObjectId',
        })
        .optional(),
      shipmentPreference: commonSchemas.string({
        label: 'Shipment Preference',
        allowEmpty: true,
        isOptional: true,
      }),
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
      convertedTo: Joi.array().items(convertedToSchema).optional().label('Converted To'),
      items: Joi.array()
        .items(createItemSchema({ forCreation: false }))
        .label('Items')
        .messages({
          'array.base': '{{#label}} must be an array of valid items',
        }),
      discountConfig: discountValidation,
      appliesTo: Joi.string().optional().allow(null, ''),
      addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
        'any.required': '{{#label}} is required',
        'string.objectId': '{{#label}} must be a valid ObjectId',
      }),
      customer: commonSchemas.objectId({ label: 'Customer', isOptional: true, allow: [null, ''] }),
      ...purchaseActivationKeys,
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the purchase order',
    }),
};

const deletePurchaseOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Purchase Order ID', isRequired: true }),
  }),
};

const updatePurchaseOrderStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    purchaseOrderId: commonSchemas.objectId({ label: 'Purchase Order ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...Object.keys(PO_STATUSES))
        .label('Purchase Order Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        })
        .required(),
    })
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the purchase order status',
    }),
};

const getPurchaseOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Purchase Order ID', isRequired: true }),
  }),
};

const getPurchaseOrderConvertDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    vendor: commonSchemas.objectId({ label: 'Vendor ID', isRequired: true }),
    pagination: Joi.boolean(),
    status: Joi.string(),
  }),
};

const partiallyConvertedItemList = {
  query: Joi.object().keys({
    id: Joi.string().required(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

module.exports = {
  createPurchaseOrder,
  getPurchaseOrderValidation,
  getPurchaseOrdersExports,
  updatePurchaseOrder,
  deletePurchaseOrder,
  updatePurchaseOrderStatus,
  getPurchaseOrder,
  getPurchaseOrderConvertDropdown,
  partiallyConvertedItemList,
};
