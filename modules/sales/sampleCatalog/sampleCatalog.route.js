const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');
const sampleCatalogValidation = require('./sampleCatalog.validation');
const sampleCatalogController = require('./sampleCatalog.controller');

const router = express.Router();

// Sample catalogs are offered through the customer portal, so they share its plan feature.
router.use(requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER));

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.SAMPLE_CATALOG, RIGHTS.CREATE),
    validate(sampleCatalogValidation.createSampleCatalog),
    sampleCatalogController.createSampleCatalog,
  )
  .get(
    checkRoleRight(RIGHT_LIST.SAMPLE_CATALOG, RIGHTS.VIEW),
    validate(sampleCatalogValidation.getSampleCatalogs),
    sampleCatalogController.getSampleCatalogs,
  );

router
  .route('/:sampleCatalogId')
  .get(
    checkRoleRight(RIGHT_LIST.SAMPLE_CATALOG, RIGHTS.VIEW),
    validate(sampleCatalogValidation.getSampleCatalog),
    sampleCatalogController.getSampleCatalog,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.SAMPLE_CATALOG, RIGHTS.EDIT),
    validate(sampleCatalogValidation.updateSampleCatalog),
    sampleCatalogController.updateSampleCatalog,
  );

router
  .route('/:sampleCatalogId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.SAMPLE_CATALOG, RIGHTS.EDIT),
    validate(sampleCatalogValidation.updateSampleCatalogStatus),
    sampleCatalogController.updateSampleCatalogStatus,
  );

module.exports = router;
