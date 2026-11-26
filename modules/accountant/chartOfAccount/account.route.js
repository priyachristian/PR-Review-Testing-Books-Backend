const express = require('express');
const accountValidation = require('./account.validation');
const accountController = require('./account.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.get(
  '/categories',
  checkRoleRight(RIGHT_LIST.CHARTS_OF_ACCOUNT, RIGHTS.VIEW),
  validate(accountValidation.getCategories),
  accountController.getCategories,
);

router.get('/dropdown', validate(accountValidation.getAccountsDropdown), accountController.getAccountsDropdown);

router.get(
  '/company',
  checkRoleRight(RIGHT_LIST.CHARTS_OF_ACCOUNT, RIGHTS.VIEW),
  validate(accountValidation.getAccountsByCompany),
  accountController.getAccountsByCompany,
);

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.CHARTS_OF_ACCOUNT, RIGHTS.VIEW),
    validate(accountValidation.getAccounts),
    accountController.getAccounts,
  )
  .post(
    checkRoleRight(RIGHT_LIST.CHARTS_OF_ACCOUNT, RIGHTS.CREATE),
    validate(accountValidation.createAccount),
    accountController.createAccount,
  );

router
  .route('/:accountId')
  .get(
    checkRoleRight(RIGHT_LIST.CHARTS_OF_ACCOUNT, RIGHTS.VIEW),
    validate(accountValidation.getAccountLedger),
    accountController.getAccountLedger,
  )
  .put(
    checkRoleRight(RIGHT_LIST.CHARTS_OF_ACCOUNT, RIGHTS.EDIT),
    validate(accountValidation.updateAccount),
    accountController.updateAccount,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.CHARTS_OF_ACCOUNT, RIGHTS.DELETE),
    validate(accountValidation.deleteAccount),
    accountController.deleteAccount,
  );

module.exports = router;
