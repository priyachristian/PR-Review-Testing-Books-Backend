const Joi = require('joi');
const { DELIVERY_CHALLAN_STATUS, ADDRESS_TYPES } = require('../../../utils/enum');
const {
  commonSchemas,
  createItemSchema,
  salesBaseValidationSchema,
  discountValidation,
  commaSeparatedObjectIds,
} = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

// Source of an internal stock transfer, required when isStockTransfer is true. The challan's own division, branch
// and warehouse are the destination, so the From warehouse must differ from it.
const stockTransferSource = Joi.object({
  fromDivisionId: commonSchemas.objectId({ label: 'From Division', isRequired: true }),
  fromBranchId: commonSchemas.objectId({ label: 'From Branch', isRequired: true }),
  fromWarehouseId: commonSchemas
    .objectId({ label: 'From Warehouse', isRequired: true })
    .invalid(Joi.ref('...warehouseId'))
    .messages({ 'any.invalid': 'From Warehouse and To Warehouse must be different' }),
}).label('Stock Transfer');

const stockTransferFields = {
  isStockTransfer: Joi.boolean().optional().label('Internal Stock Transfer'),
  stockTransfer: Joi.when('isStockTransfer', {
    is: true,
    then: stockTransferSource.required(),
    otherwise: Joi.valid(null).optional(),
  }),
};

const createDeliveryChallan = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: salesBaseValidationSchema.keys({
    challanId: Joi.string(),
    reference: commonSchemas.string({ label: 'Reference', allowEmpty: true }),
    challanDate: commonSchemas.date({ label: 'Challan Date', isRequired: true }),
    challanType: commonSchemas.string({ label: 'Challan Type', isRequired: true }),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    freightCharges: commonSchemas.number({ label: 'Freight Charges', isOptional: true }),
    paymentTermsId: Joi.string().custom(objectId).allow(null).label('Payment Terms').messages({
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    status: Joi.string()
      .valid(...Object.keys(DELIVERY_CHALLAN_STATUS))
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    salesOrders: Joi.alternatives()
      .try(
        Joi.array().items(
          Joi.object({
            salesOrderId: commonSchemas.objectId({ label: 'Sales Order ID' }),
            salesOrderNo: commonSchemas.string({ label: 'Sales Order No' }),
          }),
        ),
        Joi.valid(null),
      )
      .optional()
      .label('Sales Orders')
      .messages({
        'array.base': '{{#label}} must be an array of sales order objects or null',
        'object.base': 'Each item in {{#label}} must be an object',
      }),
    priceListId: Joi.string().custom(objectId).allow(null).optional(),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: commonSchemas.objectId({ label: 'Address ID', isOptional: false, allow: [null, ''] }),
    ...stockTransferFields,
  }),
};

const getDeliveryChallans = {
  query: Joi.object().keys({
    challanId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    status: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    challanDate: commonSchemas.date({ label: 'Challan Date' }),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const getDeliveryChallansExports = {
  query: Joi.object().keys({
    challanId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string().custom(commaSeparatedObjectIds).allow('').label('Customer ID'),
    sortBy: Joi.string(),
    search: Joi.string(),
    status: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    ...commonSchemas.dateRangeQuery(),
    challanDate: commonSchemas.date({ label: 'Challan Date' }),
  }),
};
const getDeliveryChallan = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    challanId: commonSchemas.objectId({ label: 'Challan ID', isRequired: true }),
  }),
};

const updateDeliveryChallan = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    challanId: commonSchemas.objectId({ label: 'Challan ID', isRequired: true }),
  }),
  body: salesBaseValidationSchema
    .keys({
      reference: commonSchemas.string({ label: 'Reference', allowEmpty: true, isOptional: true }),
      challanDate: commonSchemas.date({ label: 'Challan Date', isOptional: true }),
      challanType: commonSchemas.string({ label: 'Challan Type', isOptional: true }),
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
      freightCharges: commonSchemas.number({ label: 'Freight Charges', isOptional: true }),
      paymentTermsId: Joi.string()
        .custom(objectId)
        .allow(null)
        .label('Payment Terms')
        .messages({
          'string.objectId': '{{#label}} must be a valid ObjectId',
        })
        .optional(),
      status: Joi.string()
        .valid(...Object.keys(DELIVERY_CHALLAN_STATUS))
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        })
        .optional(),
      items: Joi.array()
        .items(createItemSchema({ forCreation: false }))
        .label('Items')
        .messages({
          'array.base': '{{#label}} must be an array of valid items',
        }),
      salesOrders: Joi.alternatives()
        .try(
          Joi.array().items(
            Joi.object({
              salesOrderId: commonSchemas.objectId({ label: 'Sales Order ID' }),
              salesOrderNo: commonSchemas.string({ label: 'Sales Order No' }),
            }),
          ),
          Joi.valid(null),
        )
        .optional()
        .label('Sales Orders')
        .messages({
          'array.base': '{{#label}} must be an array of sales order objects or null',
          'object.base': 'Each item in {{#label}} must be an object',
        }),
      priceListId: Joi.string().custom(objectId).allow(null).optional(),
      discountConfig: discountValidation,
      appliesTo: Joi.string().optional().allow(null, ''),
      addressId: commonSchemas.objectId({ label: 'Address ID', isOptional: true, allow: [null, ''] }),
      ...stockTransferFields,
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the delivery challan',
    }),
};

const deleteDeliveryChallan = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    challanId: commonSchemas.objectId({ label: 'Challan ID', isRequired: true }),
  }),
};

const updateDeliveryChallanStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    challanId: commonSchemas.objectId({ label: 'Challan ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...Object.keys(DELIVERY_CHALLAN_STATUS))
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
    })
    .required()
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the delivery challan',
    }),
};

const deliveryChallanfromSalesOrder = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
  }),
};

const deliveryChallanItems = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    challanId: Joi.string().required(),
  }),
};
module.exports = {
  createDeliveryChallan,
  getDeliveryChallans,
  getDeliveryChallansExports,
  getDeliveryChallan,
  updateDeliveryChallan,
  deleteDeliveryChallan,
  updateDeliveryChallanStatus,
  deliveryChallanfromSalesOrder,
  deliveryChallanItems,
};
