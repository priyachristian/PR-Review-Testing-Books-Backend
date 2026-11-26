const express = require('express');
const inventoryTransferValidation = require('./inventoryTransfer.validation');
const inventoryTransferController = require('./inventoryTransfer.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.INVENTORY_TRANSFER_REQUEST, RIGHTS.CREATE),
    validate(inventoryTransferValidation.createInventoryTransferRequest),
    inventoryTransferController.createInventoryTransferRequest,
  )
  .get(
    checkRoleRight(RIGHT_LIST.INVENTORY_TRANSFER_REQUEST, RIGHTS.VIEW),
    validate(inventoryTransferValidation.getInventoryTransferRequests),
    inventoryTransferController.getInventoryTransferRequests,
  );

router
  .route('/:transferId')
  .get(
    checkRoleRight(RIGHT_LIST.INVENTORY_TRANSFER_REQUEST, RIGHTS.VIEW),
    validate(inventoryTransferValidation.getInventoryTransfer),
    inventoryTransferController.getInventoryTransfer,
  );

router
  .route('/:transferId/approve')
  .patch(
    checkRoleRight(RIGHT_LIST.INVENTORY_TRANSFER_REQUEST, RIGHTS.EDIT),
    validate(inventoryTransferValidation.approveInventoryTransfer),
    inventoryTransferController.approveInventoryTransfer,
  );

router
  .route('/:transferId/reject')
  .patch(
    checkRoleRight(RIGHT_LIST.INVENTORY_TRANSFER_REQUEST, RIGHTS.EDIT),
    validate(inventoryTransferValidation.rejectInventoryTransfer),
    inventoryTransferController.rejectInventoryTransfer,
  );

router
  .route('/:transferId/stock-movement')
  .get(checkRoleRight(RIGHT_LIST.INVENTORY_TRANSFER_REQUEST, RIGHTS.VIEW), inventoryTransferController.getStockMovement);

module.exports = router;
