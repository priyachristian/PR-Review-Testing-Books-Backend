const express = require('express');
const accountLedgerValidation = require('./accountLedger.validation');
const businessAccountLedgerMaster = require('./accountLedger.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.ACCOUNT_LEDGER, RIGHTS.CREATE),
    validate(accountLedgerValidation.createAccountLedger),
    businessAccountLedgerMaster.createLedger,
  )
  .get(
    checkRoleRight(RIGHT_LIST.ACCOUNT_LEDGER, RIGHTS.VIEW),
    validate(accountLedgerValidation.getAccountLedger),
    businessAccountLedgerMaster.getLedgers,
  );

router
  .route('/dropdown')
  .get(validate(accountLedgerValidation.getAccountLedgerDropdown), businessAccountLedgerMaster.getLedgersDropdown);

router
  .route('/:ledgerId')
  .get(
    checkRoleRight(RIGHT_LIST.ACCOUNT_LEDGER, RIGHTS.VIEW),
    validate(accountLedgerValidation.getAccountLedgerById),
    businessAccountLedgerMaster.getLedgerById,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.ACCOUNT_LEDGER, RIGHTS.EDIT),
    validate(accountLedgerValidation.updateAccountLedger),
    businessAccountLedgerMaster.updateLedger,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.ACCOUNT_LEDGER, RIGHTS.DELETE),
    validate(accountLedgerValidation.deleteAccountLedger),
    businessAccountLedgerMaster.deleteLedger,
  );

module.exports = router;
