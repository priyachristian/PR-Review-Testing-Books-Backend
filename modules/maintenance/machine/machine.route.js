const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const machineValidation = require('./machine.validation');
const machineController = require('./machine.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.use(requireActiveFeature(PLAN_FEATURES.MACHINE_MAINTENANCE));

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.MACHINE, RIGHTS.CREATE),
    validate(machineValidation.createMachine),
    machineController.createMachine,
  )
  .get(
    checkRoleRight(RIGHT_LIST.MACHINE, RIGHTS.VIEW),
    validate(machineValidation.getAllMachines),
    machineController.getAllMachines,
  );

router.route('/dropdown').get(validate(machineValidation.getMachineDropdown), machineController.getMachineDropdown);

router
  .route('/updateStatus/:id')
  .put(
    checkRoleRight(RIGHT_LIST.MACHINE, RIGHTS.EDIT),
    validate(machineValidation.updateActiveStatus),
    machineController.updateActiveStatus,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.MACHINE, RIGHTS.VIEW),
    validate(machineValidation.getMachineById),
    machineController.getMachineById,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.MACHINE, RIGHTS.DELETE),
    validate(machineValidation.deleteMachine),
    machineController.deleteMachineById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.MACHINE, RIGHTS.EDIT),
    validate(machineValidation.updateMachine),
    machineController.updateMachineById,
  );

module.exports = router;
