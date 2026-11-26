const express = require('express');
const onboardingValidation = require('./onboarding.validation');
const onboardingController = require('./onboarding.controller');
const validate = require('../../../middlewares/validate');
const { isAdmin } = require('../../../middlewares/isAdmin');

const router = express.Router();

router.route('/status').get(validate(onboardingValidation.getOnboardingStatus), onboardingController.getOnboardingStatus);

// Data Setup (CRM->BOOKS backfills) — admin only.
router
  .route('/data-setup/status')
  .get(isAdmin, validate(onboardingValidation.getDataSetupStatus), onboardingController.getDataSetupStatus);

router
  .route('/data-setup/preview')
  .get(isAdmin, validate(onboardingValidation.getDataSetupPreview), onboardingController.getDataSetupPreview);

router.route('/data-setup/run').post(isAdmin, validate(onboardingValidation.runDataSetup), onboardingController.runDataSetup);

module.exports = router;
