const express = require('express');
const agingreportValidation = require('./agingreport.validation');
const agingreportController = require('./agingreport.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/customer-aging')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(agingreportValidation.getCustomerAging),
    agingreportController.getCustomerAging,
  );

router
  .route('/vendor-aging')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(agingreportValidation.getVendorAging),
    agingreportController.getVendorAging,
  );

// Bucket routes must come BEFORE parameterized routes to avoid route matching conflicts
router
  .route('/customer-aging/bucket')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(agingreportValidation.getCustomerAgingBucket),
    agingreportController.getCustomerAgingBucket,
  );

router
  .route('/vendor-aging/bucket')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(agingreportValidation.getVendorAgingBucket),
    agingreportController.getVendorAgingBucket,
  );

router
  .route('/customer-aging/:customerId')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(agingreportValidation.getCustomerAgingDetails),
    agingreportController.getCustomerAgingDetails,
  );

router
  .route('/vendor-aging/:vendorId')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(agingreportValidation.getVendorAgingDetails),
    agingreportController.getVendorAgingDetails,
  );

router
  .route('/upcoming-payments')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(agingreportValidation.getUpcomingPayments),
    agingreportController.getUpcomingPayments,
  );

module.exports = router;
