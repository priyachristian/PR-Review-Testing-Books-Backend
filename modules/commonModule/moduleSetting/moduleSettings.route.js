const express = require('express');
const moduleSettingsValidation = require('./moduleSettings.validation');
const moduleSettingsController = require('./moduleSettings.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router
  .route('/')
  .post(validate(moduleSettingsValidation.createModuleSettings), moduleSettingsController.createModuleSettings)
  .get(validate(moduleSettingsValidation.getModuleSettings), moduleSettingsController.getModuleSettings);

router
  .route('/:moduleName')
  .get(
    validate(moduleSettingsValidation.getModuleSettingsByCompanyAndModule),
    moduleSettingsController.getModuleSettingsByCompanyAndModule,
  )
  .patch(validate(moduleSettingsValidation.updateModuleSettings), moduleSettingsController.updateModuleSettings)
  .delete(validate(moduleSettingsValidation.deleteModuleSettings), moduleSettingsController.deleteModuleSettings);

module.exports = router;
