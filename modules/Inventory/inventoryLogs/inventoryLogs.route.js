const express = require('express');
const inventoryLogsValidation = require('./inventoryLogs.validation');
const inventoryLogsController = require('./inventoryLogs.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(inventoryLogsValidation.getInventoryLogs),
    inventoryLogsController.getAllInventoryLogs,
  );

router
  .route('/:inventoryLogId')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(inventoryLogsValidation.getInventoryLogById),
    inventoryLogsController.getInventoryLogById,
  );

module.exports = router;
