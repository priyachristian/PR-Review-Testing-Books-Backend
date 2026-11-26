const express = require('express');
const itemBatchValidation = require('./itemBatch.validation');
const itemBatchController = require('./itemBatch.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_BATCH, RIGHTS.VIEW),
    validate(itemBatchValidation.getItemBatches),
    itemBatchController.getItemBatches,
  );

router
  .route('/:batchId')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_BATCH, RIGHTS.VIEW),
    validate(itemBatchValidation.getItemBatch),
    itemBatchController.getItemBatch,
  );

module.exports = router;
