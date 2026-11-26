const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { MODULE_NAMES, ADDRESS_TYPE, PARTY_ACCOUNT_TYPES } = require('../../../utils/enum');

const accountTypeSchema = Joi.string()
  .valid(...Object.keys(PARTY_ACCOUNT_TYPES))
  .optional()
  .label('Account Type')
  .messages({ 'any.only': '{{#label}} must be one of {{#valids}}' });

/** Shared Joi .custom() validator — exactly one of isCustomer/isVendor must be true */
const requireOneOfCustomerOrVendor = (value, helpers) => {
  const isCustomer = value.isCustomer === true;
  const isVendor = value.isVendor === true;
  if (isCustomer === isVendor) {
    return helpers.message('Exactly one of isCustomer or isVendor must be provided');
  }
  return value;
};

const bpPrimaryContactNameSchema = Joi.object({
  firstName: Joi.string().trim().required().label('First Name').messages({
    'string.base': '"{{#label}}" should be a type of text',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  lastName: Joi.string().trim().allow(null, '').optional().label('Last Name').messages({
    'string.base': '"{{#label}}" should be a type of text',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
}).required();

// Bulk import variant: kept fully optional/lenient — "required" and format checks for
// bulk rows are done in the service layer so they can be reported per-row instead of
// rejecting the whole sheet at the Joi level.
const bpPrimaryContactNameBulkSchema = Joi.object({
  firstName: Joi.string().trim().allow(null, '').optional().label('First Name'),
  lastName: Joi.string().trim().allow(null, '').optional().label('Last Name'),
}).optional();

const otherDetailsSchema = Joi.object({
  gstTreatment: Joi.string().trim().required().label('GST Treatment').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  importExportCountry: Joi.string().trim().allow(null, '').label('Import Export Country').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  importExportCode: Joi.string().trim().allow(null, '').label('Import Export Code').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  gstinUin: Joi.string()
    .trim()
    .label('GSTIN/UIN')
    .when('gstTreatment', {
      is: 'Registered Business Regular',
      then: Joi.string().trim().required().messages({
        'any.required': '"{{#label}}" is required for Registered Business Regular',
        'string.empty': '"{{#label}}" cannot be empty',
      }),
      otherwise: Joi.string().trim().allow(null, ''),
    })
    .messages({
      'string.base': '"{{#label}}" must be a string',
    }),
  taxPreference: Joi.string().valid('Taxable', 'Tax Exempt').allow(null, '').label('Tax Preference').messages({
    'any.only': '"{{#label}}" must be either Taxable or Tax Exempt',
  }),
  pan: Joi.string().trim().allow(null, '').label('PAN').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  currency: Joi.string().custom(objectId).required().label('Currency').messages({
    'any.required': '{{#label}} is required',
    'string.base': '{{#label}} must be a string',
  }),

  priceList: Joi.string().custom(objectId).allow(null, '').label('Price List').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  includePriceListItemOnly: Joi.boolean().optional().label('Include Price List Item Only').messages({
    'boolean.base': '"{{#label}}" must be a boolean',
  }),
  enablePortal: Joi.boolean().optional().label('Enable Portal').messages({
    'boolean.base': '"{{#label}}" must be a boolean',
  }),
  isCustomerPortalActivated: Joi.boolean().optional().label('Is Customer Portal Activated').messages({
    'boolean.base': '"{{#label}}" must be a boolean',
  }),
  document: Joi.array().items(Joi.string().trim()).optional().label('Document').messages({
    'array.base': '"{{#label}}" must be an array',
    'string.base': '"{{#label}}" must contain only strings',
  }),
  attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
    'array.base': '"{{#label}}" must be an array',
    'string.base': '"{{#label}}" must contain only strings',
  }),
}).optional();

const otherDetailsBulkSchema = Joi.object({
  // "Required" (gstTreatment, currency) and conditional (gstinUin) rules for bulk rows are
  // enforced in the service layer so they can be reported per-row instead of rejecting the
  // whole sheet at the Joi level.
  gstTreatment: Joi.string().trim().allow(null, '').label('GST Treatment').messages({
    'string.base': '"{{#label}}" must be a string',
  }),
  importExportCountry: Joi.string().trim().allow(null, '').label('Import Export Country').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  importExportCode: Joi.string().trim().allow(null, '').label('Import Export Code').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  gstinUin: Joi.string().trim().allow(null, '').label('GSTIN/UIN').messages({
    'string.base': '"{{#label}}" must be a string',
  }),
  taxPreference: Joi.string().trim().allow(null, '').label('Tax Preference').messages({
    'string.base': '"{{#label}}" must be a string',
  }),
  pan: Joi.string().trim().allow(null, '').label('PAN').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  currency: Joi.string().trim().allow(null, '').label('Currency').messages({
    'string.base': '{{#label}} must be a string',
  }),
  priceList: Joi.string().custom(objectId).allow(null, '').label('Price List').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.empty': '"{{#label}}" cannot be empty',
  }),
  includePriceListItemOnly: Joi.boolean().optional().label('Include Price List Item Only').messages({
    'boolean.base': '"{{#label}}" must be a boolean',
  }),
  enablePortal: Joi.boolean().optional().label('Enable Portal').messages({
    'boolean.base': '"{{#label}}" must be a boolean',
  }),
  isCustomerPortalActivated: Joi.boolean().optional().label('Is Customer Portal Activated').messages({
    'boolean.base': '"{{#label}}" must be a boolean',
  }),
  document: Joi.array().items(Joi.string().trim()).optional().label('Document').messages({
    'array.base': '"{{#label}}" must be an array',
    'string.base': '"{{#label}}" must contain only strings',
  }),
  attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
    'array.base': '"{{#label}}" must be an array',
    'string.base': '"{{#label}}" must contain only strings',
  }),
}).optional();

const addressSchema = Joi.object({
  attention: Joi.string().trim().allow(null, '').label('Attention').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  country: Joi.string().trim().allow(null, '').label('Country').messages({
    'string.base': '{{#label}} must be a string',
  }),
  address: Joi.object({
    street1: Joi.string().trim().allow(null, '').label('Street 1').messages({
      'string.base': '{{#label}} must be a string',
    }),
    street2: Joi.string().trim().allow(null, '').label('Street 2').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
  })
    .optional()
    .label('Address'),
  city: Joi.string().trim().allow(null, '').label('City').messages({
    'string.base': '{{#label}} must be a string',
  }),
  state: Joi.string().trim().allow(null, '').label('State').messages({
    'string.base': '{{#label}} must be a string',
  }),
  pinCode: Joi.string().trim().allow(null, '').label('Pin Code').messages({
    'string.base': '{{#label}} must be a string',
  }),
  faxNumber: Joi.string().trim().allow(null, '').label('Fax Number').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  phone: Joi.string().trim().allow(null, '').label('Phone').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  _id: Joi.string()
    .optional()
    .allow(null, '')
    .label('Address ID')
    .messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    })
    .custom(objectId),
})
  .optional()
  .label('Address');

const businessPartnerTeamSchema = Joi.object({
  _id: Joi.string().custom(objectId).optional().allow(null),
  firstName: Joi.string().trim().required().label('First Name').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  lastName: Joi.string().trim().required().label('Last Name').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  mobileNo: Joi.string().trim().required().label('Mobile Number').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  email: Joi.string().email().trim().optional().label('Email Address').messages({
    'string.base': '{{#label}} must be a valid email address',
    'string.email': '{{#label}} must be a valid email address',
    'string.empty': '{{#label}} cannot be empty',
  }),
  workPhone: Joi.string().trim().optional().label('Work Phone').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  department: Joi.string().trim().optional().label('Department').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  authorityPower: Joi.string().trim().optional().label('Authority Power').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
})
  .optional()
  .label('Business Partner Team');

const branchSchema = Joi.object({
  branchId: Joi.string().optional().allow(null).custom(objectId).label('Branch ID').messages({
    'string.base': '{{#label}} must be a string',
  }),
  divisionId: Joi.string().optional().allow(null).custom(objectId).label('Division ID').messages({
    'string.base': '{{#label}} must be a string',
  }),
  branchCode: Joi.string().trim().optional().label('Branch Code').messages({
    'string.base': '{{#label}} must be a string',
    'string.empty': '{{#label}} cannot be empty',
  }),
  openingBalance: Joi.number().optional().label('Opening Balance').messages({
    'number.base': '{{#label}} must be a number',
  }),
  isSplitBalance: Joi.boolean().optional().label('Split Balance').messages({
    'boolean.base': '{{#label}} must be true or false',
  }),
  currentBalance: Joi.number().optional().label('Current Balance').messages({
    'number.base': '{{#label}} must be a number',
  }),
  creditLimit: Joi.number().optional().label('creditLimit').messages({
    'number.base': '{{#label}} must be a number',
  }),
  isActive: Joi.boolean().label('isActive').messages({
    'boolean.base': '{{#label}} must be true or false',
  }),
  restrictedModule: Joi.array()
    .items(
      Joi.string().valid(
        MODULE_NAMES.QUOTATION,
        MODULE_NAMES.SALES_ORDER,
        MODULE_NAMES.DELIVERY_CHALLAN,
        MODULE_NAMES.INVOICE,
        MODULE_NAMES.GRPO,
        MODULE_NAMES.PURCHASE_ORDER,
        MODULE_NAMES.BILL,
        MODULE_NAMES.EXPENSE,
      ),
    )
    .label('Restricted Module')
    .optional()
    .allow(null)
    .messages({
      'array.base': '"{{#label}}" must be an array',
      'any.only': '"{{#label}}" contains invalid value',
      'string.base': '"{{#label}}" must contain only strings',
    }),
  paymentTermsId: Joi.string().custom(objectId).allow(null, '').label('Payment Terms').messages({
    'string.base': '"{{#label}}" must be a string',
    'string.objectId': '"{{#label}}" must be a valid ObjectId',
  }),
  restrictedPaymentTermsModule: Joi.array()
    .items(
      Joi.string().valid(
        MODULE_NAMES.QUOTATION,
        MODULE_NAMES.SALES_ORDER,
        MODULE_NAMES.DELIVERY_CHALLAN,
        MODULE_NAMES.INVOICE,
        MODULE_NAMES.GRPO,
        MODULE_NAMES.PURCHASE_ORDER,
        MODULE_NAMES.BILL,
      ),
    )
    .label('Restricted Module')
    .optional()
    .allow(null)
    .messages({
      'array.base': '"{{#label}}" must be an array',
      'any.only': '"{{#label}}" contains invalid value',
      'string.base': '"{{#label}}" must contain only strings',
    }),
})
  .optional()
  .label('Branch');

const createCustomer = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
  }),
  body: Joi.object({
    customerNumber: Joi.string().trim().required().label('Customer Number').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    bpPrimaryContactName: bpPrimaryContactNameSchema.label('Primary Contact Name'),
    businessPartnerType: Joi.string().valid('Business', 'Individual').required().label('Business Partner Type').messages({
      'string.base': '{{#label}} must be a string',
      'any.only': '{{#label}} must be one of [Business, Individual]',
    }),
    Role: Joi.object({
      isCustomer: Joi.boolean().default(false).label('Is Customer').messages({
        'boolean.base': '{{#label}} must be true or false',
      }),
      isVendor: Joi.boolean().default(false).label('Is Vendor').messages({
        'boolean.base': '{{#label}} must be true or false',
      }),
    }).optional(),
    isCustomerDirectTax: Joi.boolean().label('Customer TDS/TCS').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    isVendorDirectTax: Joi.boolean().label('Vendor TDS/TCS').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    accountType: accountTypeSchema,
    companyName: Joi.string().trim().required().label('Company Name').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    customerDisplayName: Joi.string().trim().required().label('Customer Display Name').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    bpEmail: Joi.string().email().trim().allow(null, '').optional().label('Email').messages({
      'string.base': '{{#label}} must be a string',
      'string.email': '{{#label}} must be a valid email',
    }),
    customerPhoneNumber: Joi.string().trim().regex(/^\d+$/).allow(null, '').optional().label('Customer Phone Number').messages({
      'string.base': '{{#label}} must be a string',
      'string.pattern.base': '{{#label}} must contain only digits',
    }),
    companyLogo: Joi.string().optional().label('Company Logo').messages({
      'string.base': '{{#label}} must be a string',
    }),
    attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
      'array.base': '{{#label}} must be an array',
    }),
    otherDetails: otherDetailsSchema.label('Other Details'),
    address: Joi.object({
      billing: addressSchema.label('Billing Address'),
      shipping: addressSchema.label('Shipping Address'),
    }).optional(),
    remarks: Joi.string().trim().allow(null, '').label('Remarks').messages({
      'string.base': '{{#label}} must be a string',
    }),
    businessPartnerTeam: Joi.array().items(businessPartnerTeamSchema).optional().label('Business Partner Team').messages({
      'array.base': '{{#label}} must be an array',
    }),
    branch: Joi.array().items(branchSchema).optional().label('Branch').messages({
      'array.base': '{{#label}} must be an array',
    }),
    creditLimit: Joi.number().optional().label('creditLimit').messages({
      'number.base': '{{#label}} must be a number',
    }),
    useBranchCreditLimit: Joi.boolean().default(false).label('useBranchCreditLimit').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    restrictedModule: Joi.array()
      .items(
        Joi.string().valid(
          MODULE_NAMES.QUOTATION,
          MODULE_NAMES.SALES_ORDER,
          MODULE_NAMES.DELIVERY_CHALLAN,
          MODULE_NAMES.INVOICE,
          MODULE_NAMES.GRPO,
          MODULE_NAMES.PURCHASE_ORDER,
          MODULE_NAMES.BILL,
          MODULE_NAMES.EXPENSE,
        ),
      )
      .label('Restricted Module')
      .optional()
      .allow(null)
      .messages({
        'array.base': '"{{#label}}" must be an array',
        'any.only': '"{{#label}}" contains invalid value',
        'string.base': '"{{#label}}" must contain only strings',
      }),
    useBranchPaymentTerms: Joi.boolean().default(false).label('useBranchPaymentTerms').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    paymentTermsId: Joi.string().custom(objectId).allow(null, '').label('Payment Terms').messages({
      'string.base': '"{{#label}}" must be a string',
      'string.objectId': '"{{#label}}" must be a valid ObjectId',
    }),
    restrictedPaymentTermsModule: Joi.array()
      .items(
        Joi.string().valid(
          MODULE_NAMES.QUOTATION,
          MODULE_NAMES.SALES_ORDER,
          MODULE_NAMES.DELIVERY_CHALLAN,
          MODULE_NAMES.INVOICE,
          MODULE_NAMES.GRPO,
          MODULE_NAMES.PURCHASE_ORDER,
          MODULE_NAMES.BILL,
        ),
      )
      .label('Restricted Module')
      .optional()
      .allow(null)
      .messages({
        'array.base': '"{{#label}}" must be an array',
        'any.only': '"{{#label}}" contains invalid value',
        'string.base': '"{{#label}}" must contain only strings',
      }),
    vendorId: Joi.string().optional().allow(null).custom(objectId).label('Vendor ID').messages({
      'string.base': '{{#label}} must be a string',
    }),
    customerId: Joi.string().optional().allow(null).custom(objectId).label('Customer ID').messages({
      'string.base': '{{#label}} must be a string',
    }),
    isLinkedToVendor: Joi.boolean().optional().label('isLinkedToVendor').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
  }).unknown(false),
};

const getCustomers = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    appName: Joi.string().allow('', null).optional(),
    sortBy: Joi.string(),
    status: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    customerDate: Joi.date(),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
    isActive: Joi.boolean(),
    country: Joi.string().trim().optional(),
    state: Joi.string().trim().optional(),
    city: Joi.string().trim().optional(),
    verificationStatus: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED').optional(),
  }),
};

const getVenderDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    branchId: Joi.string().optional().allow(null),
    isActive: Joi.boolean(),
  }),
};

const getCustomerDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    branchId: Joi.string().optional().allow(null),
    isActive: Joi.boolean(),
  }),
};

const updateCustomer = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
  }),
  params: Joi.object().keys({
    customerId: Joi.string().required().custom(objectId).label('Customer ID').messages({
      'string.base': '{{#label}} must be a string',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object({
    customerNumber: Joi.string().required().trim().label('Customer Number').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    bpPrimaryContactName: bpPrimaryContactNameSchema.label('Primary Contact Name'),
    businessPartnerType: Joi.string().valid('Business', 'Individual').required().label('Business Partner Type').messages({
      'string.base': '{{#label}} must be a string',
      'any.only': '{{#label}} must be one of [Business, Individual]',
    }),
    Role: Joi.object({
      isCustomer: Joi.boolean().default(false).label('Is Customer').messages({
        'boolean.base': '{{#label}} must be true or false',
      }),
      isVendor: Joi.boolean().default(false).label('Is Vendor').messages({
        'boolean.base': '{{#label}} must be true or false',
      }),
    }).optional(),
    isCustomerDirectTax: Joi.boolean().label('Customer TDS/TCS').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    isVendorDirectTax: Joi.boolean().label('Vendor TDS/TCS').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    accountType: accountTypeSchema,
    companyName: Joi.string().trim().required().label('Company Name').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    customerDisplayName: Joi.string().trim().required().label('Customer Display Name').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    bpEmail: Joi.string().email().trim().allow(null, '').optional().label('Email').messages({
      'string.base': '{{#label}} must be a string',
      'string.email': '{{#label}} must be a valid email',
    }),
    customerPhoneNumber: Joi.string().trim().regex(/^\d+$/).allow(null, '').optional().label('Customer Phone Number').messages({
      'string.base': '{{#label}} must be a string',
      'string.pattern.base': '{{#label}} must contain only digits',
    }),
    companyLogo: Joi.string().optional().label('Company Logo').messages({
      'string.base': '{{#label}} must be a string',
    }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    otherDetails: otherDetailsSchema.fork(['currency'], schema => schema.optional()).label('Other Details'),
    address: Joi.object({
      billing: addressSchema.label('Billing Address'),
      shipping: addressSchema.label('Shipping Address'),
    }).optional(),
    remarks: Joi.string().trim().allow(null, '').label('Remarks').messages({
      'string.base': '{{#label}} must be a string',
    }),
    businessPartnerTeam: Joi.array().items(businessPartnerTeamSchema).optional().label('Business Partner Team').messages({
      'array.base': '{{#label}} must be an array',
    }),
    branch: Joi.array().items(branchSchema).optional().label('Branch').messages({
      'array.base': '{{#label}} must be an array',
    }),
    creditLimit: Joi.number().optional().label('creditLimit').messages({
      'number.base': '{{#label}} must be a number',
    }),
    useBranchCreditLimit: Joi.boolean().default(false).label('useBranchCreditLimit').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    restrictedModule: Joi.array()
      .items(
        Joi.string().valid(
          MODULE_NAMES.QUOTATION,
          MODULE_NAMES.SALES_ORDER,
          MODULE_NAMES.DELIVERY_CHALLAN,
          MODULE_NAMES.INVOICE,
          MODULE_NAMES.GRPO,
          MODULE_NAMES.PURCHASE_ORDER,
          MODULE_NAMES.BILL,
          MODULE_NAMES.EXPENSE,
        ),
      )
      .label('Restricted Module')
      .optional()
      .allow(null)
      .messages({
        'array.base': '"{{#label}}" must be an array',
        'any.only': '"{{#label}}" contains invalid value',
        'string.base': '"{{#label}}" must contain only strings',
      }),
    useBranchPaymentTerms: Joi.boolean().default(false).label('useBranchPaymentTerms').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    paymentTermsId: Joi.string().custom(objectId).allow(null, '').label('Payment Terms').messages({
      'string.base': '"{{#label}}" must be a string',
      'string.objectId': '"{{#label}}" must be a valid ObjectId',
    }),
    restrictedPaymentTermsModule: Joi.array()
      .items(
        Joi.string().valid(
          MODULE_NAMES.QUOTATION,
          MODULE_NAMES.SALES_ORDER,
          MODULE_NAMES.DELIVERY_CHALLAN,
          MODULE_NAMES.INVOICE,
          MODULE_NAMES.GRPO,
          MODULE_NAMES.PURCHASE_ORDER,
          MODULE_NAMES.BILL,
        ),
      )
      .label('Restricted Module')
      .optional()
      .allow(null)
      .messages({
        'array.base': '"{{#label}}" must be an array',
        'any.only': '"{{#label}}" contains invalid value',
        'string.base': '"{{#label}}" must contain only strings',
      }),
    vendorId: Joi.string().optional().allow(null).custom(objectId).label('Vendor ID').messages({
      'string.base': '{{#label}} must be a string',
    }),
    customerId: Joi.string().optional().allow(null).custom(objectId).label('Customer ID').messages({
      'string.base': '{{#label}} must be a string',
    }),
    isLinkedToVendor: Joi.boolean().optional().label('isLinkedToVendor').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
  }).unknown(false),
};

const deleteCustomer = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
  }),
  params: Joi.object().keys({
    customerId: Joi.string().required().custom(objectId),
  }),
};

// Every field below is intentionally lenient (optional / type-only). "Required" and
// format/enum rules for bulk rows are enforced in the service layer (see
// verifyBulkCustomerCreation / createBulkCustomers in customerMaster.service.js) so a bad
// row is reported individually in that row's `errors` array instead of rejecting the whole
// sheet at the Joi level.
const bulkCustomersArraySchema = Joi.array()
  .items(
    Joi.object({
      bpPrimaryContactName: bpPrimaryContactNameBulkSchema,
      businessPartnerType: Joi.string().trim().allow(null, '').optional(),
      Role: Joi.object({
        isCustomer: Joi.boolean().default(false),
        isVendor: Joi.boolean().default(false),
      })
        .optional()
        .default({ isCustomer: false, isVendor: false }),
      companyName: Joi.string().trim().allow(null, '').optional(),
      customerDisplayName: Joi.string().trim().allow(null, '').optional(),
      bpEmail: Joi.string().trim().allow(null, '').optional(),
      customerPhoneNumber: Joi.string().trim().allow(null, '').optional(),
      otherDetails: otherDetailsBulkSchema.optional(),
      address: Joi.object({
        billing: addressSchema.label('Billing Address'),
        shipping: addressSchema.label('Shipping Address'),
      }).optional(),
      paymentTerms: Joi.string().trim().allow(null, '').label('Payment Terms').messages({
        'string.base': '"{{#label}}" must be a string',
        'string.empty': '"{{#label}}" cannot be empty',
      }),
    }).unknown(false),
  )
  .min(1)
  .required();

const createBulkCustomers = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
    increment: Joi.number().integer().required().label('Bulk Customer Count').messages({
      'number.base': '"{{#label}}" must be a number',
      'number.integer': '"{{#label}}" must be an integer',
      'any.required': '"{{#label}}" is required',
    }),
  }),
  body: Joi.object({
    customers: bulkCustomersArraySchema,
  }).unknown(false),
};

const verifyBulkCustomerCreation = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
    increment: Joi.number().integer().required().label('Bulk Customer Count').messages({
      'number.base': '"{{#label}}" must be a number',
      'number.integer': '"{{#label}}" must be an integer',
      'any.required': '"{{#label}}" is required',
    }),
  }),
  body: Joi.object({
    customers: bulkCustomersArraySchema,
  }).unknown(false),
};

const customerOpeningBalanceBodySchema = Joi.object({
  customerOpeningBalance: Joi.array()
    .min(1)
    .required()
    .items(
      Joi.object({
        customerNumber: Joi.string().trim().optional().label('Customer Number').messages({
          'string.empty': '"{{#label}}" cannot be empty',
        }),
        branch: Joi.array()
          .min(1)
          .required()
          .items(
            Joi.object({
              branchName: Joi.string().trim().optional().label('Branch Name').messages({
                'string.empty': '"{{#label}}" cannot be empty',
              }),
              openingBalance: Joi.number().optional().label('Opening Balance').messages({
                'number.base': '"{{#label}}" must be a number',
              }),
            }),
          )
          .label('Branch')
          .messages({
            'array.min': '"{{#label}}" must contain at least 1 branch',
            'any.required': '"{{#label}}" is required',
          }),
      }),
    )
    .label('Customer Opening Balance')
    .messages({
      'array.min': '"{{#label}}" must contain at least 1 entry',
      'any.required': '"{{#label}}" is required',
    }),
}).unknown(false);

const bulkAddCustomerOpeningBalance = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: customerOpeningBalanceBodySchema,
};

const verifyBulkCustomerOpeningBalance = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: customerOpeningBalanceBodySchema,
};

const getAllCustomers = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    branchId: Joi.string().optional().allow(null),
    isActive: Joi.boolean(),
  }),
};

const getCustomerById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    customerId: Joi.string().required().custom(objectId),
  }),
};

const getCustomerAddress = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().required().custom(objectId),
    addressType: Joi.string()
      .required()
      .valid(...Object.values(ADDRESS_TYPE)),
  }),
};

const addCustomerShippingAddress = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().required().custom(objectId),
    addressType: Joi.string()
      .valid(...Object.values(ADDRESS_TYPE))
      .default(ADDRESS_TYPE.SHIPPING),
  }),
  body: Joi.object({
    attention: Joi.string().trim().allow(null, '').label('Attention').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    country: Joi.string().trim().required().label('Country').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    address: Joi.object({
      street1: Joi.string().trim().required().label('Street 1').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': '{{#label}} cannot be empty',
      }),
      street2: Joi.string().trim().allow(null, '').label('Street 2').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': '{{#label}} cannot be empty',
      }),
    })
      .required()
      .label('Address'),
    city: Joi.string().trim().required().label('City').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    state: Joi.string().trim().required().label('State').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    pinCode: Joi.string().trim().required().label('Pin Code').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    faxNumber: Joi.string().trim().allow(null, '').label('Fax Number').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    phone: Joi.string().trim().allow(null, '').label('Phone').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
  }),
};

const updateCustomerAddress = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    addressType: Joi.string()
      .required()
      .valid(...Object.values(ADDRESS_TYPE)),
  }),
  params: Joi.object().keys({
    addressId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object({
    attention: Joi.string().trim().allow(null, '').label('Attention').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    country: Joi.string().trim().required().label('Country').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    address: Joi.object({
      street1: Joi.string().trim().required().label('Street 1').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': '{{#label}} cannot be empty',
      }),
      street2: Joi.string().trim().allow(null, '').label('Street 2').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': '{{#label}} cannot be empty',
      }),
    })
      .required()
      .label('Address'),
    city: Joi.string().trim().required().label('City').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    state: Joi.string().trim().required().label('State').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    pinCode: Joi.string().trim().required().label('Pin Code').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    faxNumber: Joi.string().trim().allow(null, '').label('Fax Number').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    phone: Joi.string().trim().allow(null, '').label('Phone').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    isDefault: Joi.boolean().required(),
  }),
};

const getBusinessPartnerTeam = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().required().custom(objectId),
  }),
};

const createBusinessPartnerTeam = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().required().custom(objectId),
  }),
  body: businessPartnerTeamSchema.required(),
};

const updateBusinessPartnerTeam = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    businessPartnerTeamId: Joi.string().required().custom(objectId),
  }),
  body: businessPartnerTeamSchema.required(),
};

const deleteBusinessPartnerTeam = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    businessPartnerTeamId: Joi.string().required().custom(objectId),
  }),
};

const updateCustomerAddressStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    addressId: Joi.string().required().custom(objectId),
  }),
};

const getCustomerDetail = {
  params: Joi.object().keys({
    customerId: Joi.string().required().custom(objectId),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
  }),
  query: Joi.object().keys({
    isSplit: Joi.boolean().optional().allow(null),
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const updateStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isActive: Joi.boolean().required(),
    isCustomer: Joi.boolean().optional(),
    isVendor: Joi.boolean().optional(),
  }),
  params: Joi.object().keys({
    customerId: Joi.string().custom(objectId).required(),
  }),
};

const getPortalCustomers = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const getCustomer360Analysis = {
  params: Joi.object().keys({
    customerId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    fy: Joi.string().optional(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const getCustomerCreditDashboard = {
  params: Joi.object().keys({
    customerId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    fy: Joi.string().optional(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const getCreditOverview = {
  query: Joi.object()
    .keys({
      companyId: Joi.string().required().custom(objectId),
      isCustomer: Joi.boolean(),
      isVendor: Joi.boolean(),
    })
    .custom(requireOneOfCustomerOrVendor),
};

const getCreditUtilization = {
  query: Joi.object()
    .keys({
      companyId: Joi.string().required().custom(objectId),
      isCustomer: Joi.boolean(),
      isVendor: Joi.boolean(),
      sortBy: Joi.string(),
      limit: Joi.number().integer(),
      page: Joi.number().integer(),
      pagination: Joi.boolean(),
    })
    .custom(requireOneOfCustomerOrVendor),
};

const getOverLimitCustomers = {
  query: Joi.object()
    .keys({
      companyId: Joi.string().required().custom(objectId),
      isCustomer: Joi.boolean(),
      isVendor: Joi.boolean(),
      sortBy: Joi.string(),
      limit: Joi.number().integer(),
      page: Joi.number().integer(),
      pagination: Joi.boolean(),
    })
    .custom(requireOneOfCustomerOrVendor),
};

const resendPortalInvite = {
  params: Joi.object().keys({
    customerId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isCustomer: Joi.boolean().optional(),
  }),
};

const acceptCustomerVerification = {
  params: Joi.object().keys({
    customerId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isCustomer: Joi.boolean().optional(),
  }),
};

const rejectCustomerVerification = {
  params: Joi.object().keys({
    customerId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isCustomer: Joi.boolean().optional(),
  }),
};

const exportCustomers = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    status: Joi.string(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    appName: Joi.string().allow('', null).optional(),
    customerDate: Joi.date(),
    isCustomer: Joi.boolean(),
    isVendor: Joi.boolean(),
    isActive: Joi.boolean(),
    country: Joi.string().trim().optional(),
    state: Joi.string().trim().optional(),
    city: Joi.string().trim().optional(),
    verificationStatus: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED').optional(),
  }),
};

module.exports = {
  createCustomer,
  getCustomers,
  updateCustomer,
  deleteCustomer,
  getVenderDropdown,
  getCustomerDropdown,
  createBulkCustomers,
  verifyBulkCustomerCreation,
  bulkAddCustomerOpeningBalance,
  verifyBulkCustomerOpeningBalance,
  getAllCustomers,
  getCustomerById,
  getCustomerAddress,
  addCustomerShippingAddress,
  updateCustomerAddress,
  updateCustomerAddressStatus,
  getBusinessPartnerTeam,
  createBusinessPartnerTeam,
  updateBusinessPartnerTeam,
  deleteBusinessPartnerTeam,
  getCustomerDetail,
  updateStatus,
  getPortalCustomers,
  getCustomer360Analysis,
  getCustomerCreditDashboard,
  getCreditOverview,
  getCreditUtilization,
  getOverLimitCustomers,
  resendPortalInvite,
  acceptCustomerVerification,
  rejectCustomerVerification,
  exportCustomers,
};
