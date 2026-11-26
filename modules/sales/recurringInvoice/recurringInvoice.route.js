const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const recurringInvoiceValidation = require('./recurringInvoice.validation');
const recurringInvoiceController = require('./recurringInvoice.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkSubscription(PLAN_FEATURES.RECURRING_INVOICE),
    checkRoleRight(RIGHT_LIST.RECURRING_INVOICE, RIGHTS.CREATE),
    validate(recurringInvoiceValidation.createRecurringInvoice),
    validateDocumentTotals,
    recurringInvoiceController.createRecurringInvoice,
  )
  .get(
    checkRoleRight(RIGHT_LIST.RECURRING_INVOICE, RIGHTS.VIEW),
    validate(recurringInvoiceValidation.getRecurringInvoices),
    recurringInvoiceController.getRecurringInvoices,
  );

router
  .route('/:recurringInvoiceId')
  .get(
    checkRoleRight(RIGHT_LIST.RECURRING_INVOICE, RIGHTS.VIEW),
    validate(recurringInvoiceValidation.getRecurringInvoice),
    recurringInvoiceController.getRecurringInvoice,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.RECURRING_INVOICE, RIGHTS.DELETE),
    validate(recurringInvoiceValidation.deleteRecurringInvoice),
    recurringInvoiceController.deleteRecurringInvoice,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.RECURRING_INVOICE, RIGHTS.EDIT),
    validate(recurringInvoiceValidation.updateRecurringInvoice),
    validateDocumentTotals,
    recurringInvoiceController.updateRecurringInvoice,
  );

router
  .route('/:recurringInvoiceId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.RECURRING_INVOICE, RIGHTS.EDIT),
    validate(recurringInvoiceValidation.updateRecurringInvoiceStatus),
    recurringInvoiceController.updateRecurringInvoiceStatus,
  );

router
  .route('/:id/create-invoice')
  .post(
    checkSubscription(PLAN_FEATURES.RECURRING_INVOICE),
    checkRoleRight(RIGHT_LIST.RECURRING_INVOICE, RIGHTS.CREATE),
    validate(recurringInvoiceValidation.createInvoiceFromRecurringDoc),
    recurringInvoiceController.createInvoiceFromRecurringDoc,
  );

module.exports = router;
