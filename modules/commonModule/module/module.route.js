const express = require('express');
const moduleValidation = require('./module.validation');
const moduleController = require('./module.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router.get('/tree', validate(moduleValidation.getModuleTree), moduleController.getModuleTree);

router.get('/permission-tree', validate(moduleValidation.getModuleTree), moduleController.getPermissionModules);

router.get('/settings-feature-plan', validate(moduleValidation.getModuleTree), moduleController.getSettingsFeaturePlan);

router
  .route('/')
  .post(validate(moduleValidation.createModule), moduleController.createModule)
  .get(validate(moduleValidation.getModules), moduleController.getModules);

router
  .route('/:moduleId')
  .get(validate(moduleValidation.getModule), moduleController.getModule)
  .patch(validate(moduleValidation.updateModule), moduleController.updateModule)
  .delete(validate(moduleValidation.deleteModule), moduleController.deleteModule);

module.exports = router;
