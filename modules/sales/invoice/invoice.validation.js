const Joi = require('joi');
const { INVOICE_STATUS, SALES_ORDER_INVOICE_STATUS, NIC_DOC_NUMBER_MAX_LENGTH, ADDRESS_TYPES } = require('../../../utils/enum');
const {
  commonSchemas,
  createItemSchema,
  salesBaseValidationSchema,
  discountValidation,
  commaSeparatedObjectIds,
} = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');
const { eInvoiceOptions, eWayBillOptionKeys, getGstDocumentOptions } = require('../gstDocument/gstDocument.validation');

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

const createInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: salesBaseValidationSchema.keys({
    invoiceId: Joi.string()
      .max(NIC_DOC_NUMBER_MAX_LENGTH)
      .required()
      .label('Invoice Number')
      .messages({
        'string.max': `{{#label}} must not exceed ${NIC_DOC_NUMBER_MAX_LENGTH} characters.`,
      }),
    quoteId: commonSchemas.objectId({ label: 'Quote ID', isOptional: true }),
    quoteNo: commonSchemas.string({ label: 'Quote No', isOptional: true }),
    referenceNumber: commonSchemas.string({ label: 'Reference Number', allowEmpty: true }),
    invoiceDate: commonSchemas.date({ label: 'Invoice Date', isRequired: true }),
    dueDate: commonSchemas.date({ label: 'Due Date', isRequired: true }).allow(null),
    paymentTermsId: Joi.string().custom(objectId).label('Payment Terms').required().messages({
      'string.objectId': '{{#label}} must be a valid ObjectId',
      'any.required': '{{#label}} is required',
    }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true }),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    freightCharges: commonSchemas.number({ label: 'Freight Charges', isOptional: true }),
    status: Joi.string()
      .valid(...Object.keys(INVOICE_STATUS))
      .label('Invoice Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    paidAmount: commonSchemas.number({ label: 'Paid Amount', isOptional: true }).min(0),
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
    isSplit: Joi.boolean().optional().allow(null),
    split: Joi.when('isSplit', {
      is: true,
      then: splitSchema.required(),
      otherwise: Joi.forbidden(),
    }),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: commonSchemas.objectId({ label: 'Address ID', isOptional: false }),
    deliveryChallanIds: Joi.alternatives()
      .try(
        Joi.array().items(
          Joi.object({
            deliveryChallanId: commonSchemas.objectId({ label: 'DeliveryChallan ID' }),
            challanId: commonSchemas.string({ label: 'Challan Id' }),
          }),
        ),
        Joi.valid(null),
      )
      .optional()
      .label('DeliveryChallan')
      .messages({
        'array.base': '{{#label}} must be an array of delivery challan objects or null',
        'object.base': 'Each item in {{#label}} must be an object',
      }),
    isInventoryEnabled: Joi.boolean().required(),
  }),
};

const getInvoicesExports = {
  query: Joi.object().keys({
    invoiceId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string().custom(commaSeparatedObjectIds).allow('').label('Customer ID'),
    isSplit: Joi.boolean().optional().allow(null),
    sortBy: Joi.string(),
    search: Joi.string(),
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
    ...commonSchemas.dateRangeQuery(),
    invoiceDate: commonSchemas.date({ label: 'Invoice Date' }),
  }),
};
const getPendingInvoices = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID' }),
    branchId: commonSchemas.objectId({ label: 'Branch ID', isOptional: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    isSplit: Joi.boolean().optional().allow(null),
    forCreditMapping: Joi.boolean(),
    allowCrossBranchMapping: Joi.boolean(),
    creditBranchId: commonSchemas.objectId({ label: 'Credit Branch ID', isOptional: true }),
  }),
};

const getInvoicesDropdown = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID', isOptional: true }),
    search: Joi.string().allow(''),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
};

const getCustomerWisePendingInvoices = {
  params: Joi.object().keys({
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
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
    divisionId: commonSchemas.objectId({ label: 'Division ID', isOptional: true }),
    warehouseId: commonSchemas.objectId({ label: 'Warehouse ID', isOptional: true }),
  }),
};

const applyCustomerCreditToInvoice = {
  params: Joi.object().keys({
    customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
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
          invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isOptional: true }),
          targetOpeningBalanceTransactionId: commonSchemas.objectId({ label: 'Opening Balance Target ID', isOptional: true }),
          amountApplied: commonSchemas
            .number({ label: 'Amount Applied', isRequired: true })
            .positive()
            .messages({ 'number.positive': '{{#label}} must be greater than zero' }),
        })
          .xor('invoiceId', 'targetOpeningBalanceTransactionId')
          .messages({ 'object.xor': 'Provide either invoice or opening balance target' }),
      )
      .min(1)
      .required()
      .label('Applications'),
    contextInvoiceId: commonSchemas.objectId({ label: 'Context Invoice ID', isOptional: true }),
  }),
};

const updateInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
  body: salesBaseValidationSchema
    .keys({
      quoteId: commonSchemas.objectId({ label: 'Quote ID', isOptional: true }),
      quoteNo: commonSchemas.string({ label: 'Quote No', isOptional: true }),
      referenceNumber: commonSchemas.string({
        label: 'Reference Number',
        allowEmpty: true,
        isOptional: true,
      }),
      invoiceDate: commonSchemas.date({ label: 'Invoice Date', isOptional: true }),
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
      freightCharges: commonSchemas.number({ label: 'Freight Charges', isOptional: true }),
      status: Joi.string()
        .valid(...Object.keys(INVOICE_STATUS))
        .label('Invoice Status')
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
      addressId: commonSchemas.objectId({ label: 'Address ID', isOptional: true, allow: ['', null] }),
      isSplit: Joi.boolean().optional().allow(null),
      deliveryChallanIds: Joi.alternatives()
        .try(
          Joi.array().items(
            Joi.object({
              deliveryChallanId: commonSchemas.objectId({ label: 'DeliveryChallan ID' }),
              challanId: commonSchemas.string({ label: 'Challan Id' }),
            }),
          ),
          Joi.valid(null),
        )
        .optional()
        .label('DeliveryChallan')
        .messages({
          'array.base': '{{#label}} must be an array of delivery challan objects or null',
          'object.base': 'Each item in {{#label}} must be an object',
        }),
      isInventoryEnabled: Joi.boolean().required(),
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the invoice',
    }),
};

const deleteInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
};

const updateInvoiceStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...Object.keys(SALES_ORDER_INVOICE_STATUS))
        .label('Invoice Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
    })
    .required()
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the invoice',
    }),
};

const generateEInvoice = {
  body: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
    updateItemMaster: Joi.boolean().optional().label('Update HSN in Item Master'),
    items: Joi.array()
      .items(
        Joi.object({
          hsn: Joi.string().required(),
          itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
        }),
      )
      .optional(),
    EwbDtls: Joi.object({
      TransMode: Joi.string().valid('1', '2', '3', '4').optional().allow(null, '').label('Transport Mode'),
      Distance: Joi.number().min(0).max(4000).required().label('Distance (KM)'),

      TransId: Joi.when('TransMode', {
        is: Joi.exist(),
        then: Joi.string()
          .optional()
          .allow(null, '')
          .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
          .label('Transporter GSTIN')
          .messages({
            'string.pattern.base': 'Invalid GSTIN format. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
          }),
        otherwise: Joi.string()
          .required()
          .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
          .label('Transporter GSTIN (required when Transport Mode not provided)')
          .messages({
            'any.required': 'Transporter GSTIN is required when Transport Mode is not provided.',
            'string.pattern.base': 'Invalid GSTIN format. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
          }),
      }),

      TransName: Joi.when('TransMode', {
        is: Joi.exist(),
        then: Joi.string().optional().allow(null, '').label('Transporter Name'),
        otherwise: Joi.string().required().label('Transporter Name (required when Transport Mode not provided)'),
      }),

      // Mode 1 → Road
      VehNo: Joi.when('TransMode', {
        is: '1',
        then: Joi.string()
          .pattern(/^[A-Z]{2}\d{1,2}[A-Z]{1,2}\d{1,4}$/)
          .required()
          .label('Vehicle Number (Road)'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      VehType: Joi.when('TransMode', {
        is: '1',
        then: Joi.string().valid('R', 'O').required().label('Vehicle Type (Road)'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      // Mode 2 → Rail
      RRNo: Joi.when('TransMode', {
        is: '2',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Railway Receipt (RR) Number'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      RRDate: Joi.when('TransMode', {
        is: '2',
        then: commonSchemas.date({ label: 'RR Date (DD/MM/YYYY)', isRequired: true }),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      // Mode 3 → Air
      AWBNo: Joi.when('TransMode', {
        is: '3',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Airway Bill (AWB) Number'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      AWBDate: Joi.when('TransMode', {
        is: '3',
        then: commonSchemas.date({ label: 'AWB Date (DD/MM/YYYY)', isRequired: true }),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      // Mode 4 → Ship
      BLNo: Joi.when('TransMode', {
        is: '4',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Bill of Lading (BL) Number'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      BLDate: Joi.when('TransMode', {
        is: '4',
        then: commonSchemas.date({ label: 'BL Date (DD/MM/YYYY)', isRequired: true }),
        otherwise: Joi.string().optional().allow(null, ''),
      }),
    })
      .custom((value, helpers) => {
        const hasTransportMode = !!value?.TransMode;
        const hasTransporterDetails = value?.TransId && value?.TransName;

        if (!hasTransportMode && !hasTransporterDetails) {
          return helpers.error('any.custom', 'Either Transport Mode or both Transporter ID & Transporter Name are required.');
        }

        return value;
      })
      .optional()
      .label('E-Way Bill Details'),
    EInvDtls: eInvoiceOptions,
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const cancelEInvoice = {
  body: Joi.object().keys({
    cancellationReasonCode: Joi.number().required().label('Cancellation Reason Code'),
    cancellationReasonRemarks: Joi.string().optional().allow(null, '').label('Cancellation Reason'),
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const refetchEInvoiceOrEWayBill = {
  body: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const getPaymentHistoryForInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
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

const removeOpeningBalanceApplicationFromInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
    applicationId: commonSchemas.objectId({ label: 'Application ID', isRequired: true }),
  }),
};

const autoMapOpeningBalanceToInvoices = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().custom(objectId),
    branchId: Joi.string().custom(objectId),
    isSplit: Joi.boolean(),
  }),
};

const cancelOnlyEWayBill = {
  body: Joi.object().keys({
    cancellationReasonCode: Joi.number().required().label('Cancellation Reason Code'),
    cancellationReasonRemarks: Joi.string().optional().allow(null, '').label('Cancellation Reason'),
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const generateOnlyEWayBill = {
  body: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
    updateItemMaster: Joi.boolean().optional().label('Update HSN in Item Master'),
    items: Joi.array()
      .items(
        Joi.object({
          hsn: Joi.string().required(),
          itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
        }),
      )
      .optional(),
    EwbDtls: Joi.object().keys({
      supplyType: Joi.string().valid('O', 'I').required().label('Supply Type'),
      subSupplyType: Joi.string()
        .valid('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12')
        .required()
        .label('Sub Supply Type'),
      subSupplyDesc: Joi.when('subSupplyType', {
        is: '8',
        then: Joi.string().required().label('Sub Supply Description'),
        otherwise: Joi.forbidden(),
      }),
      transportMode: Joi.string().valid('1', '2', '3', '4').optional().allow(null, '').label('Transport Mode'),
      Distance: Joi.number().min(0).max(4000).required().label('Distance (KM)'),
      ...eWayBillOptionKeys,
      transporterId: Joi.when('transportMode', {
        is: Joi.exist(),
        then: Joi.string()
          .optional()
          .allow(null, '')
          .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
          .label('Transporter GSTIN')
          .messages({
            'string.pattern.base': 'Invalid GSTIN format. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
          }),
        otherwise: Joi.string()
          .required()
          .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
          .label('Transporter GSTIN (required when Transport Mode not provided)')
          .messages({
            'any.required': 'Transporter GSTIN is required when Transport Mode is not provided.',
            'string.pattern.base': 'Invalid GSTIN format. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
          }),
      }),

      transporterName: Joi.when('transportMode', {
        is: Joi.exist(),
        then: Joi.string().optional().allow(null, '').label('Transporter Name'),
        otherwise: Joi.string().required().label('Transporter Name (required when Transport Mode not provided)'),
      }),

      // Mode 1 → Road
      VehNo: Joi.when('transportMode', {
        is: '1',
        then: Joi.string()
          .pattern(/^[A-Z]{2}\d{1,2}[A-Z]{1,2}\d{1,4}$/)
          .required()
          .label('Vehicle Number (Road)'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      VehType: Joi.when('transportMode', {
        is: '1',
        then: Joi.string().valid('R', 'O').required().label('Vehicle Type (Road)'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      // Mode 2 → Rail
      RRNo: Joi.when('transportMode', {
        is: '2',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Railway Receipt (RR) Number'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      RRDate: Joi.when('transportMode', {
        is: '2',
        then: commonSchemas.date({ label: 'RR Date (DD/MM/YYYY)', isRequired: true }),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      // Mode 3 → Air
      AWBNo: Joi.when('transportMode', {
        is: '3',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Airway Bill (AWB) Number'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      AWBDate: Joi.when('transportMode', {
        is: '3',
        then: commonSchemas.date({ label: 'AWB Date (DD/MM/YYYY)', isRequired: true }),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      // Mode 4 → Ship
      BLNo: Joi.when('transportMode', {
        is: '4',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Bill of Lading (BL) Number'),
        otherwise: Joi.string().optional().allow(null, ''),
      }),

      BLDate: Joi.when('TransMode', {
        is: '4',
        then: commonSchemas.date({ label: 'BL Date (DD/MM/YYYY)', isRequired: true }),
        otherwise: Joi.string().optional().allow(null, ''),
      }),
    }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const createSplitInvoice = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: salesBaseValidationSchema.keys({
    invoiceId: Joi.string().required(),
    referenceNumber: commonSchemas.string({ label: 'Reference Number', allowEmpty: true }),
    invoiceDate: commonSchemas.date({ label: 'Invoice Date', isRequired: true }),
    dueDate: commonSchemas.date({ label: 'Due Date', isRequired: true }).allow(null),
    paymentTermsId: Joi.string().custom(objectId).label('Payment Terms').required().messages({
      'string.objectId': '{{#label}} must be a valid ObjectId',
      'any.required': '{{#label}} is required',
    }),
    subject: commonSchemas.string({ label: 'Subject', allowEmpty: true }),
    customerNotes: commonSchemas.string({ label: 'Customer Notes', allowEmpty: true }),
    termsAndConditions: commonSchemas.string({ label: 'Terms and Conditions', allowEmpty: true }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    freightCharges: commonSchemas.number({ label: 'Freight Charges', isOptional: true }),
    status: Joi.string()
      .valid(...Object.keys(INVOICE_STATUS))
      .label('Invoice Status')
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      })
      .optional(),
    paidAmount: commonSchemas.number({ label: 'Paid Amount', isOptional: true }).min(0),
    priceListId: Joi.string().custom(objectId).allow(null).optional(),
    isSplit: Joi.boolean().optional().allow(null),
    discountConfig: discountValidation,
    appliesTo: Joi.string().optional().allow(null, ''),
    addressId: commonSchemas.objectId({ label: 'Address ID', isOptional: false }),
    isInventoryEnabled: Joi.boolean().required(),
  }),
};

const getInvoices = {
  query: Joi.object().keys({
    invoiceId: Joi.string(),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
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
    eInvoicePending: Joi.boolean().optional(),
    eWayBillPending: Joi.boolean().optional(),
    includeComplianceCount: Joi.boolean().optional(),
    ...commonSchemas.dateRangeQuery(),
    invoiceDate: commonSchemas.date({ label: 'Invoice Date' }),
  }),
};

module.exports = {
  createInvoice,
  getInvoicesExports,
  getCustomerWisePendingInvoices,
  getInvoices,
  getInvoice,
  updateInvoice,
  deleteInvoice,
  updateInvoiceStatus,
  getPendingInvoices,
  getInvoicesDropdown,
  generateEInvoice,
  cancelEInvoice,
  refetchEInvoiceOrEWayBill,
  getPaymentHistoryForInvoice,
  removeOpeningBalanceApplicationFromInvoice,
  removeOpeningBalanceApplicationFromOb,
  generateOnlyEWayBill,
  getGstDocumentOptions,
  cancelOnlyEWayBill,
  createSplitInvoice,
  applyCustomerCreditToInvoice,
  autoMapOpeningBalanceToInvoices,
};
