const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const warehouseValidation = require('./warehouse.validation');
const warehouseController = require('./warehouse.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');
const { checkSubscription } = require('../../../middlewares/checkSubscription');

const router = express.Router();

router
  .route('/')
  .post(
    checkSubscription(PLAN_FEATURES.WAREHOUSE),
    checkRoleRight(RIGHT_LIST.WAREHOUSE_MASTER, RIGHTS.CREATE),
    validate(warehouseValidation.createWarehouse),
    warehouseController.createWarehouse,
  )
  .get(
    checkRoleRight(RIGHT_LIST.WAREHOUSE_MASTER, RIGHTS.VIEW),
    validate(warehouseValidation.getWarehouse),
    warehouseController.getAllWarehouses,
  );

router.route('/dropdown').get(validate(warehouseValidation.getWarehousesDropdown), warehouseController.getWarehousesDropdown);

router
  .route('/updateStatus/:warehouseId')
  .put(
    checkRoleRight(RIGHT_LIST.WAREHOUSE_MASTER, RIGHTS.EDIT),
    validate(warehouseValidation.updateStatus),
    warehouseController.updateStatus,
  );

router
  .route('/:warehouseId')
  .delete(
    checkRoleRight(RIGHT_LIST.WAREHOUSE_MASTER, RIGHTS.DELETE),
    validate(warehouseValidation.deleteWarehouse),
    warehouseController.deleteWarehouse,
  )
  .get(
    checkRoleRight(RIGHT_LIST.WAREHOUSE_MASTER, RIGHTS.VIEW),
    validate(warehouseValidation.warehouseById),
    warehouseController.warehouseById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.WAREHOUSE_MASTER, RIGHTS.EDIT),
    validate(warehouseValidation.updateWarehouse),
    warehouseController.updateWarehouse,
  );

module.exports = router;
