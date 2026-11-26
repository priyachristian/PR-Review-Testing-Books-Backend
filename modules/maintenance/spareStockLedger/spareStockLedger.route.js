const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const spareStockLedgerValidation = require('./spareStockLedger.validation');
const spareStockLedgerController = require('./spareStockLedger.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.use(requireActiveFeature(PLAN_FEATURES.MACHINE_MAINTENANCE));

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.SPARE_STOCK_LEDGER, RIGHTS.VIEW),
    validate(spareStockLedgerValidation.getAllSpareStockLedgers),
    spareStockLedgerController.getAllSpareStockLedgers,
  );

module.exports = router;
