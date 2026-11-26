const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const maintenanceRequestValidation = require('./maintenanceRequest.validation');
const maintenanceRequestController = require('./maintenanceRequest.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.use(requireActiveFeature(PLAN_FEATURES.MACHINE_MAINTENANCE));

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.CREATE),
    validate(maintenanceRequestValidation.createMaintenanceRequest),
    maintenanceRequestController.createMaintenanceRequest,
  )
  .get(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.VIEW),
    validate(maintenanceRequestValidation.getAllMaintenanceRequests),
    maintenanceRequestController.getAllMaintenanceRequests,
  );

router
  .route('/dropdown')
  .get(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.VIEW),
    validate(maintenanceRequestValidation.getMaintenanceRequestDropdown),
    maintenanceRequestController.getMaintenanceRequestDropdown,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.VIEW),
    validate(maintenanceRequestValidation.getMaintenanceRequestById),
    maintenanceRequestController.getMaintenanceRequestById,
  );

router
  .route('/:id/approve')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.EDIT),
    validate(maintenanceRequestValidation.approveMaintenanceRequest),
    maintenanceRequestController.approveMaintenanceRequest,
  );

router
  .route('/:id/reject')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.EDIT),
    validate(maintenanceRequestValidation.rejectMaintenanceRequest),
    maintenanceRequestController.rejectMaintenanceRequest,
  );

router
  .route('/:id/assign')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.EDIT),
    validate(maintenanceRequestValidation.assignMaintenanceRequest),
    maintenanceRequestController.assignMaintenanceRequest,
  );

router
  .route('/:id/start-work')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.EDIT),
    validate(maintenanceRequestValidation.startWorkMaintenanceRequest),
    maintenanceRequestController.startWorkMaintenanceRequest,
  );

router
  .route('/:id/complete')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.EDIT),
    validate(maintenanceRequestValidation.completeMaintenanceRequest),
    maintenanceRequestController.completeMaintenanceRequest,
  );

router
  .route('/:id/close')
  .patch(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.EDIT),
    validate(maintenanceRequestValidation.closeMaintenanceRequest),
    maintenanceRequestController.closeMaintenanceRequest,
  );

router
  .route('/:id/request-part')
  .post(
    checkRoleRight(RIGHT_LIST.MAINTENANCE_REQUEST, RIGHTS.EDIT),
    validate(maintenanceRequestValidation.requestPartMaintenanceRequest),
    maintenanceRequestController.requestPartMaintenanceRequest,
  );

module.exports = router;
