const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const customerPaymentValidation = require('./customerPayment.validation');
const customerPaymentController = require('./customerPayment.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

// Customer payments come from the customer portal, which ships with the CUSTOMER_ORDER plan feature.
router.use(requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER));

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.CUSTOMER_PAYMENT, RIGHTS.VIEW),
    validate(customerPaymentValidation.getCustomerPayments),
    customerPaymentController.getCustomerPayments,
  );

router
  .route('/:customerPaymentId')
  .get(
    checkRoleRight(RIGHT_LIST.CUSTOMER_PAYMENT, RIGHTS.VIEW),
    validate(customerPaymentValidation.getCustomerPaymentById),
    customerPaymentController.getCustomerPayment,
  );

router
  .route('/:customerPaymentId/reject')
  .patch(
    checkRoleRight(RIGHT_LIST.CUSTOMER_PAYMENT, RIGHTS.EDIT),
    validate(customerPaymentValidation.rejectCustomerPayment),
    customerPaymentController.rejectCustomerPayment,
  );

// Recording links a newly created PaymentReceived, so Payment Received create is required too.
router
  .route('/:customerPaymentId/record')
  .patch(
    checkRoleRight(RIGHT_LIST.CUSTOMER_PAYMENT, RIGHTS.EDIT),
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.CREATE),
    validate(customerPaymentValidation.recordCustomerPayment),
    customerPaymentController.recordCustomerPayment,
  );

module.exports = router;
