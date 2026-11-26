const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const partRequestValidation = require('./partRequest.validation');
const partRequestController = require('./partRequest.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.use(requireActiveFeature(PLAN_FEATURES.MACHINE_MAINTENANCE));

router
  .route('/')
  .get(
    checkRoleRight(RIGHT_LIST.PART_REQUEST, RIGHTS.VIEW),
    validate(partRequestValidation.getAllPartRequests),
    partRequestController.getAllPartRequests,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.PART_REQUEST, RIGHTS.VIEW),
    validate(partRequestValidation.getPartRequestById),
    partRequestController.getPartRequestById,
  );

router
  .route('/:id/approve')
  .patch(
    checkRoleRight(RIGHT_LIST.PART_REQUEST, RIGHTS.EDIT),
    validate(partRequestValidation.approvePartRequest),
    partRequestController.approvePartRequest,
  );

router
  .route('/:id/issue')
  .patch(
    checkRoleRight(RIGHT_LIST.PART_REQUEST, RIGHTS.EDIT),
    validate(partRequestValidation.issuePartRequest),
    partRequestController.issuePartRequest,
  );

router
  .route('/:id/short')
  .patch(
    checkRoleRight(RIGHT_LIST.PART_REQUEST, RIGHTS.EDIT),
    validate(partRequestValidation.shortPartRequest),
    partRequestController.shortPartRequest,
  );

module.exports = router;
