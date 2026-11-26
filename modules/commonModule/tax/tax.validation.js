const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { TAX_TYPES } = require('../../../utils/enum');

const companyQuery = {
  companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
};

const taxIdParam = Joi.object().keys({
  taxId: commonSchemas.objectId({ label: 'Tax ID', isRequired: true }),
});

const taxType = Joi.string()
  .valid(...Object.values(TAX_TYPES))
  .label('Tax Type')
  .messages({ 'any.only': '{{#label}} must be TDS or TCS' });

const taxRate = commonSchemas
  .number({ label: 'Rate' })
  .min(0)
  .max(100)
  .messages({ 'number.min': '{{#label}} cannot be negative', 'number.max': '{{#label}} cannot be more than 100' });

const endDate = commonSchemas
  .date({ label: 'End Date' })
  .allow(null)
  .min(Joi.ref('startDate'))
  .messages({ 'date.min': '{{#label}} must be on or after the Start Date' });

const getTaxes = {
  query: Joi.object().keys({
    ...companyQuery,
    type: taxType.required(),
    search: Joi.string().trim().allow('', null),
    ...commonSchemas.paginationQuery(),
  }),
};

const getTaxSections = {
  query: Joi.object().keys({
    ...companyQuery,
    type: taxType.required(),
  }),
};

const getTaxesDropdown = {
  query: Joi.object().keys({
    ...companyQuery,
    type: taxType.required(),
    date: commonSchemas.date({ label: 'Date', isRequired: true }),
  }),
};

const createTax = {
  query: Joi.object().keys(companyQuery),
  body: Joi.object().keys({
    type: taxType.required(),
    taxName: commonSchemas.string({ label: 'Tax Name', isRequired: true, allowEmpty: false }),
    taxRate: taxRate.required(),
    sectionId: commonSchemas.objectId({ label: 'Section', isRequired: true }),
    startDate: commonSchemas.date({ label: 'Start Date', isRequired: true }),
    endDate,
  }),
};

const getTax = {
  query: Joi.object().keys(companyQuery),
  params: taxIdParam,
};

const updateTax = {
  query: Joi.object().keys(companyQuery),
  params: taxIdParam,
  body: Joi.object()
    .keys({
      taxName: commonSchemas.string({ label: 'Tax Name', allowEmpty: false }),
      taxRate,
      sectionId: commonSchemas.objectId({ label: 'Section' }),
      startDate: commonSchemas.date({ label: 'Start Date' }),
      endDate: commonSchemas.date({ label: 'End Date' }).allow(null),
    })
    .min(1),
};

const updateTaxStatus = {
  query: Joi.object().keys({
    ...companyQuery,
    isActive: Joi.boolean().required().label('Is Active').messages({ 'any.required': '{{#label}} is required' }),
  }),
  params: taxIdParam,
};

const deleteTax = {
  query: Joi.object().keys(companyQuery),
  params: taxIdParam,
};

module.exports = {
  getTaxes,
  getTaxSections,
  getTaxesDropdown,
  createTax,
  getTax,
  updateTax,
  updateTaxStatus,
  deleteTax,
};
