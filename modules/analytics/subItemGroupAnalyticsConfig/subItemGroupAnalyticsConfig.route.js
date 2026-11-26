const express = require('express');
const subItemGroupAnalyticsConfigValidation = require('./subItemGroupAnalyticsConfig.validation');
const subItemGroupAnalyticsConfigController = require('./subItemGroupAnalyticsConfig.controller');
const validate = require('../../../middlewares/validate');
const { checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { RIGHTS, ANALYTICS_RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    validate(subItemGroupAnalyticsConfigValidation.createSubItemGroupAnalyticsConfig),
    subItemGroupAnalyticsConfigController.createSubItemGroupAnalyticsConfig,
  )
  .get(
    checkAnalyticsRight(ANALYTICS_RIGHTS.GROUP_ITEM_ANALYTICS, RIGHTS.VIEW),
    validate(subItemGroupAnalyticsConfigValidation.getSubItemGroupAnalyticsConfigs),
    subItemGroupAnalyticsConfigController.getSubItemGroupAnalyticsConfigs,
  );

router
  .route('/:subItemGroupAnalyticsConfigId')
  .patch(
    validate(subItemGroupAnalyticsConfigValidation.updateSubItemGroupAnalyticsConfig),
    subItemGroupAnalyticsConfigController.updateSubItemGroupAnalyticsConfig,
  )
  .delete(
    validate(subItemGroupAnalyticsConfigValidation.deleteSubItemGroupAnalyticsConfig),
    subItemGroupAnalyticsConfigController.deleteSubItemGroupAnalyticsConfig,
  );

router
  .route('/subItemGroup/:subItemGroupId')
  .get(
    validate(subItemGroupAnalyticsConfigValidation.getAnalyticsBySubItemGroupId),
    subItemGroupAnalyticsConfigController.getAnalyticsBySubItemGroupId,
  );

module.exports = router;
