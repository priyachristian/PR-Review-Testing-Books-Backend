const express = require('express');
const { updateMaintenanceMode } = require('./maintenanceMode.validation');
const maintenanceModeController = require('./maintenanceMode.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router
  .route('/')
  .get(maintenanceModeController.getStatus)
  .put(validate(updateMaintenanceMode), maintenanceModeController.updateStatus);

module.exports = router;
