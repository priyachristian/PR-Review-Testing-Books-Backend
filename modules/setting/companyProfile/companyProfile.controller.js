const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const companyService = require('./companyProfile.service');
const { successResponse } = require('../../../services/response.service');
const { COMPANY_MESSAGES } = require('../../../utils/messages');
const { getUploadedFiles } = require('../../../utils/fileUploadHelper');

const updateCompany = catchAsync(
  async (req, res) => {
    const companyLogo = getUploadedFiles(req, 'companyLogo');
    const authorizedSignature = getUploadedFiles(req, 'authorizedSignature');
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const company = await companyService.updateCompanyById(companyId, req.body, userId, companyLogo, authorizedSignature);
    return successResponse(res, company, COMPANY_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCompanyById',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getComapny = catchAsync(
  async (req, res) => {
    const company = await companyService.getCompanyByCompanyId(req.query.companyId);
    return successResponse(res, company, COMPANY_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCompanyByCompanyId',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCompanyCode = catchAsync(
  async (req, res) => {
    const code = await companyService.getCompanyCode(req.query.companyId);
    return successResponse(res, { code }, COMPANY_MESSAGES.COMPANY_CODE_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCompanyCode',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.COMPANY_CODE_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const generateCompanyCode = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const code = await companyService.generateCompanyCode(companyId, userId);
    return successResponse(res, { code }, COMPANY_MESSAGES.COMPANY_CODE_GENERATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'generateCompanyCode',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.COMPANY_CODE_GENERATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const addAdditionalCharge = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.addAdditionalCharge(companyId, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.ADDITIONAL_CHARGE_ADD_SUCCESS, httpStatus.OK);
  },
  {
    service: 'addAdditionalCharge',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADDITIONAL_CHARGE_ADD_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateAdditionalCharge = catchAsync(
  async (req, res) => {
    const { chargeName } = req.params;
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.updateAdditionalCharge(companyId, chargeName, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.ADDITIONAL_CHARGE_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateAdditionalCharge',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADDITIONAL_CHARGE_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteAdditionalCharge = catchAsync(
  async (req, res) => {
    const { chargeName } = req.params;
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.deleteAdditionalCharge(companyId, chargeName, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.ADDITIONAL_CHARGE_DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteAdditionalCharge',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADDITIONAL_CHARGE_DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateInventoryConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.updateInventoryConfig(companyId, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.INVENTORY_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateInventoryConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.INVENTORY_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateQuotationConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.updateQuotationConfig(companyId, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.QUOTATION_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateQuotationConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.QUOTATION_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCompanySettings = catchAsync(
  async (req, res) => {
    const settings = await companyService.getOrCreateCompanySettings(req.query.companyId, req.user._id);
    return successResponse(res, settings, COMPANY_MESSAGES.SETTINGS_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getOrCreateCompanySettings',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.SETTINGS_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateBranchConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.updateBranchConfig(companyId, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.BRANCH_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateBranchConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.BRANCH_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const setPinNo = catchAsync(
  async (req, res) => {
    const user = await companyService.setPinNo(req.query.companyId, req.query.pinNo);
    return successResponse(res, user, COMPANY_MESSAGES.SENT_PIN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'setPinNo',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.SENT_PIN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const verifyPinNo = catchAsync(
  async (req, res) => {
    const isVerified = await companyService.verifyPinNo(req.query.pinNo, req.query.companyId);
    return successResponse(res, {}, COMPANY_MESSAGES.VERIFY_PIN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'verifyPinNo',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.VERIFY_PIN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const discountConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.discountConfig(companyId, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.DISCOUNT_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'discountConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.DISCOUNT_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const addAdditionalAddress = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const address = await companyService.addAdditionalAddress(companyId, req.body, userId);
    return successResponse(res, address, COMPANY_MESSAGES.ADDITIONAL_ADDRESS_ADD_SUCCESS, httpStatus.OK);
  },
  {
    service: 'addAdditionalAddress',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADDITIONAL_ADDRESS_ADD_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCompanyShippingAddresses = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const addresses = await companyService.getCompanyShippingAddresses(companyId);
    return successResponse(res, addresses, COMPANY_MESSAGES.ADDITIONAL_ADDRESS_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCompanyShippingAddresses',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADDITIONAL_ADDRESS_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateAdditionalAddress = catchAsync(
  async (req, res) => {
    const { addressId } = req.params;
    const userId = req.user._id;
    const address = await companyService.updateAdditionalAddress(addressId, req.query.companyId, req.body, userId);
    return successResponse(res, address, COMPANY_MESSAGES.ADDITIONAL_ADDRESS_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateAdditionalAddress',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADDITIONAL_ADDRESS_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const toggleAdditionalAddress = catchAsync(
  async (req, res) => {
    const { addressId } = req.params;
    const userId = req.user._id;
    const address = await companyService.updateCompanyAddressStatus(addressId, req.query.companyId, userId);
    return successResponse(res, address, COMPANY_MESSAGES.ADDITIONAL_ADDRESS_TOGGLE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCompanyAddressStatus',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADDITIONAL_ADDRESS_TOGGLE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const viewSubscription = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const subscriptionDetails = await companyService.viewSubscription(companyId);
    return successResponse(res, subscriptionDetails, COMPANY_MESSAGES.SUBSCRIPTION_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'viewSubscription',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.SUBSCRIPTION_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const activeFeatureList = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const features = await companyService.activeFeatureList(companyId);
    return successResponse(res, features, COMPANY_MESSAGES.SUBSCRIPTION_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'activeFeatureList',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.SUBSCRIPTION_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getBranchConfig = catchAsync(
  async (req, res) => {
    const config = await companyService.getBranchConfig(req.query.companyId);
    return successResponse(res, config, COMPANY_MESSAGES.BRANCH_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBranchConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.BRANCH_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getInventoryConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const settings = await companyService.getInventoryConfig(companyId);
    return successResponse(res, settings, COMPANY_MESSAGES.INVENTORY_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getInventoryConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.INVENTORY_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getAutoPayConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const settings = await companyService.getAutoPayConfig(companyId);
    return successResponse(res, settings, COMPANY_MESSAGES.AUTO_PAY_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAutoPayConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.AUTO_PAY_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateAutoPayConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.updateAutoPayConfig(companyId, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.AUTO_PAY_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateAutoPayConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.AUTO_PAY_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateCreditLimitConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const settings = await companyService.updateCreditLimitConfig(companyId, req.body, userId);
    return successResponse(res, settings, COMPANY_MESSAGES.CREDIT_LIMIT_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCreditLimitConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.CREDIT_LIMIT_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCompanyCreditLimitConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const settings = await companyService.getCompanyCreditLimitConfig(companyId);
    return successResponse(res, settings, COMPANY_MESSAGES.CREDIT_LIMIT_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCompanyCreditLimitConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.CREDIT_LIMIT_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getQuotationConfig = catchAsync(
  async (req, res) => {
    const companySettings = await companyService.getQuotationConfigByCompanyId(req.query.companyId);
    return successResponse(res, companySettings, COMPANY_MESSAGES.QUOTATION_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getQuotationConfigByCompanyId',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.QUOTATION_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateQuotationConfigByCompanyId = catchAsync(
  async (req, res) => {
    const updatedSettings = await companyService.updateQuotationConfigByCompanyId(req.query.companyId, req.body);
    return successResponse(res, updatedSettings, COMPANY_MESSAGES.QUOTATION_CONFIG_UPDATE_BY_COMPANY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateQuotationConfigByCompanyId',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.QUOTATION_CONFIG_UPDATE_BY_COMPANY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRejectionWarehouseConfig = catchAsync(
  async (req, res) => {
    const config = await companyService.updateRejectionWarehouseConfig(req.query.companyId, req.body);
    return successResponse(res, config, COMPANY_MESSAGES.REJECTION_WAREHOUSE_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRejectionWarehouseConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.REJECTION_WAREHOUSE_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getRejectionWarehouseConfig = catchAsync(
  async (req, res) => {
    const config = await companyService.getRejectionWarehouseConfig(req.query.companyId);
    return successResponse(res, config, COMPANY_MESSAGES.REJECTION_WAREHOUSE_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRejectionWarehouseConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.REJECTION_WAREHOUSE_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateEmailConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const config = await companyService.updateEmailConfig(companyId, req.body, userId);
    return successResponse(res, config, COMPANY_MESSAGES.EMAIL_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateEmailConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.EMAIL_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getAdminSummarySetting = catchAsync(
  async (req, res) => {
    const settings = await companyService.getAdminSummarySetting(req.query.companyId);
    return successResponse(res, settings, COMPANY_MESSAGES.ADMIN_SUMMARY_SETTING_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAdminSummarySetting',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADMIN_SUMMARY_SETTING_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getEmailConfig = catchAsync(
  async (req, res) => {
    const config = await companyService.getEmailConfig(req.query.companyId);
    return successResponse(res, config, COMPANY_MESSAGES.EMAIL_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getEmailConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.EMAIL_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const testEmailConfig = catchAsync(
  async (req, res) => {
    const result = await companyService.testEmailConfig(req.body);

    return successResponse(res, result, COMPANY_MESSAGES.EMAIL_CONFIG_TEST_SUCCESS, httpStatus.OK);
  },
  {
    service: 'testEmailConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.EMAIL_CONFIG_TEST_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getModuleEmailConfig = catchAsync(
  async (req, res) => {
    const config = await companyService.getModuleEmailConfig(req.query.companyId);
    return successResponse(res, config, COMPANY_MESSAGES.MODULE_EMAIL_CONFIG_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getModuleEmailConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.MODULE_EMAIL_CONFIG_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateModuleEmailConfig = catchAsync(
  async (req, res) => {
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const config = await companyService.updateModuleEmailConfig(companyId, req.body, userId);
    return successResponse(res, config, COMPANY_MESSAGES.MODULE_EMAIL_CONFIG_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateModuleEmailConfig',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.MODULE_EMAIL_CONFIG_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateAdminSummarySetting = catchAsync(
  async (req, res) => {
    const settings = await companyService.updateAdminSummarySetting(req.query.companyId, req.body);
    return successResponse(res, settings, COMPANY_MESSAGES.ADMIN_SUMMARY_SETTING_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateAdminSummarySetting',
    controller: 'companyProfile',
    failureMessage: COMPANY_MESSAGES.ADMIN_SUMMARY_SETTING_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  updateCompany,
  getComapny,
  getCompanyCode,
  generateCompanyCode,
  addAdditionalCharge,
  updateAdditionalCharge,
  deleteAdditionalCharge,
  updateInventoryConfig,
  updateQuotationConfig,
  getCompanySettings,
  updateBranchConfig,
  setPinNo,
  verifyPinNo,
  discountConfig,
  addAdditionalAddress,
  getCompanyShippingAddresses,
  updateAdditionalAddress,
  toggleAdditionalAddress,
  viewSubscription,
  activeFeatureList,
  getBranchConfig,
  getInventoryConfig,
  getAutoPayConfig,
  updateAutoPayConfig,
  updateCreditLimitConfig,
  getCompanyCreditLimitConfig,
  getQuotationConfig,
  updateQuotationConfigByCompanyId,
  updateRejectionWarehouseConfig,
  getRejectionWarehouseConfig,
  updateEmailConfig,
  getEmailConfig,
  getModuleEmailConfig,
  updateModuleEmailConfig,
  testEmailConfig,
  getAdminSummarySetting,
  updateAdminSummarySetting,
};
