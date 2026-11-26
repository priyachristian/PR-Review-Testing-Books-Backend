const express = require('express');
const processValidation = require('./process.validation');
const processController = require('./process.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.PROCESS, RIGHTS.CREATE),
    validate(processValidation.createProcess),
    processController.createProcess,
  )
  .get(checkRoleRight(RIGHT_LIST.PROCESS, RIGHTS.VIEW), validate(processValidation.getProcesses), processController.getProcesses);

router.route('/dropdown').get(validate(processValidation.getProcessesDropdown), processController.processDropdown);

router
  .route('/:processId')
  .get(checkRoleRight(RIGHT_LIST.PROCESS, RIGHTS.VIEW), validate(processValidation.getProcess), processController.getProcess)
  .delete(
    checkRoleRight(RIGHT_LIST.PROCESS, RIGHTS.DELETE),
    validate(processValidation.deleteProcess),
    processController.deleteProcess,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.PROCESS, RIGHTS.EDIT),
    validate(processValidation.updateProcess),
    processController.updateProcess,
  );

module.exports = router;
