const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { PART_REQUEST_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');

const PART_REQUEST_STATUSES = Object.values(PART_REQUEST_STATUS);

const stringMessages = {
  'string.base': '{{#label}} must be a string',
  'string.empty': '{{#label}} cannot be empty',
  'any.required': '{{#label}} is required',
};

const quantityMessages = {
  'number.base': '{{#label}} must be a number',
  'number.min': '{{#label}} cannot be negative',
  'number.greater': '{{#label}} must be greater than 0',
  'any.required': '{{#label}} is required',
};

const idSchema = label =>
  Joi.string()
    .custom(objectId)
    .label(label)
    .messages({ 'string.base': '{{#label}} must be a valid ID', 'any.required': '{{#label}} is required' });

const statusSchema = Joi.string()
  .valid(...PART_REQUEST_STATUSES)
  .label('Status')
  .messages({
    'string.base': '{{#label}} must be a string',
    'any.only': `{{#label}} must be one of: ${PART_REQUEST_STATUSES.join(', ')}`,
  });

const companyIdQuery = Joi.string().required().custom(objectId).label('Company ID');

const partRequestIdParams = Joi.object().keys({
  id: idSchema('Part request ID').required(),
});

const getAllPartRequests = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    sortBy: Joi.string(),
    limit: Joi.number().integer().min(1),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
    search: Joi.string().trim().allow(''),
    status: statusSchema,
    mrId: idSchema('Maintenance request'),
    machineId: idSchema('Machine'),
    sparePartId: idSchema('Spare part'),
    requestedBy: idSchema('Requested by'),
    fromDate: Joi.date().label('From date'),
    toDate: Joi.date().min(Joi.ref('fromDate')).label('To date').messages({
      'date.min': 'To date cannot be earlier than from date',
    }),
  }),
};

const getPartRequestById = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: partRequestIdParams,
};

const approvePartRequest = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: partRequestIdParams,
  body: Joi.object().keys({
    approvedQty: Joi.number()
      .greater(0)
      .label('Approved quantity')
      .messages({ ...quantityMessages }),
    approvalRemark: Joi.string()
      .trim()
      .allow('', null)
      .label('Approval remark')
      .messages({ ...stringMessages }),
  }),
};

const issuePartRequest = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: partRequestIdParams,
  body: Joi.object().keys({
    issuedQty: Joi.number()
      .greater(0)
      .label('Issued quantity')
      .messages({ ...quantityMessages }),
  }),
};

const shortPartRequest = {
  query: Joi.object().keys({
    companyId: companyIdQuery,
  }),
  params: partRequestIdParams,
};

module.exports = {
  getAllPartRequests,
  getPartRequestById,
  approvePartRequest,
  issuePartRequest,
  shortPartRequest,
};
