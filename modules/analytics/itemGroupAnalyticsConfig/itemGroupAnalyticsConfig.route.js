const express = require('express');
const itemGroupAnalyticsConfigValidation = require('./itemGroupAnalyticsConfig.validation');
const itemGroupAnalyticsConfigController = require('./itemGroupAnalyticsConfig.controller');
const validate = require('../../../middlewares/validate');
const { checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { RIGHTS, ANALYTICS_RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    validate(itemGroupAnalyticsConfigValidation.createItemGroupAnalyticsConfig),
    itemGroupAnalyticsConfigController.createItemGroupAnalyticsConfig,
  )
  .get(
    checkAnalyticsRight(ANALYTICS_RIGHTS.GROUP_ITEM_ANALYTICS, RIGHTS.VIEW),
    validate(itemGroupAnalyticsConfigValidation.getItemGroupAnalyticsConfigs),
    itemGroupAnalyticsConfigController.getItemGroupAnalyticsConfigs,
  );

router
  .route('/:itemGroupAnalyticsConfigId')
  .patch(
    validate(itemGroupAnalyticsConfigValidation.updateItemGroupAnalyticsConfig),
    itemGroupAnalyticsConfigController.updateItemGroupAnalyticsConfig,
  )
  .delete(
    validate(itemGroupAnalyticsConfigValidation.deleteItemGroupAnalyticsConfig),
    itemGroupAnalyticsConfigController.deleteItemGroupAnalyticsConfig,
  );

router
  .route('/itemGroup/:itemGroupId')
  .get(
    validate(itemGroupAnalyticsConfigValidation.getAnalyticsByItemGroupId),
    itemGroupAnalyticsConfigController.getAnalyticsByItemGroupId,
  );

module.exports = router;
