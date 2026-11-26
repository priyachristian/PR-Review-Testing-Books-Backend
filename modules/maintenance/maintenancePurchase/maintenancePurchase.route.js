const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const maintenancePurchaseValidation = require('./maintenancePurchase.validation');
const maintenancePurchaseController = require('./maintenancePurchase.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.use(requireActiveFeature(PLAN_FEATURES.MACHINE_MAINTENANCE));

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_PURCHASE, RIGHTS.VIEW),
    validate(maintenancePurchaseValidation.getAllMaintenancePurchases),
    maintenancePurchaseController.getAllMaintenancePurchases,
  )
  .post(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_PURCHASE, RIGHTS.CREATE),
    validate(maintenancePurchaseValidation.createMaintenancePurchase),
    maintenancePurchaseController.createMaintenancePurchase,
  );

// Registered before '/:id' so "dropdown" is not read as an id.
router
  .route('/dropdown')
  .get(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_PURCHASE, RIGHTS.VIEW),
    validate(maintenancePurchaseValidation.getMaintenancePurchaseDropdown),
    maintenancePurchaseController.getMaintenancePurchaseDropdown,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_PURCHASE, RIGHTS.VIEW),
    validate(maintenancePurchaseValidation.getMaintenancePurchaseById),
    maintenancePurchaseController.getMaintenancePurchaseById,
  );

router
  .route('/:id/approve')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_PURCHASE, RIGHTS.EDIT),
    validate(maintenancePurchaseValidation.approveMaintenancePurchase),
    maintenancePurchaseController.approveMaintenancePurchase,
  );

router
  .route('/:id/raise-po')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_PURCHASE, RIGHTS.EDIT),
    validate(maintenancePurchaseValidation.raisePurchaseOrder),
    maintenancePurchaseController.raisePurchaseOrder,
  );

router
  .route('/:id/receive')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_PURCHASE, RIGHTS.EDIT),
    validate(maintenancePurchaseValidation.receiveMaintenancePurchase),
    maintenancePurchaseController.receiveMaintenancePurchase,
  );

module.exports = router;
