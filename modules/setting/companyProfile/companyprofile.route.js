const express = require('express');
const companyValidation = require('./companyProfile.validate');
const companyProfile = require('./companyProfile.controller');
const validate = require('../../../middlewares/validate');
const { isAdmin } = require('../../../middlewares/isAdmin');
const { requireActiveFeature } = require('../../../middlewares/requireActiveFeature');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { checkSplitConfig } = require('../../../middlewares/checkRoleRight');
const { multerErrorHandler, multipleAttachmentUploadFields } = require('../../../middlewares/uploadMiddleware');
const parseFormData = require('../../../middlewares/parseFormData');
const { RIGHTS, ATTACHMENT_ONE_COUNT } = require('../../../utils/enum');
const { checkInventoryConfigRight, checkOtherSettingsRight } = require('../../../middlewares/checkRoleRight');

const router = express.Router();

const uploadFields = multipleAttachmentUploadFields([
  { name: 'companyLogo', maxCount: ATTACHMENT_ONE_COUNT },
  { name: 'authorizedSignature', maxCount: ATTACHMENT_ONE_COUNT },
]);

router.route('/send-pinNo').get(validate(companyValidation.verifyOtp), checkSplitConfig(RIGHTS.EDIT), companyProfile.setPinNo);

router.route('/verify-pinNo').get(validate(companyValidation.verifyOtp), companyProfile.verifyPinNo);

router
  .route('/address')
  .post(validate(companyValidation.addAdditionalAddress), companyProfile.addAdditionalAddress)
  .get(validate(companyValidation.getAdditionalAddresses), companyProfile.getCompanyShippingAddresses);

router
  .route('/address/:addressId')
  .put(validate(companyValidation.updateAdditionalAddress), companyProfile.updateAdditionalAddress);

router
  .route('/address/toggleStatus/:addressId')
  .put(validate(companyValidation.toggleAdditionalAddress), companyProfile.toggleAdditionalAddress);

router.route('/settings').get(validate(companyValidation.getComapny), companyProfile.getCompanySettings);

router
  .route('/additional-charges')
  .post(
    checkOtherSettingsRight('additionalChargesConfig', 'add'),
    validate(companyValidation.addAdditionalCharge),
    companyProfile.addAdditionalCharge,
  );

router
  .route('/additional-charges/:chargeName')
  .put(
    checkOtherSettingsRight('additionalChargesConfig', 'update'),
    validate(companyValidation.updateAdditionalCharge),
    companyProfile.updateAdditionalCharge,
  )
  .delete(
    checkOtherSettingsRight('additionalChargesConfig', 'delete'),
    validate(companyValidation.deleteAdditionalCharge),
    companyProfile.deleteAdditionalCharge,
  );

router
  .route('/inventory-config')
  .get(validate(companyValidation.getInventoryConfig), companyProfile.getInventoryConfig)
  .put(
    checkInventoryConfigRight('edit'),
    validate(companyValidation.updateInventoryConfig),
    companyProfile.updateInventoryConfig,
  );

router
  .route('/auto-pay-config')
  .get(validate(companyValidation.getAutoPayConfig), companyProfile.getAutoPayConfig)
  .put(isAdmin, validate(companyValidation.updateAutoPayConfig), companyProfile.updateAutoPayConfig);

router
  .route('/rejection-warehouse-config')
  .get(validate(companyValidation.getRejectionWarehouseConfig), companyProfile.getRejectionWarehouseConfig)
  .put(isAdmin, validate(companyValidation.updateRejectionWarehouseConfig), companyProfile.updateRejectionWarehouseConfig);

router
  .route('/email-config')
  .get(validate(companyValidation.getEmailConfig), companyProfile.getEmailConfig)
  .put(isAdmin, validate(companyValidation.updateEmailConfig), companyProfile.updateEmailConfig);

router.route('/email-config/test').post(isAdmin, validate(companyValidation.testEmailConfig), companyProfile.testEmailConfig);

router
  .route('/email-config/modules')
  .get(validate(companyValidation.getModuleEmailConfig), companyProfile.getModuleEmailConfig)
  .put(isAdmin, validate(companyValidation.updateModuleEmailConfig), companyProfile.updateModuleEmailConfig);
router
  .route('/admin-summary-setting')
  .get(isAdmin, validate(companyValidation.getAdminSummarySetting), companyProfile.getAdminSummarySetting)
  .put(isAdmin, validate(companyValidation.updateAdminSummarySetting), companyProfile.updateAdminSummarySetting);

router
  .route('/branch-config')
  .get(checkSplitConfig(RIGHTS.VIEW), validate(companyValidation.getBranchConfig), companyProfile.getBranchConfig)
  .put(checkSplitConfig(RIGHTS.EDIT), validate(companyValidation.updateBranchConfig), companyProfile.updateBranchConfig);

router
  .route('/quotation-config')
  .get(validate(companyValidation.getQuotationConfig), companyProfile.getQuotationConfig)
  .patch(validate(companyValidation.updateQuotationConfigByCompanyId), companyProfile.updateQuotationConfigByCompanyId)
  .put(validate(companyValidation.updateQuotationConfig), companyProfile.updateQuotationConfig);

router
  .route('/discount-config')
  .put(
    checkOtherSettingsRight('discountConfig', 'edit'),
    validate(companyValidation.discountConfig),
    companyProfile.discountConfig,
  );

router
  .route('/credit-limit-config')
  .get(validate(companyValidation.getCompanyCreditLimitConfig), companyProfile.getCompanyCreditLimitConfig)
  .put(isAdmin, validate(companyValidation.updateCreditLimitConfig), companyProfile.updateCreditLimitConfig);

router
  .route('/code')
  .get(
    requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER),
    validate(companyValidation.getCompanyCode),
    companyProfile.getCompanyCode,
  )
  .post(
    isAdmin,
    requireActiveFeature(PLAN_FEATURES.CUSTOMER_ORDER),
    validate(companyValidation.generateCompanyCode),
    companyProfile.generateCompanyCode,
  );

router.route('/subscription').get(validate(companyValidation.viewSubscription), companyProfile.viewSubscription);

router.route('/activeFeatureList').get(validate(companyValidation.viewSubscription), companyProfile.activeFeatureList);

router
  .route('/')
  .get(validate(companyValidation.getComapny), companyProfile.getComapny)
  .put(
    isAdmin,
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(companyValidation.updateCompany),
    companyProfile.updateCompany,
  );

module.exports = router;
