const express = require('express');
const developmentUpdateValidation = require('./developmentUpdate.validation');
const developmentUpdateController = require('./developmentUpdate.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router
  .route('/')
  .get(validate(developmentUpdateValidation.listDevelopmentUpdate), developmentUpdateController.listGlobalDevelopmentUpdates);

module.exports = router;
