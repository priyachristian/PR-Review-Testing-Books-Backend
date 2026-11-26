const express = require('express');
const openingBalanceTransactionValidation = require('./openingBalanceTransaction.validation');
const openingBalanceTransactionController = require('./openingBalanceTransaction.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/contact/:contactId/ob-history')
  .get(
    checkRoleRight(RIGHT_LIST.CUSTOMER_MASTER, RIGHTS.VIEW),
    validate(openingBalanceTransactionValidation.getOpeningBalanceTransactionHistory),
    openingBalanceTransactionController.getOpeningBalanceTransactionHistory,
  );

module.exports = router;
