const Joi = require('joi');
const { objectId } = require('./custom.validation');
const { TAX_TYPES } = require('../utils/enum');

/**
 * Common validation schemas that can be reused across modules
 */
const commonSchemas = {
  /**
   * ObjectId validation with custom label and messages
   * @param {Object} config - Configuration object
   * @param {string} config.label - Field label
   * @param {boolean} [config.isRequired=false] - Whether the field is required
   * @param {boolean} [config.isOptional=false] - Whether the field is optional
   * @returns {Joi.StringSchema} - Joi schema
   */
  objectId: ({ label, isRequired = false, isOptional = false, allow = [] }) => {
    let schema = Joi.string().custom(objectId).label(label).messages({
      'string.base': `{{#label}} must be a valid ObjectId`,
    });

    if (allow.length > 0) {
      schema = schema.allow(...allow);
    }

    if (isOptional) {
      schema = schema.optional();
    }

    if (isRequired) {
      schema = schema.required().messages({
        'any.required': `{{#label}} is required`,
      });
    }

    return schema;
  },

  /**
   * String validation with custom label and messages
   * @param {Object} config - Configuration object
   * @param {string} config.label - Field label
   * @param {boolean} [config.isRequired=false] - Whether the field is required
   * @param {boolean} [config.allowEmpty=true] - Whether to allow empty string
   * @param {boolean} [config.isOptional=false] - Whether the field is optional
   * @returns {Joi.StringSchema} - Joi schema
   */
  string: ({ label, isRequired = false, allowEmpty = true, isOptional = false }) => {
    let schema = Joi.string().label(label).messages({
      'string.base': `{{#label}} must be a string`,
    });

    if (allowEmpty) {
      schema = schema.allow('');
    }

    if (isOptional) {
      schema = schema.optional();
    }

    if (isRequired) {
      schema = schema.required().messages({
        'any.required': `{{#label}} is required`,
      });
    }

    return schema;
  },

  /**
   * Number validation with custom label and messages
   * @param {Object} config - Configuration object
   * @param {string} config.label - Field label
   * @param {boolean} [config.isRequired=false] - Whether the field is required
   * @param {boolean} [config.isOptional=false] - Whether the field is optional
   * @returns {Joi.NumberSchema} - Joi schema
   */
  number: ({ label, isRequired = false, isOptional = false }) => {
    let schema = Joi.number().label(label).messages({
      'number.base': `{{#label}} must be a number`,
    });

    if (isOptional) {
      schema = schema.optional();
    }

    if (isRequired) {
      schema = schema.required().messages({
        'any.required': `{{#label}} is required`,
      });
    }

    return schema;
  },

  /**
   * Date validation with custom label and messages
   * @param {Object} config - Configuration object
   * @param {string} config.label - Field label
   * @param {boolean} [config.isRequired=false] - Whether the field is required
   * @param {boolean} [config.isOptional=false] - Whether the field is optional
   * @returns {Joi.DateSchema} - Joi schema
   */
  date: ({ label, isRequired = false, isOptional = false }) => {
    let schema = Joi.date().label(label).messages({
      'date.base': `{{#label}} must be a valid date`,
    });

    if (isOptional) {
      schema = schema.optional();
    }

    if (isRequired) {
      schema = schema.required().messages({
        'any.required': `{{#label}} is required`,
      });
    }

    return schema;
  },

  /**
   * Query parameters for pagination
   * @returns {Joi.ObjectSchema} - Joi schema
   */
  paginationQuery: () => ({
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),

  /**
   * Date range parameters
   * @returns {Joi.ObjectSchema} - Joi schema
   */
  dateRangeQuery: () => ({
    startDate: Joi.date(),
    endDate: Joi.date(),
  }),
};

/**
 * Creates param validation for an ID field
 * @param {Object} config - Configuration object
 * @param {string} config.paramName - Parameter name
 * @param {string} config.label - Label for the ID field
 * @param {boolean} [config.isRequired=true] - Whether the ID is required
 * @returns {Object} - Validation object
 */
const createIdParamValidation = ({ paramName, label, isRequired = true }) => ({
  params: Joi.object().keys({
    [paramName]: commonSchemas.objectId({ label, isRequired }),
  }),
});

const discountValidation = Joi.object({
  discountType: Joi.string().valid('PERCENTAGE', 'AMOUNT').label('Discount Type').messages({
    'any.only': '{{#label}} must be either "PERCENTAGE" or "AMOUNT"',
  }),

  discountValue: Joi.number().min(0).label('Discount Value').messages({
    'number.base': '{{#label}} must be a number',
  }),
});

/**
 * Creates a reusable line item schema that can be used across modules
 * @param {Object} config - Configuration object
 * @param {boolean} [config.forCreation=true] - Whether the schema is for item creation
 * @param {boolean} [config.requireItemUnit=true] - Accountant modules have no unit in UI; set false to allow omit/empty
 * @returns {Joi.ObjectSchema} - Joi schema for line items
 */
const createItemSchema = ({ forCreation = true, requireItemUnit = true } = {}) => {
  const itemUnitSchema = requireItemUnit
    ? Joi.string().required().label('Item Unit').messages({
        'string.base': '{{#label}} must be a string',
        'any.required': '{{#label}} is required',
      })
    : Joi.string().optional().allow('', null).label('Item Unit').messages({
        'string.base': '{{#label}} must be a string',
        'any.only': '{{#label}} must be one of the following values: ',
      });

  const itemIdSchema = requireItemUnit
    ? commonSchemas.objectId({ label: 'Item ID', isRequired: forCreation })
    : Joi.alternatives().try(Joi.string().custom(objectId), Joi.valid(null, '')).label('Item ID').optional();

  const baseSchema = {
    itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: forCreation }),
    itemNo: commonSchemas.string({ label: 'Item No' }),
    description: commonSchemas.string({ label: 'Description' }),
    itemName: commonSchemas.string({ label: 'Item Name' }),
    accountId: commonSchemas.objectId({ label: 'Account ID', allowEmpty: true, isOptional: true }),
    quantity: commonSchemas.number({ label: 'Quantity', isRequired: true }),
    rate: commonSchemas.number({ label: 'Rate', isRequired: true }),
    gst: commonSchemas.string({ label: 'GST' }),
    hsnCode: commonSchemas.string({ label: 'HSN Code' }),
    itemUnit: itemUnitSchema,
    itemUnitId: Joi.string().custom(objectId).allow(null, '').optional().label('Item Unit ID').messages({
      'string.base': '{{#label}} must be a valid string (ObjectId)',
    }),
    taxAmount: commonSchemas.number({ label: 'Tax Amount' }),
    amount: commonSchemas.number({ label: 'Amount', isRequired: true }),
    // ✅ New fields added
    referenceId: commonSchemas.objectId({
      label: 'Reference ID',
      isOptional: true,
      allowEmpty: true,
    }),
    referenceType: commonSchemas.string({
      label: 'referenceType',
      isOptional: true,
      allowEmpty: true,
    }),
    referenceNo: commonSchemas.string({ label: 'referenceNo', isOptional: true, allowEmpty: true }),
    finalQty: Joi.number().allow(null).optional().label('Final Quantity'),
    splitQty: Joi.number().allow(null).optional().label('Split Quantity'),
    splitRate: Joi.number().allow(null).optional().label('Split Rate'),
    finalRate: Joi.number().allow(null).optional().label('Final Rate'),
    splitAmount: Joi.number().allow(null).optional().label('Split Amount'),
    discountConfig: discountValidation,
    batchNo: Joi.number().allow(null, '').optional().label('batchNo'),
    vendorBatchNo: Joi.string().optional().allow(null, ''),
    vendorBatchExpiry: Joi.date().optional().allow(null, ''),
    batchExpiryDateMandatory: Joi.boolean().optional().allow(null, ''),
    batchNumberMandatory: Joi.boolean().optional().allow(null, ''),
  };

  return Joi.object(baseSchema);
};

/**
 * Creates a schema for tax information
 * @param {Object} config - Configuration object
 * @param {Array} config.taxTypes - Valid tax types
 * @returns {Joi.ObjectSchema} - Joi schema for tax
 */
const createTaxSchema = ({ taxTypes }) =>
  Joi.object({
    type: Joi.string()
      .valid(...taxTypes)
      .label('Tax Type')
      .messages({
        'string.base': '{{#label}} must be a valid tax type',
      }),
    taxId: commonSchemas.objectId({ label: 'Tax' }),
    taxName: commonSchemas.string({ label: 'Tax Name' }),
    sectionId: commonSchemas.objectId({ label: 'Section' }),
    sectionNo: commonSchemas.string({ label: 'Section No' }),
    sectionName: commonSchemas.string({ label: 'Section Name' }),
    paymentCode: commonSchemas.string({ label: 'Payment Code' }).allow(null),
    rate: commonSchemas.number({ label: 'Tax Rate' }).min(0).max(100),
    amount: commonSchemas.number({ label: 'Tax Amount' }).min(0),
  }).allow(null);

/**
 * Creates a schema for adjustment information
 * @returns {Joi.ObjectSchema} - Joi schema for adjustment
 */
const createAdjustmentSchema = () =>
  Joi.object({
    description: commonSchemas.string({ label: 'Adjustment Description' }),
    amount: commonSchemas.number({ label: 'Adjustment Amount' }),
  });

/**
 * Base validation schema for common fields across models
 */
const baseValidationSchema = Joi.object().keys({
  divisionId: commonSchemas.objectId({ label: 'Division ID', isRequired: true }),
  branchId: commonSchemas.objectId({ label: 'Branch ID', isRequired: true }),
  warehouseId: commonSchemas.objectId({ label: 'Warehouse ID', isRequired: true }),
  items: Joi.array()
    .items(createItemSchema({ forCreation: true }))
    .label('Items')
    .messages({
      'array.base': '{{#label}} must be an array of valid items',
    }),
  sgst: commonSchemas.number({ label: 'SGST', allowEmpty: true }),
  cgst: commonSchemas.number({ label: 'CGST', allowEmpty: true }),
  igst: commonSchemas.number({ label: 'IGST', allowEmpty: true }),
  totalTax: commonSchemas.number({ label: 'Total Tax', allowEmpty: true }),
  discount: commonSchemas.number({ label: 'Discount', allowEmpty: true }),
  tax: createTaxSchema({ taxTypes: Object.values(TAX_TYPES) }),
  adjustment: createAdjustmentSchema(),
  additionalCharges: Joi.array()
    .items(
      Joi.object({
        name: commonSchemas.string({ label: 'Charge Name', isRequired: true }),
        amount: commonSchemas.number({ label: 'Charge Amount', isRequired: true }),
        isTaxable: Joi.boolean().default(false),
        taxRate: commonSchemas.number({ label: 'Tax Rate', allowEmpty: true }).min(0),
      }),
    )
    .label('Additional Charges'),
  subTotal: commonSchemas.number({ label: 'Sub Total', isRequired: true }),
  total: commonSchemas.number({ label: 'Total', isRequired: true }),
  isRoundOff: Joi.boolean().default(true).label('Is Round Off'),
  roundOffAmount: commonSchemas.number({ label: 'Round Off Amount', allowEmpty: true }),
  currencyId: commonSchemas.objectId({ label: 'Currency ID', isOptional: true }),
  exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate'),
  addedBy: commonSchemas.objectId({ label: 'Added By' }),
  updatedBy: commonSchemas.objectId({ label: 'Updated By', isOptional: true }),
});

/**
 * Sales base validation schema extending base schema with customerId
 */
const salesBaseValidationSchema = baseValidationSchema.keys({
  customerId: commonSchemas.objectId({ label: 'Customer ID', isRequired: true }),
});

/**
 * Purchase base validation schema extending base schema with supplierId
 */
const purchaseBaseValidationSchema = baseValidationSchema.keys({
  vendorId: commonSchemas.objectId({ label: 'Vendor ID', isRequired: true }),
});

// User-confirmed activations on a purchase document save.
const purchaseActivationKeys = {
  activateVendorBranch: Joi.boolean().optional().label('Activate Vendor In Branch'),
  activateItemWarehouse: Joi.boolean().optional().label('Activate Items In Warehouse'),
};

const validateFutureDate = (value, helpers) => {
  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth();
  const todayDay = today.getDate();

  const inputDate = new Date(value);
  const inputYear = inputDate.getFullYear();
  const inputMonth = inputDate.getMonth();
  const inputDay = inputDate.getDate();

  if (
    inputYear > todayYear ||
    (inputYear === todayYear && inputMonth > todayMonth) ||
    (inputYear === todayYear && inputMonth === todayMonth && inputDay > todayDay)
  ) {
    return helpers.message('{{#label}} cannot be a future date');
  }
  return value;
};

const validateEndDateAfterStart = (value, helpers) => {
  const { startDate } = helpers.state.ancestors[0];
  if (startDate && new Date(value) < new Date(startDate)) {
    return helpers.message('{{#label}} cannot be before start date');
  }
  return value;
};

// Custom validator for comma-separated mongo ObjectIds
const commaSeparatedObjectIds = (value, helpers) => {
  // Allow empty string, null, or undefined
  if (!value || value === '' || value === null || value === undefined) {
    return value;
  }

  // If it's an array, validate each element
  if (Array.isArray(value)) {
    for (const id of value) {
      if (typeof id !== 'string' || !id.match(/^[0-9a-fA-F]{24}$/)) {
        return helpers.message('{{#label}} must contain valid mongo ObjectIds');
      }
    }
    return value;
  }

  // If it's a string, check if it's comma-separated
  if (typeof value === 'string') {
    // Single ObjectId
    if (value.match(/^[0-9a-fA-F]{24}$/)) {
      return value;
    }
    // Comma-separated ObjectIds
    const ids = value
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);
    if (ids.length === 0) {
      return helpers.message('{{#label}} must contain at least one valid mongo ObjectId');
    }
    for (const id of ids) {
      if (!id.match(/^[0-9a-fA-F]{24}$/)) {
        return helpers.message('{{#label}} must be a valid mongo ObjectId or comma-separated mongo ObjectIds');
      }
    }
    return value;
  }

  return helpers.message('{{#label}} must be a string, array, or comma-separated string of valid mongo ObjectIds');
};

module.exports = {
  commonSchemas,
  createIdParamValidation,
  createItemSchema,
  createTaxSchema,
  createAdjustmentSchema,
  baseValidationSchema,
  salesBaseValidationSchema,
  purchaseBaseValidationSchema,
  purchaseActivationKeys,
  discountValidation,
  validateFutureDate,
  validateEndDateAfterStart,
  commaSeparatedObjectIds,
};
