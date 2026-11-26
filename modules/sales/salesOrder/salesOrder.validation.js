const Joi = require('joi');
const { SALES_ORDER_STATUS, ADDRESS_TYPES, SALES_ORDER_MATERIAL_STATUS } = require('../../../utils/enum');
const {
  commonSchemas,
  createItemSchema,
  salesBaseValidationSchema,
  discountValidation,
  commaSeparatedObjectIds,
} = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

// Allowed only when converting a customer order.
const portalConversionFlag = Joi.when('customerOrderId', { is: Joi.exist(), then: Joi.boolean(), otherwise: Joi.forbidden() });

const createSalesOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: salesBaseValidationSchema.keys({
    orderId: Joi.string(),
    tagId: commonSchemas.objectId({ label: 'Tag ID', isOptional: true }),
    quoteId: commonSchemas.objectId({ label: 'Quote ID', isOptional: true }),
    quoteNo: commonSchemas.string({ label: 'Quote No', isOptional: true }),
    customerOrderId: commonSchemas.objectId({ label: 'Customer Order ID', isOptional: true }),
    customerOrderNo: commonSchemas.string({ label: 'Customer Order No', isOptional: true }),
    // Portal order conversion only: user confirmed linking the customer to the selected branch.
    activateCustomerBranch: portalConversionFlag,
    // Portal order conversion only: user confirmed making the order's items available in the selected warehouse.
    activateItemWarehouse: portalConversionFlag,
    rejectionOrderDetails: Joi.object({
      rejectionOrderRef: commonSchemas.objectId({ label: 'Rejection Order ID', isOptional: true }),
      rejectionOrderId: commonSchemas.string({ label: 'Rejection Order No', isOptional: true }),
    })
      .and('rejectionOrderRef', 'rejectionOrderId')
      .optional()
      .allow(null),
    reference: commonSchemas.string({ label: 'Reference', allowEmpty: true }),
    orderDate: commonSchemas.date({ label: 'Order Date', isRequired: true }),
    expectedShipmentDate: commonSchemas.date({ label: 'Expected Shipment Date', isOptional: true }).allow(null),
    status: Joi.string()
      .valid(...Object.keys(SALES_ORDER_STATUS))
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    paymentTermsId: Joi.string().custom(objectId).allow(null).label('Payment Terms').messages({
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
    deliveryMethod: commonSchemas.string({ label: 'Delivery Method', isOptional: true }).allow(null),
    priceListId: Joi.string().custom(objectId).allow(null).optional(),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: Joi.string().required().custom(objectId).label('Address').messages({
      'any.required': '{{#label}} is required',
      'string.objectId': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getSalesOrders = {
  query: Joi.object().keys({
    orderId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    appName: Joi.string().allow('', null).optional(),
    customerId: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    status: Joi.string(),
    productionOrderStatus: Joi.string(),
    materialStatus: Joi.string().valid(...Object.values(SALES_ORDER_MATERIAL_STATUS)),
    withMaterialStatus: Joi.boolean(),
    branchId: Joi.string(),
    tagId: Joi.string(),
    divisionId: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    ...commonSchemas.dateRangeQuery(),
    orderDate: commonSchemas.date({ label: 'Order Date' }),
  }),
};

const getSalesOrdersExports = {
  query: Joi.object().keys({
    orderId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    appName: Joi.string().allow('', null).optional(),
    customerId: Joi.string().custom(commaSeparatedObjectIds).allow('').label('Customer ID'),
    sortBy: Joi.string(),
    search: Joi.string(),
    status: Joi.string(),
    materialStatus: Joi.string().valid(...Object.values(SALES_ORDER_MATERIAL_STATUS)),
    branchId: Joi.string(),
    tagId: Joi.string(),
    divisionId: Joi.string(),
    addedBy: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPES))
      .allow(''),
    ...commonSchemas.dateRangeQuery(),
    orderDate: commonSchemas.date({ label: 'Order Date' }),
  }),
};
const getSalesOrderDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const getSalesOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    orderId: commonSchemas.objectId({ label: 'Order ID', isRequired: true }),
  }),
};

const updateSalesOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    orderId: commonSchemas.objectId({ label: 'Order ID', isRequired: true }),
  }),
  body: salesBaseValidationSchema
    .keys({
      quoteId: commonSchemas.objectId({ label: 'Quote ID', isOptional: true }),
      tagId: commonSchemas.objectId({ label: 'Tag ID', isOptional: true }),
      quoteNo: commonSchemas.string({ label: 'Quote No', isOptional: true }),
      customerOrderId: commonSchemas.objectId({ label: 'Customer Order ID', isOptional: true }),
      customerOrderNo: commonSchemas.string({ label: 'Customer Order No', isOptional: true }),
      reference: commonSchemas.string({ label: 'Reference', allowEmpty: true, isOptional: true }),
      orderDate: commonSchemas.date({ label: 'Order Date', isOptional: true }),
      expectedShipmentDate: commonSchemas.date({ label: 'Expected Shipment Date', isOptional: true }).allow(null),
      status: Joi.string()
        .valid(...Object.keys(SALES_ORDER_STATUS))
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
      attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
        'array.base': '{{#label}} must be an array of strings',
      }),
      paymentTermsId: Joi.string()
        .custom(objectId)
        .allow(null)
        .label('Payment Terms')
        .messages({
          'string.objectId': '{{#label}} must be a valid ObjectId',
        })
        .optional(),
      deliveryMethod: commonSchemas.string({ label: 'Delivery Method', isOptional: true }).allow(null),
      items: Joi.array()
        .items(createItemSchema({ forCreation: false }))
        .label('Items')
        .messages({
          'array.base': '{{#label}} must be an array of valid items',
        }),
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

const updateSalesOrderStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    orderId: commonSchemas.objectId({ label: 'Order ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...Object.values(SALES_ORDER_STATUS))
        .required()
        .label('Status'),
    })
    .required(),
};

const revertSalesOrderClose = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    orderId: commonSchemas.objectId({ label: 'Order ID', isRequired: true }),
  }),
};

const deleteSalesOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    orderId: commonSchemas.objectId({ label: 'Order ID', isRequired: true }),
  }),
};

const getDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }), // add filters if needed later
};

const openSalesOrders = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
    status: Joi.string(),
  }),
};

const partiallyconverteditem = {
  query: Joi.object().keys({
    id: Joi.string().required(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const getSalesOrderWiseItemAnalysis = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    status: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    orderDate: commonSchemas.date({ label: 'Order Date' }),
    pagination: Joi.boolean().default(true),
    sortBy: Joi.string().default('orderDate'),
    page: Joi.number().optional().default(1),
    limit: Joi.number().optional().default(10),
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: false }),
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: false }),
    itemType: Joi.string(),
    itemGroupId: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
    oldPage: Joi.number().optional().default(1),
    oldLimit: Joi.number().optional().default(10),
    newPage: Joi.number().optional().default(1),
    newLimit: Joi.number().optional().default(10),
  }),
};

const getCustomerWiseSalesOrderAnalysis = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),

    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    customerId: Joi.string().optional(),
    itemId: Joi.string().optional(),
    ...commonSchemas.dateRangeQuery(),
    pagination: Joi.boolean().default(true),
    sortBy: Joi.string().default('oldestOrderDate'),
    page: Joi.number().optional().default(1),
    limit: Joi.number().optional().default(10),
  }),
};

const salesOrderAnalysis = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    status: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    ...commonSchemas.dateRangeQuery(),
    orderDate: commonSchemas.date({ label: 'Order Date' }),
    itemId: Joi.string(),
    customerId: Joi.string(),
  }),
};

const getNewVsOldCustomerReportModuleData = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
    moduleName: Joi.string().valid('salesOrders', 'deliveryChallans', 'invoices', 'payments').required(),
    page: Joi.number().integer().min(1).default(1).optional(),
    limit: Joi.number().integer().min(1).max(100).default(10).optional(),
  }),
};

const createProductionOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    salesOrderId: Joi.string().required().custom(objectId),
    inStockWarehouseId: Joi.string().custom(objectId).required(),
    productionWarehouseId: Joi.string().custom(objectId).required(),
    inventoryInwarehouseId: Joi.string().custom(objectId).required(),
    productionOwner: Joi.array().items(Joi.string().custom(objectId)),
    items: Joi.array()
      .items(
        Joi.object({
          itemId: Joi.string().required().custom(objectId),
          quantity: Joi.number().min(0).optional(),
        }).unknown(true),
      )
      .min(1)
      .required(),
  }),
};

module.exports = {
  createSalesOrder,
  getSalesOrders,
  getSalesOrdersExports,
  getSalesOrder,
  updateSalesOrder,
  updateSalesOrderStatus,
  revertSalesOrderClose,
  deleteSalesOrder,
  getDropdown,
  openSalesOrders,
  partiallyconverteditem,
  getSalesOrderWiseItemAnalysis,
  getSalesOrderDropdown,
  salesOrderAnalysis,
  getNewVsOldCustomerReportModuleData,
  createProductionOrder,
};
