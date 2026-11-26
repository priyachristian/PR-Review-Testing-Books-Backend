const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createBranch = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    divisionId: Joi.string().required().custom(objectId).label('Division ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    name: Joi.string().required().label('Branch Name').messages({
      'string.base': '{{#label}} must be a string',
    }),
    address: Joi.object()
      .keys({
        street1: Joi.string().required().label('Street 1').messages({
          'string.base': '{{#label}} must be a string',
        }),
        street2: Joi.string().required().label('Street 2').messages({
          'string.base': '{{#label}} must be a string',
        }),
        country: Joi.string().required().label('Country').messages({
          'string.base': '{{#label}} must be a string',
        }),
        city: Joi.string().required().label('City').messages({
          'string.base': '{{#label}} must be a string',
        }),
        state: Joi.string().required().label('State').messages({
          'string.base': '{{#label}} must be a string',
        }),
        pinCode: Joi.string()
          .pattern(/^[0-9]{5,6}$/)
          .allow('')
          .label('Pin Code')
          .messages({
            'string.base': '{{#label}} must be a string',
            'string.pattern.base': '{{#label}} must be a valid pin code (5 or 6 digits)',
          }),
        phone: Joi.string()
          .pattern(/^[0-9]{10}$/)
          .required()
          .label('Phone Number')
          .messages({
            'string.base': '{{#label}} must be a string',
            'string.pattern.base': '{{#label}} must be a valid 10-digit phone number',
          }),
      })
      .label('Address'),
    branchManager: Joi.object()
      .keys({
        firstName: Joi.string().allow('').label('Branch Manager First Name').messages({
          'string.base': '{{#label}} must be a string',
        }),
        lastName: Joi.string().allow('').label('Branch Manager Last Name').messages({
          'string.base': '{{#label}} must be a string',
        }),
        contactEmail: Joi.string().email().allow('').label('Branch Manager Email').messages({
          'string.email': '{{#label}} must be a valid email address',
        }),
        contactPhone: Joi.string()
          .pattern(/^[0-9]{10}$/)
          .allow('')
          .label('Branch Manager Phone')
          .messages({
            'string.base': '{{#label}} must be a string',
            'string.pattern.base': '{{#label}} must be a valid 10-digit phone number',
          }),
      })
      .label('Branch Manager'),
    gstin: Joi.string().required().label('GSTIN').messages({
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

const updateBranch = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    branchId: Joi.string().custom(objectId).required().label('Branch ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().label('Branch Name').messages({
        'string.base': '{{#label}} must be a string',
      }),
      address: Joi.object()
        .keys({
          street1: Joi.string().allow('').label('Street 1').messages({
            'string.base': '{{#label}} must be a string',
          }),
          street2: Joi.string().allow(null, '').label('Street 2').messages({
            'string.base': '{{#label}} must be a string',
          }),
          country: Joi.string().allow('').label('Country').messages({
            'string.base': '{{#label}} must be a string',
          }),
          city: Joi.string().allow('').label('City').messages({
            'string.base': '{{#label}} must be a string',
          }),
          state: Joi.string().allow('').label('State').messages({
            'string.base': '{{#label}} must be a string',
          }),
          pinCode: Joi.string()
            .pattern(/^[0-9]{5,6}$/)
            .allow('')
            .label('Pin Code')
            .messages({
              'string.base': '{{#label}} must be a string',
              'string.pattern.base': '{{#label}} must be a valid pin code (5 or 6 digits)',
            }),
          phone: Joi.string()
            .pattern(/^[0-9]{10}$/)
            .allow('')
            .label('Phone Number')
            .messages({
              'string.base': '{{#label}} must be a string',
              'string.pattern.base': '{{#label}} must be a valid 10-digit phone number',
            }),
        })
        .label('Address'),
      branchManager: Joi.object()
        .keys({
          firstName: Joi.string().allow('').label('Branch Manager First Name').messages({
            'string.base': '{{#label}} must be a string',
          }),
          lastName: Joi.string().allow('').label('Branch Manager Last Name').messages({
            'string.base': '{{#label}} must be a string',
          }),
          contactEmail: Joi.string().email().allow('').label('Branch Manager Email').messages({
            'string.email': '{{#label}} must be a valid email address',
          }),
          contactPhone: Joi.string()
            .pattern(/^[0-9]{10}$/)
            .allow('')
            .label('Branch Manager Phone')
            .messages({
              'string.base': '{{#label}} must be a string',
              'string.pattern.base': '{{#label}} must be a valid 10-digit phone number',
            }),
        })
        .label('Branch Manager'),
      gstin: Joi.string().label('GSTIN').messages({
        'string.base': '{{#label}} must be a string',
      }),
    })
    .min(1),
};

const deleteBranch = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    branchId: Joi.string().custom(objectId).required(),
  }),
};

const getBranches = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sortBy: Joi.string(),
    status: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    isSplit: Joi.boolean().optional().allow(null),
    isActive: Joi.boolean(),
    divisionId: Joi.string().custom(objectId),
  }),
};

const getBranchDropdown = {
  query: Joi.object().keys({
    divisionId: Joi.string(),
    companyId: Joi.string().custom(objectId).required(),
    isSplit: Joi.boolean().optional().allow(null),
  }),
};

const getBranchById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    branchId: Joi.string().custom(objectId).required(),
  }),
};

const getAllBranchesWithDivision = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

const updateStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
    isActive: Joi.boolean().required().label('Is Active').messages({
      'any.required': '{{#label}} is required',
      'boolean.base': '{{#label}} must be a boolean',
    }),
  }),
  params: Joi.object().keys({
    branchId: Joi.string().custom(objectId).required().label('Branch ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a valid ObjectId',
    }),
  }),
};

module.exports = {
  createBranch,
  updateBranch,
  deleteBranch,
  getBranches,
  getBranchDropdown,
  getBranchById,
  getAllBranchesWithDivision,
  updateStatus,
};
