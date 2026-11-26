const express = require('express');
const httpStatus = require('http-status');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS, LEDGER_SOURCE_MODULES } = require('../../../utils/enum');
const ApiError = require('../../../utils/ApiError');
const ledgerValidation = require('./ledger.validation');
const ledgerController = require('./ledger.controller');

const router = express.Router();

const LEDGER_SOURCE_RIGHTS = {
  [LEDGER_SOURCE_MODULES.INVOICE]: RIGHT_LIST.INVOICES,
  [LEDGER_SOURCE_MODULES.GRPO]: RIGHT_LIST.GRPO,
  [LEDGER_SOURCE_MODULES.BILL]: RIGHT_LIST.BILLS,
  [LEDGER_SOURCE_MODULES.PRODUCTION]: RIGHT_LIST.PRODUCTION,
  [LEDGER_SOURCE_MODULES.CREDIT_NOTE]: RIGHT_LIST.CREDIT_NOTES,
  [LEDGER_SOURCE_MODULES.DEBIT_NOTE]: RIGHT_LIST.DEBIT_NOTE,
  [LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED]: RIGHT_LIST.PAYMENT_RECEIVED,
  [LEDGER_SOURCE_MODULES.PAYMENT_MADE]: RIGHT_LIST.PAYMENT_MADE,
  [LEDGER_SOURCE_MODULES.EXPENSE]: RIGHT_LIST.EXPENSES,
  [LEDGER_SOURCE_MODULES.BANK_TRANSFER]: RIGHT_LIST.BANK,
  [LEDGER_SOURCE_MODULES.MANUAL_JOURNAL]: RIGHT_LIST.MANUAL_JOURNAL,
  [LEDGER_SOURCE_MODULES.INVENTORY_ADJUSTMENT]: RIGHT_LIST.INVENTORY_ADJUSTMENT,
  [LEDGER_SOURCE_MODULES.OPENING_BALANCE]: RIGHT_LIST.CHARTS_OF_ACCOUNT,
};

const checkLedgerSourceView = (req, res, next) => {
  const moduleName = LEDGER_SOURCE_RIGHTS[req.query.sourceModule];
  if (!moduleName) {
    return next(new ApiError(httpStatus.BAD_REQUEST, 'Unsupported source module for journal lookup'));
  }
  return checkRoleRight(moduleName, RIGHTS.VIEW)(req, res, next);
};

router.get('/journal', checkLedgerSourceView, validate(ledgerValidation.getJournalBySource), ledgerController.getJournalBySource);

module.exports = router;
