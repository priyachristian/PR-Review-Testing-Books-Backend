const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { objectId } = require('../../../validations/custom.validation');

const getCustomerPayments = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    // Comma-separated lists (multi-select filters).
    customerId: Joi.string()
      .pattern(/^[0-9a-fA-F]{24}(,[0-9a-fA-F]{24})*$/)
      .label('Customer ID'),
    status: Joi.string(),
    paymentMode: Joi.string(),
    paymentDate: Joi.date(),
    search: Joi.string(),
    ...commonSchemas.paginationQuery(),
    ...commonSchemas.dateRangeQuery(),
  }),
};

const getCustomerPaymentById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    customerPaymentId: commonSchemas.objectId({ label: 'Customer Payment ID', isRequired: true }),
  }),
};

const rejectCustomerPayment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    customerPaymentId: commonSchemas.objectId({ label: 'Customer Payment ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      rejectionReason: Joi.string().trim().required().label('Rejection Reason'),
    })
    .required(),
};

const recordCustomerPayment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    customerPaymentId: commonSchemas.objectId({ label: 'Customer Payment ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      paymentReceivedId: Joi.string().required().custom(objectId).label('Payment Received ID'),
      paymentReceivedNo: Joi.string().trim().required().label('Payment Received No'),
    })
    .required(),
};

module.exports = {
  getCustomerPayments,
  getCustomerPaymentById,
  rejectCustomerPayment,
  recordCustomerPayment,
};
