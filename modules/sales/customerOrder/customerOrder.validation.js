const Joi = require('joi');
const { CUSTOMER_ORDER_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const { CUSTOMER_ORDER_TYPE } = require('../../../utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

const getCustomerOrders = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    customerId: commonSchemas.objectId({ label: 'Customer ID' }),
    status: Joi.string(),
    orderType: Joi.string()
      .valid(...Object.values(CUSTOMER_ORDER_TYPE))
      .label('Order Type'),
    sampleCatalogId: commonSchemas.objectId({ label: 'Sample Catalog ID' }),
    search: Joi.string(),
    ...commonSchemas.paginationQuery(),
    ...commonSchemas.dateRangeQuery(),
  }),
};

const getCustomerOrderById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    branchId: Joi.string().optional().custom(objectId),
  }),
  params: Joi.object().keys({
    customerOrderId: commonSchemas.objectId({ label: 'Customer Order ID', isRequired: true }),
  }),
};

const updateCustomerOrderStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    customerOrderId: commonSchemas.objectId({ label: 'Customer Order ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...Object.values(CUSTOMER_ORDER_STATUS))
        .required()
        .label('Status')
        .messages({
          'any.only': '{{#label}} must be one of {{#valids}}',
        }),
      rejectionReason: Joi.when('status', {
        is: CUSTOMER_ORDER_STATUS.REJECTED,
        then: Joi.string().trim().required().label('Rejection Reason'),
        otherwise: Joi.string().trim().allow('').optional(),
      }),
    })
    .required(),
};

module.exports = {
  getCustomerOrders,
  getCustomerOrderById,
  updateCustomerOrderStatus,
};
