const express = require('express');
const itemUnitValidation = require('./itemUnit.validation');
const itemUnitController = require('./itemUnit.controller');
const validate = require('../../../middlewares/validate');
const { checkOtherSettingsRight } = require('../../../middlewares/checkRoleRight');

const router = express.Router();

const canView = checkOtherSettingsRight('itemUnit', 'view');
const canAdd = checkOtherSettingsRight('itemUnit', 'add');
const canUpdate = checkOtherSettingsRight('itemUnit', 'update');
const canDelete = checkOtherSettingsRight('itemUnit', 'delete');

router
  .route('/')
  .post(canAdd, validate(itemUnitValidation.createItemUnit), itemUnitController.createItemUnit)
  .get(canView, validate(itemUnitValidation.getItemUnits), itemUnitController.getItemUnits);

router.get('/dropdown', validate(itemUnitValidation.getItemUnitsDropdown), itemUnitController.getItemUnitsDropdown);

router.put(
  '/updateStatus/:itemUnitId',
  canUpdate,
  validate(itemUnitValidation.updateItemUnitStatus),
  itemUnitController.updateItemUnitStatus,
);

router
  .route('/:itemUnitId')
  .get(canView, validate(itemUnitValidation.getItemUnitById), itemUnitController.getItemUnitById)
  .put(canUpdate, validate(itemUnitValidation.updateItemUnit), itemUnitController.updateItemUnit)
  .delete(canDelete, validate(itemUnitValidation.deleteItemUnit), itemUnitController.deleteItemUnit);

module.exports = router;
