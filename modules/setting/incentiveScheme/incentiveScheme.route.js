const express = require('express');
const validate = require('../../../middlewares/validate');
const { checkOtherSettingsRight } = require('../../../middlewares/checkRoleRight');
const incentiveSchemeValidation = require('./incentiveScheme.validation');
const incentiveSchemeController = require('./incentiveScheme.controller');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');

const router = express.Router();

const canView = checkOtherSettingsRight('incentive', 'view');
const canAdd = checkOtherSettingsRight('incentive', 'add');
const canUpdate = checkOtherSettingsRight('incentive', 'update');
const canDelete = checkOtherSettingsRight('incentive', 'delete');

// Summary stats
router
  .route('/summary')
  .get(canView, validate(incentiveSchemeValidation.getSchemeSummary), incentiveSchemeController.getSchemeSummary);

// Team stats
router
  .route('/team-stats')
  .get(canView, validate(incentiveSchemeValidation.getTeamStats), incentiveSchemeController.getTeamStats);

// User stats — a user's own incentive earnings (My Profile), not part of the Incentive config surface
router
  .route('/user-stats-detail')
  .get(validate(incentiveSchemeValidation.getUserStats), incentiveSchemeController.getUserStatsDetail);

// Incentive logs
router
  .route('/logs')
  .get(canView, validate(incentiveSchemeValidation.getIncentiveLogs), incentiveSchemeController.getIncentiveLogs);

router
  .route('/logs/bulk-settle')
  .post(canUpdate, validate(incentiveSchemeValidation.bulkSettleLogs), incentiveSchemeController.bulkSettleLogs);

router
  .route('/logs/:logId')
  .patch(canUpdate, validate(incentiveSchemeValidation.updateLogStatus), incentiveSchemeController.updateLogStatus)
  .delete(canDelete, validate(incentiveSchemeValidation.deleteIncentiveLog), incentiveSchemeController.deleteIncentiveLog);

// Schemes CRUD
router
  .route('/')
  .get(canView, validate(incentiveSchemeValidation.getIncentiveSchemes), incentiveSchemeController.getIncentiveSchemes)
  .post(
    checkSubscription(PLAN_FEATURES.INCENTIVE),
    canAdd,
    validate(incentiveSchemeValidation.createIncentiveScheme),
    incentiveSchemeController.createIncentiveScheme,
  );

router
  .route('/:schemeId/status')
  .patch(
    canUpdate,
    validate(incentiveSchemeValidation.updateIncentiveSchemeStatus),
    incentiveSchemeController.updateIncentiveSchemeStatus,
  );

router
  .route('/:schemeId/consumption')
  .get(canView, validate(incentiveSchemeValidation.getSchemeConsumption), incentiveSchemeController.getSchemeConsumption);

router
  .route('/:schemeId')
  .get(canView, validate(incentiveSchemeValidation.getIncentiveScheme), incentiveSchemeController.getIncentiveScheme)
  .patch(canUpdate, validate(incentiveSchemeValidation.updateIncentiveScheme), incentiveSchemeController.updateIncentiveScheme)
  .delete(canDelete, validate(incentiveSchemeValidation.deleteIncentiveScheme), incentiveSchemeController.deleteIncentiveScheme);

router
  .route('/by-user/:userId')
  .get(canView, validate(incentiveSchemeValidation.getUserIncentiveSchemes), incentiveSchemeController.getUserIncentiveSchemes);

module.exports = router;
