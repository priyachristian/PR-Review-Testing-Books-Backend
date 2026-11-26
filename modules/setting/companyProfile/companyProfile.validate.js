const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { MODULE_NAMES, PAYMENT_TERMS, SMTP_HOSTS } = require('../../../utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');

const additionalChargeSchema = Joi.object().keys({
  name: Joi.string().required().trim().label('Charge Name').messages({
    'string.base': '{{#label}} must be a string',
    'any.required': '{{#label}} is required',
  }),
  isTaxable: Joi.boolean().default(false).label('Is Taxable').messages({
    'boolean.base': '{{#label}} must be a boolean',
  }),
  isActive: Joi.boolean().default(false).label('Is Active').messages({
    'boolean.base': '{{#label}} must be a boolean',
  }),
  taxRate: Joi.number()
    .min(0)
    .when('isTaxable', {
      is: true,
      then: Joi.number().required(),
      otherwise: Joi.number().default(0),
    })
    .label('Tax Rate')
    .messages({
      'number.base': '{{#label}} must be a number',
      'number.min': '{{#label}} cannot be negative',
      'any.required': '{{#label}} is required when charge is taxable',
    }),
  modules: Joi.array()
    .items(
      Joi.string()
        .valid(...Object.values(MODULE_NAMES))
        .required(),
    )
    .default([])
    .label('Modules')
    .messages({
      'array.base': '{{#label}} must be an array',
      'string.base': 'Each module in {{#label}} must be a string',
      'any.only': 'Each module in {{#label}} must be a valid module name',
    }),
});

const updateCompany = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    name: Joi.string().optional().trim().label('Company Name').messages({
      'string.base': '{{#label}} must be a string',
    }),
    address: Joi.object()
      .keys({
        street1: Joi.string().optional().trim().label('Street 1').messages({
          'string.base': '{{#label}} must be a string',
        }),
        street2: Joi.string().optional().trim().label('Street 2').messages({
          'string.base': '{{#label}} must be a string',
        }),
        city: Joi.string().optional().trim().label('City').messages({
          'string.base': '{{#label}} must be a string',
        }),
        state: Joi.string().optional().trim().label('State').messages({
          'string.base': '{{#label}} must be a string',
        }),
        country: Joi.string().optional().trim().label('Country').messages({
          'string.base': '{{#label}} must be a string',
        }),
        pinCode: Joi.string().optional().trim().label('Pin Code').messages({
          'string.base': '{{#label}} must be a string',
        }),
        faxNumber: Joi.string().optional().trim().label('Fax Number').messages({
          'string.base': '{{#label}} must be a string',
        }),
      })
      .optional(),
    contactPhone: Joi.string().optional().trim().label('Contact Phone').messages({
      'string.base': '{{#label}} must be a string',
    }),
    gstNumber: Joi.string().optional().trim().label('GST Number').messages({
      'string.base': '{{#label}} must be a string',
    }),
    panNumber: Joi.string().optional().trim().label('PAN Number').messages({
      'string.base': '{{#label}} must be a string',
    }),
    iec: Joi.string().optional().trim().label('Import Export Code').messages({
      'string.base': '{{#label}} must be a string',
    }),
    baseCurrency: Joi.string().custom(objectId).optional().label('Base Currency').messages({
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    termsandConditions: Joi.string().optional().trim().label('Terms and Conditions').messages({
      'string.base': '{{#label}} must be a string',
    }),
    companyLogo: Joi.string().optional().trim().label('Company Logo').messages({
      'string.base': '{{#label}} must be a string',
    }),
    authorizedSignature: Joi.string().optional().trim().label('Authorized Signature').messages({
      'string.base': '{{#label}} must be a string',
    }),
    email: Joi.string().optional().trim().label('Email').messages({
      'string.base': '{{#label}} must be a string',
    }),
    fiscalYear: Joi.string().optional().allow(null, '').trim().label('Fiscal Year'),
    organizationLanguage: Joi.string().optional().allow(null, '').trim().label('Organization Language'),
    timeZone: Joi.string().optional().allow(null, '').trim().label('Time Zone'),
    dateFormat: Joi.string().optional().allow(null, '').trim().label('Date Format'),
  }),
};

const getComapny = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const addAdditionalCharge = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: additionalChargeSchema,
};

const updateAdditionalCharge = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    chargeName: Joi.string().required().trim().label('Charge Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
  body: additionalChargeSchema,
};

const deleteAdditionalCharge = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  params: Joi.object().keys({
    chargeName: Joi.string().required().trim().label('Charge Name').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

const inventoryConfigSchema = Joi.object().keys({
  salesFlowStockCheckSource: Joi.array()
    .items(
      Joi.string().valid(MODULE_NAMES.QUOTATION, MODULE_NAMES.SALES_ORDER, MODULE_NAMES.DELIVERY_CHALLAN, MODULE_NAMES.INVOICE),
    )
    .label('Sales Flow Stock Check Source')
    .messages({
      'array.base': '{{#label}} must be an array',
      'string.base': 'Each source in {{#label}} must be a string',
      'any.only': 'Each source in {{#label}} must be a valid module name',
    }),
  salesFlowStockDeductSource: Joi.string()
    .valid(MODULE_NAMES.DELIVERY_CHALLAN, MODULE_NAMES.INVOICE)
    .required()
    .label('Sales Flow Stock Deduct Source')
    .messages({
      'string.base': '{{#label}} must be a string',
      'any.only': '{{#label}} must be a valid module name',
      'any.required': '{{#label}} is required',
    }),
  purchaseFlowStockAddSource: Joi.string()
    .valid(MODULE_NAMES.GRPO, MODULE_NAMES.BILL)
    .required()
    .label('Purchase Order Stock Add Source')
    .messages({
      'string.base': '{{#label}} must be a string',
      'any.only': '{{#label}} must be a valid module name',
      'any.required': '{{#label}} is required',
    }),
});

const updateInventoryConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: inventoryConfigSchema,
};

const quotationConfigSchema = Joi.object().keys({
  terms: Joi.array().items(Joi.string().trim()).label('Terms and Conditions').messages({
    'array.base': '{{#label}} must be an array',
    'string.base': 'Each term in {{#label}} must be a string',
  }),
  quoteCloseReasons: Joi.array().items(Joi.string().trim()).label('Quote Close Reasons').messages({
    'array.base': '{{#label}} must be an array',
    'string.base': 'Each reason in {{#label}} must be a string',
  }),
  quoteSignatureImage: Joi.string().allow('').trim().label('Quote Signature Image').messages({
    'string.base': '{{#label}} must be a string',
  }),
  pdfTemplate: Joi.number().integer().min(1).label('PDF Template').messages({
    'number.base': '{{#label}} must be a number',
    'number.integer': '{{#label}} must be an integer',
    'number.min': '{{#label}} must be at least 1',
  }),
});

const updateQuotationConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: quotationConfigSchema,
};

const updateBranchConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    splitConfig: Joi.boolean().default(false).label('Split Config'),
    divisionId: Joi.string()
      .custom(objectId)
      .allow(null, '')
      .when('splitConfig', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      })
      .label('Division ID')
      .messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      }),
    branchId: Joi.string()
      .custom(objectId)
      .allow(null, '')
      .optional()
      .when('splitConfig', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      })
      .label('Branch ID')
      .messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      }),
    warehouseId: Joi.string()
      .custom(objectId)
      .allow(null, '')
      .when('splitConfig', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      })
      .label('Warehouse ID')
      .messages({
        'string.base': '{{#label}} must be a valid ObjectId',
      }),
  }),
};

const verifyOtp = {
  query: Joi.object().keys({
    pinNo: Joi.string().required().label('Pin Number').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const discountConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    isEnabled: Joi.boolean().default(false),

    appliesTo: Joi.string()
      .valid('TRANSACTION', 'ITEM', '', null)
      .when('isEnabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      })
      .label('Applies To')
      .messages({
        'any.only': '{{#label}} must be either "TRANSACTION" or "ITEM"',
      }),
  }),
};

const getAdditionalAddresses = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
};

const addAdditionalAddress = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object({
    street1: Joi.string().trim().required().label('Street 1').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    street2: Joi.string().trim().allow(null, '').label('Street 2').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    city: Joi.string().trim().required().label('City').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    state: Joi.string().trim().required().label('State').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    country: Joi.string().trim().required().label('Country').messages({
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

const updateAdditionalAddress = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    addressId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object({
    street1: Joi.string().trim().required().label('Street 1').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    street2: Joi.string().trim().allow(null, '').label('Street 2').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    city: Joi.string().trim().required().label('City').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    state: Joi.string().trim().required().label('State').messages({
      'string.base': '{{#label}} must be a string',
      'string.empty': '{{#label}} cannot be empty',
    }),
    country: Joi.string().trim().required().label('Country').messages({
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

const toggleAdditionalAddress = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    addressId: Joi.string().custom(objectId).required().label('Address ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const viewSubscription = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getBranchConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getInventoryConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const autoPayModuleConfigSchema = Joi.object()
  .keys({
    isEnabled: Joi.boolean().default(false).label('Is Enabled').messages({
      'boolean.base': '{{#label}} must be a boolean',
    }),
    scope: Joi.string().valid('ALL_BRANCHES', 'BRANCH_WISE').default('ALL_BRANCHES').label('Scope').messages({
      'any.only': '{{#label}} must be either ALL_BRANCHES or BRANCH_WISE',
      'string.base': '{{#label}} must be a string',
    }),
  })
  .required();

const autoPayConfigSchema = Joi.object()
  .keys({
    invoice: autoPayModuleConfigSchema.label('Invoice Auto Pay'),
    bill: autoPayModuleConfigSchema.label('Bill Auto Pay'),
  })
  .required();

const getAutoPayConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const updateAutoPayConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: autoPayConfigSchema,
};

const creditLimitRestrictedModules = [
  MODULE_NAMES.QUOTATION,
  MODULE_NAMES.SALES_ORDER,
  MODULE_NAMES.DELIVERY_CHALLAN,
  MODULE_NAMES.INVOICE,
  MODULE_NAMES.PURCHASE_ORDER,
  MODULE_NAMES.GRPO,
  MODULE_NAMES.BILL,
  MODULE_NAMES.EXPENSE,
];

const creditLimitBranchSchema = Joi.object().keys({
  divisionId: Joi.string().custom(objectId).optional().allow(null, '').label('Division ID').messages({
    'string.base': '{{#label}} must be a valid ObjectId',
  }),
  branchId: Joi.string().custom(objectId).optional().allow(null, '').label('Branch ID').messages({
    'string.base': '{{#label}} must be a valid ObjectId',
  }),
  isActive: Joi.boolean().optional().label('Is Active').messages({
    'boolean.base': '{{#label}} must be a boolean',
  }),
  branchCode: Joi.string().optional().trim().allow('').label('Branch Code').messages({
    'string.base': '{{#label}} must be a string',
  }),
  creditLimit: Joi.number().min(0).optional().default(0).label('Credit Limit').messages({
    'number.base': '{{#label}} must be a number',
    'number.min': '{{#label}} cannot be negative',
  }),
  restrictedModule: Joi.array()
    .items(Joi.string().valid(...creditLimitRestrictedModules))
    .optional()
    .default([])
    .label('Restricted Module')
    .messages({
      'array.base': '{{#label}} must be an array',
      'any.only': 'Each module in {{#label}} must be a valid module name',
    }),
  paymentTermsId: Joi.string().custom(objectId).optional().allow('', null).label('Payment Terms').messages({
    'string.base': '{{#label}} must be a string',
    'string.objectId': '{{#label}} must be a valid ObjectId',
  }),
  restrictedPaymentTermsModule: Joi.array()
    .items(Joi.string().valid(...creditLimitRestrictedModules))
    .optional()
    .default([])
    .label('Restricted Payment Terms Module')
    .messages({
      'array.base': '{{#label}} must be an array',
      'any.only': 'Each module in {{#label}} must be a valid module name',
    }),
});

const creditLimitConfigSchema = Joi.object().keys({
  branch: Joi.array().items(creditLimitBranchSchema).optional().default([]).label('Branch').messages({
    'array.base': '{{#label}} must be an array',
  }),
  useBranchCreditLimit: Joi.boolean().optional().default(false).label('Use Branch Credit Limit').messages({
    'boolean.base': '{{#label}} must be a boolean',
  }),
  creditLimit: Joi.number().min(0).optional().default(0).label('Credit Limit').messages({
    'number.base': '{{#label}} must be a number',
    'number.min': '{{#label}} cannot be negative',
  }),
  restrictedModule: Joi.array()
    .items(Joi.string().valid(...creditLimitRestrictedModules))
    .optional()
    .default([])
    .label('Restricted Module')
    .messages({
      'array.base': '{{#label}} must be an array',
      'any.only': 'Each module in {{#label}} must be a valid module name',
    }),
  paymentTermsId: Joi.string().custom(objectId).optional().allow('', null).label('Payment Terms').messages({
    'string.base': '{{#label}} must be a string',
    'string.objectId': '{{#label}} must be a valid ObjectId',
  }),
  restrictedPaymentTermsModule: Joi.array()
    .items(Joi.string().valid(...creditLimitRestrictedModules))
    .optional()
    .default([])
    .label('Restricted Payment Terms Module')
    .messages({
      'array.base': '{{#label}} must be an array',
      'any.only': 'Each module in {{#label}} must be a valid module name',
    }),
  useBranchPaymentTerms: Joi.boolean().optional().default(false).label('Use Branch Payment Terms').messages({
    'boolean.base': '{{#label}} must be a boolean',
  }),
});

const updateCreditLimitConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object()
    .keys({
      salesCreditLimit: creditLimitConfigSchema.optional(),
      purchaseCreditLimit: creditLimitConfigSchema.optional(),
    })
    .min(1)
    .messages({
      'object.min': 'At least one of salesCreditLimit or purchaseCreditLimit is required',
    }),
};

const getCompanyCreditLimitConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const getQuotationConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const updateQuotationConfigByCompanyId = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    quoteCloseReasons: Joi.array().items(Joi.string().trim()).unique().messages({
      'array.unique': 'Quote close reasons must be unique; duplicate values are not allowed',
    }),
  }),
};

const companyIdQuery = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const updateRejectionWarehouseConfig = {
  ...companyIdQuery,
  body: Joi.object().keys({
    reuseWarehouseId: Joi.string().custom(objectId).allow(null, '').optional().label('Reuse Warehouse'),
    returnWarehouseId: Joi.string().custom(objectId).allow(null, '').optional().label('Return Warehouse'),
    scrapWarehouseId: Joi.string().custom(objectId).allow(null, '').optional().label('Scrap Warehouse'),
  }),
};

const getRejectionWarehouseConfig = companyIdQuery;

const getCompanyCode = companyIdQuery;

const generateCompanyCode = companyIdQuery;

const emailConfigurationSchema = Joi.object({
  smtpHost: Joi.string()
    .trim()
    .valid(...Object.values(SMTP_HOSTS))
    .required()
    .label('SMTP Host'),
  smtpPort: Joi.number().integer().min(1).max(65535).required().label('SMTP Port'),
  secure: Joi.boolean().default(false).label('Secure'),
  username: Joi.string().trim().required().label('Username'),
  password: Joi.string().trim().required().label('Password'),
});

const moduleEmailConfigSchema = Joi.object({
  moduleName: Joi.string()
    .valid(...Object.values(MODULE_NAMES))
    .required()
    .label('Module Name'),
  isEnabled: Joi.boolean().required().label('Is Enabled'),
  isWhatsAppEnabled: Joi.boolean().required().label('Is WhatsApp Enabled'),
});

const updateEmailConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    isEmailEnabled: Joi.boolean().required().label('Is Email Enabled').messages({
      'boolean.base': '{{#label}} must be a boolean',
      'any.required': '{{#label}} is required',
    }),
    emailConfiguration: emailConfigurationSchema.when('isEmailEnabled', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  }),
};

const getEmailConfig = companyIdQuery;

const getModuleEmailConfig = companyIdQuery;

const updateModuleEmailConfig = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object().keys({
    moduleEmailConfig: Joi.array().items(moduleEmailConfigSchema).min(1).required().label('Module Email Config'),
  }),
};

const testEmailConfig = {
  body: Joi.object().keys({
    smtpHost: Joi.string().required(),
    smtpPort: Joi.number().required(),
    secure: Joi.boolean().required(),
    username: Joi.string().email().required(),
    password: Joi.string().required(),
  }),
};
const HH_MM_TIME = Joi.string()
  .pattern(/^([01]\d|2[0-3]):([0-5]\d)$/)
  .label('Time')
  .messages({
    'string.pattern.base': '{{#label}} must be in HH:mm format (00:00–23:59)',
  });

const WEEK_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const dailyScheduleSchema = Joi.object({
  enabled: Joi.boolean().required().label('Daily Enabled'),

  time: Joi.when('enabled', {
    is: true,
    then: HH_MM_TIME.required(),
    otherwise: HH_MM_TIME.optional().allow(null, ''),
  }).label('Daily Time'),

  incremental: Joi.boolean().default(false).label('Daily Incremental'),
}).label('Daily');

const weeklyScheduleSchema = Joi.object({
  enabled: Joi.boolean().required().label('Weekly Enabled'),

  day: Joi.when('enabled', {
    is: true,
    then: Joi.string()
      .valid(...WEEK_DAYS)
      .required(),
    otherwise: Joi.string()
      .valid(...WEEK_DAYS)
      .optional()
      .allow(null, ''),
  }).label('Weekly Day'),

  time: Joi.when('enabled', {
    is: true,
    then: HH_MM_TIME.required(),
    otherwise: HH_MM_TIME.optional().allow(null, ''),
  }).label('Weekly Time'),

  incremental: Joi.boolean().default(false).label('Weekly Incremental'),
}).label('Weekly');

const monthlyScheduleSchema = Joi.object({
  enabled: Joi.boolean().required().label('Monthly Enabled'),

  date: Joi.when('enabled', {
    is: true,
    then: Joi.number().integer().min(1).max(31).required(),
    otherwise: Joi.number().integer().min(1).max(31).optional().allow(null),
  }).label('Monthly Date'),

  time: Joi.when('enabled', {
    is: true,
    then: HH_MM_TIME.required(),
    otherwise: HH_MM_TIME.optional().allow(null, ''),
  }).label('Monthly Time'),
}).label('Monthly');

const TEMPLATE_KEYS = [
  'financialSummary',
  'dailyActivityByUser',
  'salesPipeline',
  'quotationsSummary',
  'receivablesAging',
  'payablesDues',
  'lowStockAlerts',
  'inventoryMovement',
  'productionSummary',
  'topPerformers',
  'pendingDrafts',
];

const PHONE_NUMBER_PATTERN = /^\+?[0-9]{10,15}$/;

const phoneNumberSchema = Joi.string().trim().pattern(PHONE_NUMBER_PATTERN).messages({
  'string.pattern.base': 'Admin phone number must be a valid phone number (10–15 digits)',
});

// How many admin phone numbers can be added per template is fully plan-driven —
// enforced dynamically against Plan.limits WHATSAPP_CONFIG in
// companyProfile.service.js#updateAdminSummarySetting, not here.
const templateConfigSchema = Joi.object()
  .keys({
    key: Joi.string()
      .valid(...TEMPLATE_KEYS)
      .required()
      .label('Template'),
    enabled: Joi.boolean().default(false).label('Template Enabled'),
    adminPhoneNumber: Joi.array()
      .items(phoneNumberSchema)
      .default([])
      .when('enabled', {
        is: true,
        then: Joi.array().items(phoneNumberSchema).min(1).required().messages({
          'array.min': 'At least one admin phone number is required when template is enabled',
          'any.required': 'Admin phone number is required when template is enabled',
        }),
      })
      .label('Admin Phone Number'),
    daily: dailyScheduleSchema.allow(null).optional(),
    weekly: weeklyScheduleSchema.allow(null).optional(),
    monthly: monthlyScheduleSchema.allow(null).optional(),
  })
  .custom((value, helpers) => {
    const scheduleCount = [value.daily, value.weekly, value.monthly].filter(Boolean).length;
    if (value.enabled && scheduleCount === 0) {
      return helpers.message('Each enabled template needs at least one of daily, weekly, or monthly');
    }
    return value;
  })
  .label('Template Config');

const adminSummaryWhatsappSchema = Joi.object()
  .keys({
    templates: Joi.array().items(templateConfigSchema).default([]).label('Templates'),
  })
  .label('WhatsApp');

const getAdminSummarySetting = companyIdQuery;

const updateAdminSummarySetting = {
  ...companyIdQuery,
  body: Joi.object()
    .keys({
      whatsapp: adminSummaryWhatsappSchema.required(),
    })
    .required(),
};

module.exports = {
  updateCompany,
  getComapny,
  getCompanyCode,
  generateCompanyCode,
  addAdditionalCharge,
  updateAdditionalCharge,
  deleteAdditionalCharge,
  updateInventoryConfig,
  updateQuotationConfig,
  updateBranchConfig,
  verifyOtp,
  discountConfig,
  addAdditionalAddress,
  getAdditionalAddresses,
  updateAdditionalAddress,
  toggleAdditionalAddress,
  viewSubscription,
  getBranchConfig,
  getInventoryConfig,
  getAutoPayConfig,
  updateAutoPayConfig,
  updateCreditLimitConfig,
  getCompanyCreditLimitConfig,
  getQuotationConfig,
  updateQuotationConfigByCompanyId,
  updateRejectionWarehouseConfig,
  getRejectionWarehouseConfig,
  updateEmailConfig,
  getEmailConfig,
  getModuleEmailConfig,
  updateModuleEmailConfig,
  testEmailConfig,
  getAdminSummarySetting,
  updateAdminSummarySetting,
};
