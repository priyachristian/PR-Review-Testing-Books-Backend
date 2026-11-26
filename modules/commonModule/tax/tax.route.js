const express = require('express');
const taxValidation = require('./tax.validation');
const taxController = require('./tax.controller');
const validate = require('../../../middlewares/validate');
const { checkOtherSettingsRight } = require('../../../middlewares/checkRoleRight');

const router = express.Router();

const canView = checkOtherSettingsRight('directTaxes', 'view');
const canAdd = checkOtherSettingsRight('directTaxes', 'add');
const canUpdate = checkOtherSettingsRight('directTaxes', 'update');
const canDelete = checkOtherSettingsRight('directTaxes', 'delete');

router
  .route('/')
  .post(canAdd, validate(taxValidation.createTax), taxController.createTax)
  .get(canView, validate(taxValidation.getTaxes), taxController.getTaxes);

router.route('/sections').get(canView, validate(taxValidation.getTaxSections), taxController.getTaxSections);

router.route('/dropdown').get(validate(taxValidation.getTaxesDropdown), taxController.getTaxesDropdown);

router.route('/updateStatus/:taxId').put(canUpdate, validate(taxValidation.updateTaxStatus), taxController.updateTaxStatus);

router
  .route('/:taxId')
  .get(canView, validate(taxValidation.getTax), taxController.getTax)
  .put(canUpdate, validate(taxValidation.updateTax), taxController.updateTax)
  .delete(canDelete, validate(taxValidation.deleteTax), taxController.deleteTax);

module.exports = router;
