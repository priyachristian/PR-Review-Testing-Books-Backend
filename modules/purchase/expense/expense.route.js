const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const expenseValidation = require('./expense.validation');
const expenseController = require('./expense.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.EXPENSES),
    checkRoleRight(RIGHT_LIST.EXPENSES, RIGHTS.CREATE),
    validate(expenseValidation.createExpense),
    expenseController.createExpense,
  )
  .get(
    checkRoleRight(RIGHT_LIST.EXPENSES, RIGHTS.VIEW),
    validate(expenseValidation.getExpensesValidation),
    expenseController.getAllExpenses,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.EXPENSES, RIGHTS.VIEW),
    validate(expenseValidation.getExpensesExports),
    expenseController.getExpensesExports,
  );

router
  .route('/:id')
  .delete(
    checkRoleRight(RIGHT_LIST.EXPENSES, RIGHTS.DELETE),
    validate(expenseValidation.deleteExpense),
    expenseController.deleteExpense,
  )
  .get(
    checkRoleRight(RIGHT_LIST.EXPENSES, RIGHTS.VIEW),
    validate(expenseValidation.getExpenseById),
    expenseController.getExpenseById,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.EXPENSES, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(expenseValidation.updateExpense),
    expenseController.updateExpense,
  );

module.exports = router;
