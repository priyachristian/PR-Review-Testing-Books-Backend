const express = require('express');
const manPowerValidation = require('./manPower.validation');
const manPowerController = require('./manPower.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.MANPOWER, RIGHTS.CREATE),
    validate(manPowerValidation.createManPower),
    manPowerController.createManPower,
  )
  .get(validate(manPowerValidation.getAllManPower), manPowerController.getAllManPower);

router.route('/dropdown').get(validate(manPowerValidation.getManPowerDropdown), manPowerController.getManPowerDropdown);

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.MANPOWER, RIGHTS.VIEW),
    validate(manPowerValidation.getManPowerById),
    manPowerController.getManPowerById,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.MANPOWER, RIGHTS.DELETE),
    validate(manPowerValidation.deleteManPower),
    manPowerController.deleteManPowerById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.MANPOWER, RIGHTS.EDIT),
    validate(manPowerValidation.updateManPower),
    manPowerController.updateManPowerById,
  );

module.exports = router;
