const Joi = require('joi');
const { password, objectId } = require('../../../validations/custom.validation');

const createUser = {
  body: Joi.object().keys({
    email: Joi.string().required().email().label('Email').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
      'string.email': '{{#label}} must be a valid email address',
    }),
    password: Joi.string().required().custom(password).label('Password').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    name: Joi.string().required().label('Name').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    role: Joi.string().required().valid('user', 'admin').label('Role').messages({
      'any.only': '{{#label}} must be either "user" or "admin"',
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const getUsers = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
    name: Joi.string(),
    role: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

const updateUser = {
  params: Joi.object().keys({
    userId: Joi.required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      email: Joi.string().email().label('Email').messages({
        'string.email': '{{#label}} must be a valid email address',
      }),
      password: Joi.string().custom(password).label('Password'),
      name: Joi.string().label('Name'),
    })
    .min(1),
};

const deleteUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

const inviteUser = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    email: Joi.string().required().email().label('Email').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
      'string.email': '{{#label}} must be a valid email address',
    }),
    roleId: Joi.string().required().custom(objectId),
    type: Joi.string().required().valid('send', 'resend').label('Type').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
      'any.only': '{{#label}} must be either "send" or "resend"',
    }),
  }),
};

const verifyInvite = {
  body: Joi.object().keys({
    token: Joi.string().required().label('Token').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const changeUserStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    userId: Joi.string().required().custom(objectId),
    status: Joi.string().required().valid('active', 'inactive').label('Status').messages({
      'any.only': '{{#label}} must be either "active" or "inactive"',
      'any.required': '{{#label}} is required',
    }),
  }),
};

const defaultconfiguration = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    divisionId: Joi.string().optional().custom(objectId).allow(null),
    branchId: Joi.string().optional().custom(objectId).allow(null),
    warehouseId: Joi.string().optional().custom(objectId).allow(null),
  }),
};

const getUsersDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
};

const getUserProfile = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const updateUserStatusAndRole = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    userId: Joi.required().custom(objectId),
  }),
  body: Joi.object().keys({
    firstName: Joi.string().label('First Name'),
    lastName: Joi.string().label('Last Name'),
    status: Joi.string().label('status'),
    roleId: Joi.string().custom(objectId).label('RoleId'),
  }),
};

const deleteCompanyUser = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    userId: Joi.required().custom(objectId),
  }),
};

module.exports = {
  createUser,
  getUsers,
  getUser,
  updateUser,
  deleteUser,
  inviteUser,
  verifyInvite,
  changeUserStatus,
  defaultconfiguration,
  getUsersDropdown,
  getUserProfile,
  updateUserStatusAndRole,
  deleteCompanyUser,
};
