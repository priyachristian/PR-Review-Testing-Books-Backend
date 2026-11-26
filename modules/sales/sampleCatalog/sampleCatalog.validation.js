const Joi = require('joi');
const { SAMPLE_CATALOG_STATUS, SAMPLE_CATALOG_VISIBILITY } = require('@smit9313/abss-models-core/src/utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');

const companyQuery = Joi.object().keys({
  companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
});

const catalogIdParams = Joi.object().keys({
  sampleCatalogId: commonSchemas.objectId({ label: 'Sample Catalog ID', isRequired: true }),
});

const unitSchema = Joi.object().keys({
  itemUnitId: commonSchemas.objectId({ label: 'Unit', isRequired: true }),
  samplePrice: Joi.number().greater(0).required().label('Sample Price'),
  minQty: Joi.number().greater(0).required().label('Minimum Quantity'),
  maxQty: Joi.number()
    .min(Joi.ref('minQty'))
    .required()
    .label('Maximum Quantity')
    .messages({ 'number.min': '{{#label}} cannot be less than Minimum Quantity' }),
});

const itemSchema = Joi.object().keys({
  itemId: commonSchemas.objectId({ label: 'Item', isRequired: true }),
  units: Joi.array()
    .items(unitSchema)
    .min(1)
    .unique('itemUnitId')
    .required()
    .label('Units')
    .messages({ 'array.unique': 'A unit can be added only once per item', 'array.min': 'Add at least one unit for each item' }),
});

const catalogBody = {
  name: Joi.string().trim().max(150).required().label('Sample Catalog Name'),
  description: Joi.string().trim().max(1000).allow('', null).optional().label('Description'),
  startDate: Joi.date().allow(null).optional().label('Start Date'),
  endDate: Joi.date()
    .allow(null)
    .optional()
    .when('startDate', { is: Joi.date().required(), then: Joi.date().min(Joi.ref('startDate')) })
    .label('End Date')
    .messages({ 'date.min': '{{#label}} cannot be before Start Date' }),
  visibility: Joi.string()
    .valid(...Object.values(SAMPLE_CATALOG_VISIBILITY))
    .required()
    .label('Visibility'),
  customerIds: Joi.when('visibility', {
    is: SAMPLE_CATALOG_VISIBILITY.SELECTED_CUSTOMERS,
    then: Joi.array()
      .items(commonSchemas.objectId({ label: 'Customer' }))
      .min(1)
      .unique()
      .required(),
    otherwise: Joi.array().max(0).default([]),
  })
    .label('Selected Customers')
    .messages({ 'array.min': 'Select at least one customer', 'array.max': '{{#label}} are allowed only for Selected Customers' }),
  items: Joi.array()
    .items(itemSchema)
    .unique('itemId')
    .default([])
    .label('Items')
    .messages({ 'array.unique': 'An item can be added only once to a sample catalog' }),
  // Set only after the user confirms turning on hidden items in the customer portal.
  activateItemPortal: Joi.boolean().default(false),
};

const createSampleCatalog = {
  query: companyQuery,
  body: Joi.object().keys({
    ...catalogBody,
    // Used only when the company turned auto numbering off; otherwise the sequence wins.
    catalogCode: Joi.string().trim().max(50).allow('').optional().label('Catalog Code'),
    status: Joi.string().valid(SAMPLE_CATALOG_STATUS.DRAFT, SAMPLE_CATALOG_STATUS.ACTIVE).default(SAMPLE_CATALOG_STATUS.DRAFT),
  }),
};

const updateSampleCatalog = {
  query: companyQuery,
  params: catalogIdParams,
  body: Joi.object().keys(catalogBody),
};

const updateSampleCatalogStatus = {
  query: companyQuery,
  params: catalogIdParams,
  body: Joi.object().keys({
    status: Joi.string().valid(SAMPLE_CATALOG_STATUS.ACTIVE, SAMPLE_CATALOG_STATUS.INACTIVE).required().label('Status'),
    activateItemPortal: Joi.boolean().default(false),
  }),
};

const getSampleCatalogs = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    search: Joi.string().trim().allow(''),
    status: Joi.string().trim(),
    visibility: Joi.string().valid(...Object.values(SAMPLE_CATALOG_VISIBILITY)),
    ...commonSchemas.paginationQuery(),
  }),
};

const getSampleCatalog = {
  query: companyQuery,
  params: catalogIdParams,
};

module.exports = {
  createSampleCatalog,
  updateSampleCatalog,
  updateSampleCatalogStatus,
  getSampleCatalogs,
  getSampleCatalog,
};
