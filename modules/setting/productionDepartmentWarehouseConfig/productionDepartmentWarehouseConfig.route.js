const express = require('express');
const productionDepartmentWarehouseConfigValidation = require('./productionDepartmentWarehouseConfig.validation');
const productionDepartmentWarehouseConfigController = require('./productionDepartmentWarehouseConfig.controller');
const validate = require('../../../middlewares/validate');
const { checkOtherSettingsRight } = require('../../../middlewares/checkRoleRight');

const router = express.Router();

const SETTING_KEY = 'productionDepartmentWarehouseConfig';

router
  .route('/')
  .post(
    checkOtherSettingsRight(SETTING_KEY, 'add'),
    validate(productionDepartmentWarehouseConfigValidation.createProductionDepartmentWarehouseConfig),
    productionDepartmentWarehouseConfigController.createProductionDepartmentWarehouseConfig,
  )
  .get(
    checkOtherSettingsRight(SETTING_KEY, 'view'),
    validate(productionDepartmentWarehouseConfigValidation.getProductionDepartmentWarehouseConfigs),
    productionDepartmentWarehouseConfigController.getProductionDepartmentWarehouseConfigs,
  );

router
  .route('/dropdown')
  .get(
    validate(productionDepartmentWarehouseConfigValidation.getProductionDepartmentWarehouseDropdown),
    productionDepartmentWarehouseConfigController.getProductionDepartmentWarehouseDropdown,
  );

router
  .route('/:id')
  .get(
    checkOtherSettingsRight(SETTING_KEY, 'view'),
    validate(productionDepartmentWarehouseConfigValidation.getProductionDepartmentWarehouseConfigById),
    productionDepartmentWarehouseConfigController.getProductionDepartmentWarehouseConfigById,
  )
  .patch(
    checkOtherSettingsRight(SETTING_KEY, 'update'),
    validate(productionDepartmentWarehouseConfigValidation.updateProductionDepartmentWarehouseConfig),
    productionDepartmentWarehouseConfigController.updateProductionDepartmentWarehouseConfig,
  )
  .delete(
    checkOtherSettingsRight(SETTING_KEY, 'delete'),
    validate(productionDepartmentWarehouseConfigValidation.deleteProductionDepartmentWarehouseConfig),
    productionDepartmentWarehouseConfigController.deleteProductionDepartmentWarehouseConfig,
  );

router.patch(
  '/:id/status',
  checkOtherSettingsRight(SETTING_KEY, 'update'),
  validate(productionDepartmentWarehouseConfigValidation.updateProductionDepartmentWarehouseConfigStatus),
  productionDepartmentWarehouseConfigController.updateProductionDepartmentWarehouseConfigStatus,
);

module.exports = router;
