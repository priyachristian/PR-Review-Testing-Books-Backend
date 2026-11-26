const express = require('express');
const qcMasterValidation = require('./qualityMaster.validation');
const qcMasterController = require('./qualityMaster.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.QUALITY_MASTER, RIGHTS.CREATE),
    validate(qcMasterValidation.createQCMaster),
    qcMasterController.createQCMaster,
  )
  .get(
    checkRoleRight(RIGHT_LIST.QUALITY_MASTER, RIGHTS.VIEW),
    validate(qcMasterValidation.getQCMasters),
    qcMasterController.getAllQCMasters,
  );

router.route('/dropdown').get(validate(qcMasterValidation.getQCDropdown), qcMasterController.getQCDropdown);

router
  .route('/:qcMasterId')
  .delete(
    checkRoleRight(RIGHT_LIST.QUALITY_MASTER, RIGHTS.DELETE),
    validate(qcMasterValidation.deleteQCMaster),
    qcMasterController.deleteQCMaster,
  )
  .get(
    checkRoleRight(RIGHT_LIST.QUALITY_MASTER, RIGHTS.VIEW),
    validate(qcMasterValidation.getQCById),
    qcMasterController.getQCById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.QUALITY_MASTER, RIGHTS.EDIT),
    validate(qcMasterValidation.updateQCMaster),
    qcMasterController.updateQCMaster,
  );

module.exports = router;
