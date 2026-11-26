const express = require('express');
const paymentTermValidation = require('./paymentTerm.validation');
const paymentTermController = require('./paymentTerm.controller');
const validate = require('../../../middlewares/validate');
const { checkOtherSettingsRight } = require('../../../middlewares/checkRoleRight');

const router = express.Router();

const canView = checkOtherSettingsRight('paymentTerms', 'view');
const canAdd = checkOtherSettingsRight('paymentTerms', 'add');
const canUpdate = checkOtherSettingsRight('paymentTerms', 'update');
const canDelete = checkOtherSettingsRight('paymentTerms', 'delete');

router
  .route('/')
  .post(canAdd, validate(paymentTermValidation.createPaymentTerm), paymentTermController.createPaymentTerm)
  .get(canView, validate(paymentTermValidation.getPaymentTerms), paymentTermController.getPaymentTerms);

router
  .route('/dropdown')
  .get(validate(paymentTermValidation.getPaymentTermsDropdown), paymentTermController.getPaymentTermsDropdown);

router
  .route('/updateStatus/:paymentTermId')
  .put(canUpdate, validate(paymentTermValidation.updateStatus), paymentTermController.updateStatus);

router
  .route('/setDefault/:paymentTermId')
  .put(canUpdate, validate(paymentTermValidation.setDefaultPaymentTerm), paymentTermController.setDefaultPaymentTerm);

router
  .route('/:paymentTermId')
  .get(canView, validate(paymentTermValidation.getPaymentTermById), paymentTermController.getPaymentTermById)
  .put(canUpdate, validate(paymentTermValidation.updatePaymentTerm), paymentTermController.updatePaymentTerm)
  .delete(canDelete, validate(paymentTermValidation.deletePaymentTerm), paymentTermController.deletePaymentTerm);

module.exports = router;
