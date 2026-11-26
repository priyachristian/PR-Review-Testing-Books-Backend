const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const recurringBillValidation = require('./recurringBill.validation');
const recurringBillController = require('./recurringBill.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkSubscription(PLAN_FEATURES.RECURRING_BILL),
    checkRoleRight(RIGHT_LIST.RECURRING_BILLS, RIGHTS.CREATE),
    validate(recurringBillValidation.createRecurringBill),
    validateDocumentTotals,
    recurringBillController.createRecurringBill,
  )
  .get(
    checkRoleRight(RIGHT_LIST.RECURRING_BILLS, RIGHTS.VIEW),
    validate(recurringBillValidation.getRecurringBills),
    recurringBillController.getRecurringBills,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.RECURRING_BILLS, RIGHTS.VIEW),
    validate(recurringBillValidation.getRecurringBillById),
    recurringBillController.getRecurringBillById,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.RECURRING_BILLS, RIGHTS.DELETE),
    validate(recurringBillValidation.deleteRecurringBill),
    recurringBillController.deleteRecurringBill,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.RECURRING_BILLS, RIGHTS.EDIT),
    validate(recurringBillValidation.updateRecurringBill),
    validateDocumentTotals,
    recurringBillController.updateRecurringBill,
  );

router
  .route('/:id/status')
  .patch(
    checkRoleRight(RIGHT_LIST.RECURRING_BILLS, RIGHTS.EDIT),
    validate(recurringBillValidation.updateRecurringBillStatus),
    recurringBillController.updateRecurringBillStatus,
  );

router
  .route('/:id/create-bill')
  .post(
    checkSubscription(PLAN_FEATURES.RECURRING_BILL),
    checkRoleRight(RIGHT_LIST.RECURRING_BILLS, RIGHTS.CREATE),
    validate(recurringBillValidation.createBillFromRecurringDoc),
    recurringBillController.createBillFromRecurringDoc,
  );

module.exports = router;
