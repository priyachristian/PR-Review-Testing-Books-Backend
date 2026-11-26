const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const customerOrderValidation = require('./customerOrder.validation');
const customerOrderController = require('./customerOrder.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

// Customer orders come from the customer portal, which ships with the CUSTOMER_ORDER plan feature.
router.use(requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER));

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.CUSTOMER_ORDER, RIGHTS.VIEW),
    validate(customerOrderValidation.getCustomerOrders),
    customerOrderController.getCustomerOrders,
  );

router
  .route('/:customerOrderId')
  .get(
    checkRoleRight(RIGHT_LIST.CUSTOMER_ORDER, RIGHTS.VIEW),
    validate(customerOrderValidation.getCustomerOrderById),
    customerOrderController.getCustomerOrder,
  );

router
  .route('/:customerOrderId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.CUSTOMER_ORDER, RIGHTS.EDIT),
    validate(customerOrderValidation.updateCustomerOrderStatus),
    customerOrderController.updateCustomerOrderStatus,
  );

module.exports = router;
