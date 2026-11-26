const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const recurringExpenseValidation = require('./recurringExpense.validation');
const recurringExpenseController = require('./recurringExpense.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.RECURRING_EXPENSES),
    checkRoleRight(RIGHT_LIST.RECURRING_EXPENSES, RIGHTS.CREATE),
    validate(recurringExpenseValidation.createRecurringExpense),
    recurringExpenseController.createRecurringExpense,
  )
  .get(
    checkRoleRight(RIGHT_LIST.RECURRING_EXPENSES, RIGHTS.VIEW),
    validate(recurringExpenseValidation.getRecurringExpenses),
    recurringExpenseController.getRecurringExpenses,
  );

router
  .route('/:recurringExpenseId')
  .get(
    checkRoleRight(RIGHT_LIST.RECURRING_EXPENSES, RIGHTS.VIEW),
    validate(recurringExpenseValidation.getRecurringExpense),
    recurringExpenseController.getRecurringExpense,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.RECURRING_EXPENSES, RIGHTS.DELETE),
    validate(recurringExpenseValidation.deleteRecurringExpense),
    recurringExpenseController.deleteRecurringExpense,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.RECURRING_EXPENSES, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(recurringExpenseValidation.updateRecurringExpense),
    recurringExpenseController.updateRecurringExpense,
  );

router
  .route('/:recurringExpenseId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.RECURRING_EXPENSES, RIGHTS.EDIT),
    validate(recurringExpenseValidation.updateRecurringExpenseStatus),
    recurringExpenseController.updateRecurringExpenseStatus,
  );

router
  .route('/:id/create-expense')
  .post(
    checkSubscription(PLAN_FEATURES.RECURRING_EXPENSES),
    checkRoleRight(RIGHT_LIST.RECURRING_EXPENSES, RIGHTS.CREATE),
    validate(recurringExpenseValidation.createExpenseFromRecurringDoc),
    recurringExpenseController.createExpenseFromRecurringDoc,
  );

module.exports = router;
