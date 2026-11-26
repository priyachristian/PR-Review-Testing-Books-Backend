const express = require('express');
const inventoryAdjustmentValidation = require('./inventoryAdjustment.validation');
const inventoryAdjustmentController = require('./inventoryAdjustment.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.INVENTORY_ADJUSTMENT, RIGHTS.CREATE),
    validate(inventoryAdjustmentValidation.createInventoryAdjustment),
    inventoryAdjustmentController.createInventoryAdjustment,
  )
  .get(
    checkRoleRight(RIGHT_LIST.INVENTORY_ADJUSTMENT, RIGHTS.VIEW),
    validate(inventoryAdjustmentValidation.getInventoryAdjustments),
    inventoryAdjustmentController.getInventoryAdjustments,
  );

router
  .route('/:adjustmentId')
  .get(
    checkRoleRight(RIGHT_LIST.INVENTORY_ADJUSTMENT, RIGHTS.VIEW),
    validate(inventoryAdjustmentValidation.getInventoryAdjustment),
    inventoryAdjustmentController.getInventoryAdjustment,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.INVENTORY_ADJUSTMENT, RIGHTS.EDIT),
    validate(inventoryAdjustmentValidation.updateInventoryAdjustment),
    inventoryAdjustmentController.updateInventoryAdjustment,
  );

router
  .route('/:adjustmentId/approve')
  .patch(
    checkRoleRight(RIGHT_LIST.INVENTORY_ADJUSTMENT, RIGHTS.EDIT),
    validate(inventoryAdjustmentValidation.approveInventoryAdjustment),
    inventoryAdjustmentController.approveInventoryAdjustment,
  );

router
  .route('/:adjustmentId/reject')
  .patch(
    checkRoleRight(RIGHT_LIST.INVENTORY_ADJUSTMENT, RIGHTS.EDIT),
    validate(inventoryAdjustmentValidation.rejectInventoryAdjustment),
    inventoryAdjustmentController.rejectInventoryAdjustment,
  );

router
  .route('/:adjustmentId/stock-movement')
  .get(checkRoleRight(RIGHT_LIST.INVENTORY_ADJUSTMENT, RIGHTS.VIEW), inventoryAdjustmentController.getStockMovement);

module.exports = router;
