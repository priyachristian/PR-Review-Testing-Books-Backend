const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const {
  validateFutureDate,
  validateEndDateAfterStart,
  commaSeparatedObjectIds,
} = require('../../../validations/common.validation');

// Custom validators for upcoming payments
const validateStartDateNotPast = (value, helpers) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const inputDate = new Date(value);
  inputDate.setHours(0, 0, 0, 0);

  if (inputDate < today) {
    return helpers.message('Start date cannot be in the past');
  }
  return value;
};

const validateEndDateFuture = (value, helpers) => {
  const { startDate } = helpers.state.ancestors[0];
  if (!startDate) return value;

  const start = new Date(startDate);
  const end = new Date(value);
  const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

  if (end <= start) {
    return helpers.message('End date must be after start date');
  }
  if (daysDiff > 365) {
    return helpers.message('End date must be future date within 365 days');
  }
  return value;
};

const getCustomerAging = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('Start Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate),
      )
      .optional(),
    endDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('End Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate)
          .custom(validateEndDateAfterStart),
      )
      .optional(),
    numberOfColumns: Joi.number().integer().min(1).max(10).required().label('Number of Columns').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'number.min': '{{#label}} must be at least 1',
      'number.max': '{{#label}} must be at most 10',
    }),
    columnType: Joi.string().valid('days', 'weeks', 'months', 'years').required().label('Column Type').messages({
      'any.required': '{{#label}} is required',
      'any.only': '{{#label}} must be one of: days, weeks, months, years',
    }),
    duration: Joi.number().integer().min(1).required().label('Duration').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'number.min': '{{#label}} must be at least 1',
    }),
    customerIds: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Customer IDs'),
    divisionId: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Division ID'),
    branchId: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Branch ID'),
    sortBy: Joi.string()
      .optional()
      .allow(null, '')
      .pattern(/^[a-zA-Z0-9_]+:(asc|desc)$/)
      .label('Sort By')
      .messages({
        'string.pattern.base': '{{#label}} must be in format "field:asc" or "field:desc"',
      }),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
  }),
};

const getVendorAging = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('Start Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate),
      )
      .optional(),
    endDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('End Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate)
          .custom(validateEndDateAfterStart),
      )
      .optional(),
    numberOfColumns: Joi.number().integer().min(1).max(10).required().label('Number of Columns').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'number.min': '{{#label}} must be at least 1',
      'number.max': '{{#label}} must be at most 10',
    }),
    columnType: Joi.string().valid('days', 'weeks', 'months', 'years').required().label('Column Type').messages({
      'any.required': '{{#label}} is required',
      'any.only': '{{#label}} must be one of: days, weeks, months, years',
    }),
    duration: Joi.number().integer().min(1).required().label('Duration').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'number.min': '{{#label}} must be at least 1',
    }),
    vendorIds: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Vendor IDs'),
    divisionId: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Division ID'),
    branchId: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Branch ID'),
    sortBy: Joi.string()
      .optional()
      .allow(null, '')
      .pattern(/^[a-zA-Z0-9_]+:(asc|desc)$/)
      .label('Sort By')
      .messages({
        'string.pattern.base': '{{#label}} must be in format "field:asc" or "field:desc"',
      }),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
  }),
};

const getCustomerAgingDetails = {
  params: Joi.object()
    .keys({
      customerId: Joi.string().required().custom(objectId).label('Customer ID').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a valid ObjectId',
      }),
    })
    .unknown(false),
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.date()
      .iso()
      .required()
      .label('Start Date')
      .messages({
        'any.required': '{{#label}} is required',
        'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
        'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
      })
      .custom(validateFutureDate),
    endDate: Joi.date()
      .iso()
      .required()
      .label('End Date')
      .messages({
        'any.required': '{{#label}} is required',
        'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
        'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
      })
      .custom(validateFutureDate)
      .custom(validateEndDateAfterStart),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
  }),
};

const getVendorAgingDetails = {
  params: Joi.object()
    .keys({
      vendorId: Joi.string().required().custom(objectId).label('Vendor ID').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a valid ObjectId',
      }),
    })
    .unknown(false),
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.date()
      .iso()
      .required()
      .label('Start Date')
      .messages({
        'any.required': '{{#label}} is required',
        'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
        'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
      })
      .custom(validateFutureDate),
    endDate: Joi.date()
      .iso()
      .required()
      .label('End Date')
      .messages({
        'any.required': '{{#label}} is required',
        'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
        'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
      })
      .custom(validateFutureDate)
      .custom(validateEndDateAfterStart),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
  }),
};

const getCustomerAgingBucket = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('Start Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate),
      )
      .optional(),
    endDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('End Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate)
          .custom(validateEndDateAfterStart),
      )
      .optional(),
    minDays: Joi.number().integer().min(0).required().label('Min Days').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'number.min': '{{#label}} must be at least 0',
    }),
    maxDays: Joi.number()
      .integer()
      .min(0)
      .allow(null, '')
      .optional()
      .label('Max Days')
      .messages({
        'number.base': '{{#label}} must be a number',
        'number.integer': '{{#label}} must be an integer',
        'number.min': '{{#label}} must be at least 0',
      })
      .custom((value, helpers) => {
        const { minDays } = helpers.state.ancestors[0];
        if (value !== null && value !== undefined && value !== '' && minDays !== undefined && value < minDays) {
          return helpers.message('{{#label}} cannot be less than minDays');
        }
        return value;
      }),
    customerIds: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Customer IDs'),
    branchId: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Branch ID'),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
  }),
};

const getVendorAgingBucket = {
  query: Joi.object().keys({
    companyId: Joi.string()
      .required()
      .custom(objectId)
      .label('Company ID')
      .messages({ 'any.required': '"Company ID" is required' }),
    startDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('Start Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate),
      )
      .optional(),
    endDate: Joi.alternatives()
      .try(
        Joi.string().allow(null, '').empty(''),
        Joi.date()
          .iso()
          .label('End Date')
          .messages({
            'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
            'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
          })
          .custom(validateFutureDate)
          .custom(validateEndDateAfterStart),
      )
      .optional(),
    minDays: Joi.number().integer().min(0).required().label('Min Days').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'number.min': '{{#label}} must be at least 0',
    }),
    maxDays: Joi.number()
      .integer()
      .min(0)
      .allow(null, '')
      .optional()
      .label('Max Days')
      .messages({
        'number.base': '{{#label}} must be a number',
        'number.integer': '{{#label}} must be an integer',
        'number.min': '{{#label}} must be at least 0',
      })
      .custom((value, helpers) => {
        const { minDays } = helpers.state.ancestors[0];
        if (value !== null && value !== undefined && value !== '' && minDays !== undefined && value < minDays) {
          return helpers.message('{{#label}} cannot be less than minDays');
        }
        return value;
      }),
    vendorIds: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Vendor IDs'),
    branchId: Joi.alternatives()
      .try(Joi.string().custom(commaSeparatedObjectIds).allow(''), Joi.array().items(Joi.string().custom(objectId)).min(1))
      .optional()
      .allow(null, '')
      .label('Branch ID'),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
  }),
};

const getUpcomingPayments = {
  query: Joi.object()
    .keys({
      companyId: Joi.string()
        .required()
        .custom(objectId)
        .label('Company ID')
        .messages({ 'any.required': '"Company ID" is required' }),
      branchId: Joi.alternatives()
        .try(
          Joi.string()
            .allow('', null)
            .custom((value, helpers) => {
              // Allow empty/null values
              if (!value || value === '' || value === null || value === undefined) {
                return value; // Return as-is, will be handled by .optional()
              }
              // Validate comma-separated ObjectIds
              const ids = value
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);
              if (ids.length === 0) {
                return value; // Empty after filtering, allow it
              }
              for (const id of ids) {
                if (!id.match(/^[0-9a-fA-F]{24}$/)) {
                  return helpers.message('{{#label}} must be a valid mongo id');
                }
              }
              return value;
            })
            .label('Branch ID'),
          Joi.array().items(Joi.string().custom(objectId).label('Branch ID')).label('Branch IDs'),
        )
        .optional()
        .allow(null, '')
        .messages({
          'string.base': '{{#label}} must be a valid ObjectId',
          'array.base': '{{#label}} must be an array of ObjectIds',
        }),
      startDate: Joi.date()
        .iso()
        .required()
        .label('Start Date')
        .messages({
          'any.required': '{{#label}} is required',
          'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
          'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
        })
        .custom(validateStartDateNotPast),
      endDate: Joi.date()
        .iso()
        .required()
        .label('End Date')
        .messages({
          'any.required': '{{#label}} is required',
          'date.base': '{{#label}} must be a valid ISO date (YYYY-MM-DD)',
          'date.format': '{{#label}} must be in ISO format (YYYY-MM-DD)',
        })
        .custom(validateEndDateFuture),
      numberOfColumns: Joi.number().integer().min(1).max(10).required().label('Number of Columns').messages({
        'any.required': '{{#label}} is required',
        'number.base': '{{#label}} must be a number',
        'number.integer': '{{#label}} must be an integer',
        'number.min': '{{#label}} must be at least 1',
        'number.max': '{{#label}} must be at most 10',
      }),
      columnType: Joi.string().valid('days', 'weeks', 'months').required().label('Column Type').messages({
        'any.required': '{{#label}} is required',
        'any.only': '{{#label}} must be one of: days, weeks, months',
      }),
      duration: Joi.number().integer().min(1).max(100).required().label('Duration').messages({
        'any.required': '{{#label}} is required',
        'number.base': '{{#label}} must be a number',
        'number.integer': '{{#label}} must be an integer',
        'number.min': '{{#label}} must be at least 1',
        'number.max': '{{#label}} must be at most 100',
      }),
      customerIds: Joi.alternatives()
        .try(
          Joi.string()
            .allow('', null)
            .custom((value, helpers) => {
              // Allow empty/null values
              if (!value || value === '' || value === null || value === undefined) {
                return value; // Return as-is, will be handled by .optional()
              }
              // Validate comma-separated ObjectIds
              const ids = value
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);
              if (ids.length === 0) {
                return value; // Empty after filtering, allow it
              }
              for (const id of ids) {
                if (!id.match(/^[0-9a-fA-F]{24}$/)) {
                  return helpers.message('{{#label}} must be a valid mongo id');
                }
              }
              return value;
            })
            .label('Customer ID'),
          Joi.array().items(Joi.string().custom(objectId).label('Customer ID')).label('Customer IDs'),
        )
        .optional()
        .allow(null, '')
        .messages({
          'string.base': '{{#label}} must be a valid ObjectId',
          'array.base': '{{#label}} must be an array of ObjectIds',
        }),
      vendorIds: Joi.alternatives()
        .try(
          Joi.string()
            .allow('', null)
            .custom((value, helpers) => {
              // Allow empty/null values
              if (!value || value === '' || value === null || value === undefined) {
                return value; // Return as-is, will be handled by .optional()
              }
              // Validate comma-separated ObjectIds
              const ids = value
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);
              if (ids.length === 0) {
                return value; // Empty after filtering, allow it
              }
              for (const id of ids) {
                if (!id.match(/^[0-9a-fA-F]{24}$/)) {
                  return helpers.message('{{#label}} must be a valid mongo id');
                }
              }
              return value;
            })
            .label('Vendor ID'),
          Joi.array().items(Joi.string().custom(objectId).label('Vendor ID')).label('Vendor IDs'),
        )
        .optional()
        .allow(null, '')
        .messages({
          'string.base': '{{#label}} must be a valid ObjectId',
          'array.base': '{{#label}} must be an array of ObjectIds',
        }),
      sortBy: Joi.string()
        .optional()
        .allow(null, '')
        .pattern(/^[a-zA-Z0-9_]+:(asc|desc)$/)
        .label('Sort By')
        .messages({
          'string.pattern.base': '{{#label}} must be in format "field:asc" or "field:desc"',
        }),
    })
    .unknown(false), // Reject unknown query parameters
};

module.exports = {
  getCustomerAging,
  getVendorAging,
  getCustomerAgingDetails,
  getVendorAgingDetails,
  getCustomerAgingBucket,
  getVendorAgingBucket,
  getUpcomingPayments,
};
