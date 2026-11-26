const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const sparePartValidation = require('./sparePart.validation');
const sparePartController = require('./sparePart.controller');
const spareStockLedgerValidation = require('../spareStockLedger/spareStockLedger.validation');
const spareStockLedgerController = require('../spareStockLedger/spareStockLedger.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.use(requireActiveFeature(PLAN_FEATURES.MACHINE_MAINTENANCE));

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.SPARE_PART, RIGHTS.CREATE),
    validate(sparePartValidation.createSparePart),
    sparePartController.createSparePart,
  )
  .get(
    checkRoleRight(RIGHT_LIST.SPARE_PART, RIGHTS.VIEW),
    validate(sparePartValidation.getAllSpareParts),
    sparePartController.getAllSpareParts,
  );

router
  .route('/adjustment')
  .post(
    checkRoleRight(RIGHT_LIST.SPARE_PART, RIGHTS.CREATE),
    validate(spareStockLedgerValidation.createAdjustment),
    spareStockLedgerController.createAdjustment,
  );

router.route('/dropdown').get(validate(sparePartValidation.getSparePartDropdown), sparePartController.getSparePartDropdown);

router
  .route('/updateStatus/:id')
  .put(
    checkRoleRight(RIGHT_LIST.SPARE_PART, RIGHTS.EDIT),
    validate(sparePartValidation.updateActiveStatus),
    sparePartController.updateActiveStatus,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.SPARE_PART, RIGHTS.VIEW),
    validate(sparePartValidation.getSparePartById),
    sparePartController.getSparePartById,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.SPARE_PART, RIGHTS.DELETE),
    validate(sparePartValidation.deleteSparePart),
    sparePartController.deleteSparePartById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.SPARE_PART, RIGHTS.EDIT),
    validate(sparePartValidation.updateSparePart),
    sparePartController.updateSparePartById,
  );

module.exports = router;
