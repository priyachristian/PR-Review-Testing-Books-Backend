const Joi = require('joi');
const { GRPO_STATUSES, ADDRESS_TYPES } = require('../../../utils/enum');
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
  type: Joi.string().valid('BILL').required().label('Conversion Type').messages({
    'any.required': '{{#label}} is required',
    'any.only': '{{#label}} must be "BILL"',
  }),
  documentId: commonSchemas.objectId({ label: 'Document ID', isRequired: true }),
  documentNo: commonSchemas.string({ label: 'Document Number', isRequired: true }),
  convertedAt: commonSchemas.date({ label: 'Converted At', isOptional: true }).default(Date.now),
}).label('Converted To Entry');

const grpoOrderBaseSchema = baseValidationSchema.keys({
  vendor: commonSchemas.objectId({ label: 'Vendor', isRequired: true }),
});

const createGrpoOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: grpoOrderBaseSchema.keys({
    grpoOrderId: Joi.string().required(),
    reference: commonSchemas.string({ label: 'Reference', allowEmpty: true }),
    status: Joi.string()
      .valid(...Object.values(GRPO_STATUSES))
      .default(GRPO_STATUSES.DRAFT)
      .optional()
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    batchNo: commonSchemas.string({ label: 'Batch No', allowEmpty: true }),
    date: commonSchemas.date({ label: 'Date', required: true }).allow(null),
    dueDate: commonSchemas.date({ label: 'Due Date', required: true }).allow(null),
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
    addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    customer: Joi.string().optional().allow(null, '').custom(objectId).label('Customer').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    isInventoryEnabled: Joi.boolean().required(),
    ...purchaseActivationKeys,
  }),
};

const getGrpoOrder = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    date: commonSchemas.date({ label: 'Date' }),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    status: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const getGrpoOrdersExports = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string().custom(commaSeparatedObjectIds).allow('').label('Customer ID'),
    sortBy: Joi.string(),
    search: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    date: commonSchemas.date({ label: 'Date' }),
    branchId: Joi.string(),
    divisionId: Joi.string(),
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
const updateGrpoOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Grpo Order ID', isRequired: true }),
  }),
  body: grpoOrderBaseSchema
    .keys({
      reference: commonSchemas.string({ label: 'Reference', allowEmpty: true, isOptional: true }),
      status: Joi.string()
        .valid(...Object.values(GRPO_STATUSES))
        .optional()
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
      batchNo: commonSchemas.string({ label: 'Batch No', allowEmpty: true, isOptional: true }),
      date: commonSchemas.date({ label: 'Date', isOptional: true }).allow(null),
      dueDate: commonSchemas.date({ label: 'Due Date', isOptional: true }).allow(null),
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
      addressId: Joi.string().optional().allow(null, '').custom(objectId).label('Address').messages({
        'any.required': '{{#label}} is required',
        'string.objectId': '{{#label}} must be a valid ObjectId',
      }),
      customer: Joi.string().optional().allow(null, '').custom(objectId).label('Customer').messages({
        'any.required': '{{#label}} is required',
        'string.objectId': '{{#label}} must be a valid ObjectId',
      }),
      isInventoryEnabled: Joi.boolean().required(),
      ...purchaseActivationKeys,
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the GRPO order',
    }),
};

const deleteGrpoOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Grpo Order ID', isRequired: true }),
  }),
};

const updateGrpoOrderStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    grpoOrderId: commonSchemas.objectId({ label: 'Grpo Order ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...Object.keys(GRPO_STATUSES))
        .label('Grpo Order Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
    })
    .required()
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the GRPO order status',
    }),
};

const getGrpoOrderById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: commonSchemas.objectId({ label: 'Grpo Order ID', isRequired: true }),
  }),
};

const grpofromPurchaseOrder = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    vendor: commonSchemas.objectId({ label: 'Vendor ID', isRequired: true }),
  }),
};

const grpoItems = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    id: Joi.string().required(),
  }),
};

module.exports = {
  createGrpoOrder,
  getGrpoOrder,
  getGrpoOrdersExports,
  updateGrpoOrder,
  deleteGrpoOrder,
  updateGrpoOrderStatus,
  getGrpoOrderById,
  grpofromPurchaseOrder,
  grpoItems,
};
