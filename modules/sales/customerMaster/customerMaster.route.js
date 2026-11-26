const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const customerMasterValidation = require('./customerMaster.validation');
const customerController = require('./customerMaster.controller');
const validate = require('../../../middlewares/validate');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUploadFields, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { dynamicRoleCheck, checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { RIGHTS, RIGHT_LIST, ATTACHMENT_MAX_COUNT, ATTACHMENT_ONE_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUploadFields([
  { name: 'attachment', maxCount: ATTACHMENT_MAX_COUNT },
  { name: 'logo', maxCount: ATTACHMENT_ONE_COUNT },
]);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.CUSTOMER),
    dynamicRoleCheck(RIGHTS.CREATE),
    validate(customerMasterValidation.createCustomer),
    customerController.createCustomer,
  )
  .get(dynamicRoleCheck(RIGHTS.VIEW), validate(customerMasterValidation.getCustomers), customerController.getAllCustomers);

router
  .route('/exports')
  .get(dynamicRoleCheck(RIGHTS.VIEW), validate(customerMasterValidation.exportCustomers), customerController.exportCustomers);

router
  .route('/bulk')
  .post(
    checkSubscription(PLAN_FEATURES.CUSTOMER),
    dynamicRoleCheck(RIGHTS.CREATE),
    validate(customerMasterValidation.createBulkCustomers),
    customerController.createBulkCustomers,
  );

router
  .route('/bulk/verify')
  .post(
    checkSubscription(PLAN_FEATURES.CUSTOMER),
    dynamicRoleCheck(RIGHTS.CREATE),
    validate(customerMasterValidation.verifyBulkCustomerCreation),
    customerController.verifyBulkCustomerCreation,
  );

router
  .route('/branch/opening-balance/bulk')
  .post(validate(customerMasterValidation.bulkAddCustomerOpeningBalance), customerController.bulkAddCustomerOpeningBalance);

router
  .route('/branch/opening-balance/bulk/verify')
  .post(validate(customerMasterValidation.verifyBulkCustomerOpeningBalance), customerController.verifyBulkCustomerOpeningBalance);

router.route('/venderDropdown').get(validate(customerMasterValidation.getVenderDropdown), customerController.getVendorDropdown);

router.route('/venderList').get(validate(customerMasterValidation.getVenderDropdown), customerController.getVendorList);

router
  .route('/customerDropdown')
  .get(validate(customerMasterValidation.getCustomerDropdown), customerController.getCustomerDropdown);

router
  .route('/portalCustomers')
  .get(
    requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER),
    validate(customerMasterValidation.getPortalCustomers),
    customerController.getPortalCustomers,
  );

router.route('/customerList').get(validate(customerMasterValidation.getCustomerDropdown), customerController.getCustomerList);

router.route('/dropdown').get(validate(customerMasterValidation.getAllCustomers), customerController.getAllCustomerList);

router
  .route('/viewCustomer/:customerId')
  .get(validate(customerMasterValidation.getCustomerById), customerController.viewCustomer);

router
  .route('/analysis360/:customerId')
  .get(validate(customerMasterValidation.getCustomer360Analysis), customerController.getCustomer360Analysis);

router
  .route('/customer-credit-dashboard/:customerId')
  .get(
    validate(customerMasterValidation.getCustomerCreditDashboard),
    checkRoleRight(RIGHT_LIST.CUSTOMER_MASTER, RIGHTS.VIEW),
    customerController.getCustomerCreditDashboard,
  );

router
  .route('/credit-overview')
  .get(validate(customerMasterValidation.getCreditOverview), dynamicRoleCheck(RIGHTS.VIEW), customerController.getCreditOverview);

router
  .route('/credit-utilization')
  .get(
    validate(customerMasterValidation.getCreditUtilization),
    dynamicRoleCheck(RIGHTS.VIEW),
    customerController.getCreditUtilization,
  );

router
  .route('/over-limit-customers')
  .get(
    validate(customerMasterValidation.getOverLimitCustomers),
    dynamicRoleCheck(RIGHTS.VIEW),
    customerController.getOverLimitCustomers,
  );

router
  .route('/address')
  .post(validate(customerMasterValidation.addCustomerShippingAddress), customerController.addCustomerShippingAddress)
  .get(validate(customerMasterValidation.getCustomerAddress), customerController.getCustomerAddress);

router
  .route('/address/:addressId')
  .put(validate(customerMasterValidation.updateCustomerAddress), customerController.updateCustomerAddress);

router
  .route('/address/toggleStatus/:addressId')
  .put(validate(customerMasterValidation.updateCustomerAddressStatus), customerController.updateCustomerAddressStatus);

router
  .route('/businessPartnerTeam')
  .get(validate(customerMasterValidation.getBusinessPartnerTeam), customerController.getBusinessPartnerTeam)
  .post(validate(customerMasterValidation.createBusinessPartnerTeam), customerController.createBusinessPartnerTeam);

router
  .route('/businessPartnerTeam/:businessPartnerTeamId')
  .put(validate(customerMasterValidation.updateBusinessPartnerTeam), customerController.updateBusinessPartnerTeam)
  .delete(validate(customerMasterValidation.deleteBusinessPartnerTeam), customerController.deleteBusinessPartnerTeam);

router
  .route('/resendPortalInvite/:customerId')
  .post(
    dynamicRoleCheck(RIGHTS.EDIT),
    requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER),
    validate(customerMasterValidation.resendPortalInvite),
    customerController.resendPortalInvite,
  );

router
  .route('/updateStatus/:customerId')
  .put(dynamicRoleCheck(RIGHTS.EDIT), validate(customerMasterValidation.updateStatus), customerController.updateStatus);

router
  .route('/:customerId/accept')
  .patch(
    dynamicRoleCheck(RIGHTS.EDIT),
    requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER),
    validate(customerMasterValidation.acceptCustomerVerification),
    customerController.acceptCustomerVerification,
  );

router
  .route('/:customerId/reject')
  .patch(
    dynamicRoleCheck(RIGHTS.EDIT),
    requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER),
    validate(customerMasterValidation.rejectCustomerVerification),
    customerController.rejectCustomerVerification,
  );

router
  .route('/:customerId')
  .get(validate(customerMasterValidation.getCustomerDetail), customerController.getCustomerById)
  .put(
    dynamicRoleCheck(RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(customerMasterValidation.updateCustomer),
    customerController.updateCustomer,
  )
  .delete(dynamicRoleCheck(RIGHTS.DELETE), validate(customerMasterValidation.deleteCustomer), customerController.deleteCustomer);

module.exports = router;
