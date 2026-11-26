const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { REJECTION_ORDER_STATUS, REJECTION_CONVERT_TYPE } = require('../../../utils/enum');

const CONVERT_TYPE_VALUES = Object.values(REJECTION_CONVERT_TYPE);

const reasonAssignmentSchema = Joi.object().keys({
  reason: commonSchemas.objectId({ label: 'Reason', isRequired: true }),
  subReason: Joi.string().trim().allow('').optional(),
  qty: Joi.number().min(1).required(),
});

const componentRecoverySchema = Joi.object().keys({
  componentName: Joi.string().trim().required(),
  componentPath: Joi.string().trim().allow(null, '').optional(),
  componentItemId: Joi.string().custom(objectId).allow(null, '').optional(),
  reuse: Joi.number().min(0).optional(),
  vendorReturn: Joi.number().min(0).optional(),
  scrap: Joi.number().min(0).optional(),
  scrapWeightKg: Joi.number().min(0).optional(),
});

const itemSchema = Joi.object().keys({
  _id: Joi.string().custom(objectId).optional(),
  itemId: Joi.string().custom(objectId).allow(null, '').optional(),
  wattage: Joi.string().trim().allow('').optional(),
  bookedQty: Joi.number().min(1).required(),
  receivedQty: Joi.number().min(0).allow(null).optional(),
  returnedQty: Joi.number().min(0).optional(),
  manufacturingDate: Joi.date().max('now').allow(null).optional().label('Manufacturing Date'),
  warrantyExpiredQty: Joi.number().integer().min(0).allow(null).optional().label('Warranty Expired Qty'),
  warrantyExpiredMfgDate: Joi.date()
    .max('now')
    .allow(null)
    .when('warrantyExpiredQty', { is: Joi.number().greater(0).required(), then: Joi.date().max('now').required() })
    .label('Warranty Expired Mfg Date'),
  reasonAssignments: Joi.array().items(reasonAssignmentSchema).optional(),
  componentRecoveries: Joi.array().items(componentRecoverySchema).optional(),
  convertType: Joi.string()
    .valid(...CONVERT_TYPE_VALUES)
    .optional(),
});

// Booking-time item fields only; workflow fields (received, reasons, recovery...) are not editable here.
const editItemSchema = Joi.object().keys({
  _id: Joi.string().custom(objectId).optional(),
  itemId: Joi.string().custom(objectId).allow(null, '').optional(),
  wattage: Joi.string().trim().allow('').optional(),
  bookedQty: Joi.number().min(1).required(),
  manufacturingDate: Joi.date().max('now').allow(null).optional().label('Manufacturing Date'),
});

// The RejectionOrder model marks address.country/state/city as required (nested paths,
// so their required validators always run). Enforce the same at the Joi layer to return a
// clean 400 instead of a Mongoose validation 500 on create/update.
const addressSchema = Joi.object().keys({
  country: Joi.string().trim().required().label('Country'),
  state: Joi.string().trim().required().label('State'),
  city: Joi.string().trim().required().label('City'),
});

const createRejectionOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    rejectionOrderId: Joi.string().trim().optional(),
    divisionId: commonSchemas.objectId({ label: 'Division', isRequired: true }),
    branchId: commonSchemas.objectId({ label: 'Branch', isRequired: true }),
    warehouseId: commonSchemas.objectId({ label: 'Warehouse', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer', isRequired: true }),
    referenceInvoiceId: Joi.string().custom(objectId).allow(null, '').optional(),
    address: addressSchema.required(),
    transport: Joi.string().trim().allow('').optional(),
    transportName: Joi.string().trim().allow('', null).optional().label('Transport Name'),
    transportationDate: Joi.date().allow(null).optional().label('Transportation Date'),
    arrivalDate: Joi.date().allow(null).optional(),
    note: Joi.string().trim().allow('').optional(),
    attachments: Joi.array().items(Joi.string()).optional(),
    items: Joi.array().items(itemSchema).min(1).required().messages({
      'array.min': 'At least one item is required',
    }),
  }),
};

const getRejectionOrders = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string(),
    rejectionOrderId: Joi.string(),
    status: Joi.string(),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    addedBy: Joi.string(),
    search: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    ...commonSchemas.dateRangeQuery(),
  }),
};

const getRejectionOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    rejectionOrderId: commonSchemas.objectId({ label: 'Rejection Order ID', isRequired: true }),
  }),
};

const saveRejectionWorkflow = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    rejectionOrderId: commonSchemas.objectId({ label: 'Rejection Order ID', isRequired: true }),
  }),
  // Workflow saves only; booking details are edited via PUT /:rejectionOrderId while Pending.
  body: Joi.object()
    .keys({
      items: Joi.array().items(itemSchema).min(1),
      convertType: Joi.string().valid(...CONVERT_TYPE_VALUES),
      status: Joi.string()
        .valid(...Object.values(REJECTION_ORDER_STATUS))
        .optional()
        .label('Status'),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field must be provided for update',
    }),
};

// Division, branch, warehouse, customer and booking number are fixed after creation.
const updateRejectionBooking = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    rejectionOrderId: commonSchemas.objectId({ label: 'Rejection Order ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    referenceInvoiceId: Joi.string().custom(objectId).allow(null, '').optional(),
    address: addressSchema.required(),
    transport: Joi.string().trim().allow('').optional(),
    transportName: Joi.string().trim().allow('', null).optional().label('Transport Name'),
    transportationDate: Joi.date().allow(null).optional().label('Transportation Date'),
    arrivalDate: Joi.date().allow(null).optional(),
    note: Joi.string().trim().allow('').optional(),
    attachments: Joi.array().items(Joi.string()).optional(),
    items: Joi.array().items(editItemSchema).min(1).unique('_id', { ignoreUndefined: true }).required().messages({
      'array.min': 'At least one item is required',
      'array.unique': 'Each item row can appear only once',
    }),
  }),
};

const updateRejectionOrderStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    rejectionOrderId: commonSchemas.objectId({ label: 'Rejection Order ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    status: Joi.string()
      .valid(...Object.values(REJECTION_ORDER_STATUS))
      .required()
      .label('Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
        'any.required': '{{#label}} is required',
      }),
  }),
};

const deleteRejectionOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    rejectionOrderId: commonSchemas.objectId({ label: 'Rejection Order ID', isRequired: true }),
  }),
};

const getInventorySummary = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
};

const getAnalysisSummary = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    itemId: Joi.string().custom(objectId).allow(null, '').optional(),
  }),
};

const getRecoveryBom = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    rejectionOrderId: commonSchemas.objectId({ label: 'Rejection Order ID', isRequired: true }),
  }),
};

const getInvoiceDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().required().custom(objectId),
    search: Joi.string().allow(''),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

module.exports = {
  createRejectionOrder,
  getRejectionOrders,
  getRejectionOrder,
  saveRejectionWorkflow,
  updateRejectionBooking,
  updateRejectionOrderStatus,
  deleteRejectionOrder,
  getInventorySummary,
  getAnalysisSummary,
  getRecoveryBom,
  getInvoiceDropdown,
};
