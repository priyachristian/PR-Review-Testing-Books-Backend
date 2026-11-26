// controllers/customerMaster.controller.js
const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const customerService = require('./customerMaster.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { CUSTOMER_MESSAGES } = require('../../../utils/messages');
const customerTransformers = require('./customer.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');
const { VERIFICATION_LINK_STATUS, ADDRESS_TYPE } = require('../../../utils/enum');

/**
 * Create a new Customer
 */
const createCustomer = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const customerBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const uploadedLogo = getUploadedFiles(req, 'logo');

    const customer = await customerService.createCustomer(
      { ...customerBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
      uploadedLogo,
    );
    return successResponse(res, { customer }, CUSTOMER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createCustomer',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const createBulkCustomers = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const customers = await customerService.createBulkCustomers(req.body.customers, userId, req.query.companyId);
    return successResponse(res, { customers }, CUSTOMER_MESSAGES.BULK_CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createBulkCustomers',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.BULK_CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const verifyBulkCustomerCreation = catchAsync(
  async (req, res) => {
    const result = await customerService.verifyBulkCustomerCreation(req.body.customers, req.query.companyId);
    return successResponse(res, result, CUSTOMER_MESSAGES.BULK_VERIFY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'verifyBulkCustomerCreation',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.BULK_VERIFY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const bulkAddCustomerOpeningBalance = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const result = await customerService.bulkAddCustomerOpeningBalance(req.body, req.query.companyId, userId);
    return successResponse(res, result, CUSTOMER_MESSAGES.BULK_ADD_OPENING_BALANCE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'bulkAddCustomerOpeningBalance',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.BULK_ADD_OPENING_BALANCE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const verifyBulkCustomerOpeningBalance = catchAsync(
  async (req, res) => {
    const result = await customerService.verifyBulkCustomerOpeningBalance(req.body.customerOpeningBalance, req.query.companyId);
    return successResponse(res, result, CUSTOMER_MESSAGES.BULK_VERIFY_OPENING_BALANCE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'verifyBulkCustomerOpeningBalance',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.BULK_VERIFY_OPENING_BALANCE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

/**
 * Get all customers by companyId
 */
const getAllCustomers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'role',
      'isActive',
      'status',
      'country',
      'state',
      'city',
      'appName',
      'startDate',
      'endDate',
      'customerDate',
      'verificationStatus',
      ,
      'appName',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const customers = await customerService.getAllCustomers(req.query, filter, options);
    const { results, ...otherFields } = customers;
    const transformedCustomers = customerTransformers.getAllCustomers(results);
    return successResponse(res, transformedCustomers, CUSTOMER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllCustomers',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

/**
 * Update an existing Customer
 */
const updateCustomer = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const { customerId } = req.params;
    const customerBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const uploadedLogo = getUploadedFiles(req, 'logo');

    const customer = await customerService.updateCustomer(
      customerId,
      { ...customerBody, companyId: req.query.companyId },
      userId,
      uploadedFiles,
      uploadedLogo,
    );
    return successResponse(res, { customer }, CUSTOMER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCustomer',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

/**
 * Delete a Customer by ID
 */
const deleteCustomer = catchAsync(
  async (req, res) => {
    const { customerId } = req.params;
    await customerService.deleteCustomer(customerId, req.query.companyId);
    return successResponse(res, null, CUSTOMER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteCustomer',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getVendorDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'branchId', 'isActive']);
    const result = await customerService.getVendors(filter);
    return successResponse(res, result, CUSTOMER_MESSAGES.FETCH_VENDOR_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getVendors',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_VENDOR_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'branchId', 'isActive']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await customerService.getCustomers(filter, options);
    return successResponse(res, result, CUSTOMER_MESSAGES.FETCH_CUSTOMER_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomers',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_CUSTOMER_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerById = catchAsync(
  async (req, res) => {
    const customer = await customerService.getCustomerById(req.params.customerId, req.query.companyId, req.query.isSplit);

    return successResponse(res, customer, CUSTOMER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomerById',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getVendorList = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'branchId', 'isActive']);
    const result = await customerService.getVendorList(filter);
    const transformedCustomers = customerTransformers.queryCustomersDocuments(result, req.query?.branchId);
    return successResponse(res, transformedCustomers, CUSTOMER_MESSAGES.FETCH_VENDOR_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryCustomersDocuments',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_VENDOR_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerList = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'branchId', 'isActive']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await customerService.getCustomerList(filter, options);
    const transformedCustomers = customerTransformers.queryCustomersDocuments(result, req.query?.branchId);

    return successResponse(res, transformedCustomers, CUSTOMER_MESSAGES.FETCH_CUSTOMER_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomerList',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_CUSTOMER_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllCustomerList = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isCustomer', 'isVendor', 'branchId', 'isActive']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const customers = await customerService.getAllCustomerList(filter, options);
    const transformedCustomers = customerTransformers.queryCustomersDocuments(customers, req.query?.branchId);

    return successResponse(res, transformedCustomers, CUSTOMER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAllCustomerList',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const viewCustomer = catchAsync(
  async (req, res) => {
    const customer = await customerService.viewCustomer(req.params.customerId, req.query.companyId);

    return successResponse(res, customer, CUSTOMER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'viewCustomer',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerAddress = catchAsync(
  async (req, res) => {
    const customer = await customerService.getCustomerAddress(req.query.customerId, req.query.companyId, req.query.addressType);
    return successResponse(res, customer, CUSTOMER_MESSAGES.FETCH_ADDRESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomerAddress',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_ADDRESS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const addCustomerShippingAddress = catchAsync(
  async (req, res) => {
    const { customerId, companyId, addressType } = req.query;
    const customer = await customerService.addCustomerShippingAddress(customerId, companyId, req.body, addressType);
    const message =
      addressType === ADDRESS_TYPE.BILLING
        ? CUSTOMER_MESSAGES.ADD_BILLING_ADDRESS_SUCCESS
        : CUSTOMER_MESSAGES.ADD_ADDRESS_SUCCESS;
    return successResponse(res, customer, message, httpStatus.OK);
  },
  {
    service: 'addCustomerShippingAddress',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.ADD_ADDRESS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateCustomerAddress = catchAsync(
  async (req, res) => {
    await customerService.updateCustomerAddress(req.params.addressId, req.body, req.query?.companyId, req.query.addressType);
    return successResponse(res, {}, CUSTOMER_MESSAGES.UPDATE_ADDRESS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCustomerAddress',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.UPDATE_ADDRESS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBusinessPartnerTeam = catchAsync(
  async (req, res) => {
    const businessPartnerTeam = await customerService.getBusinessPartnerTeam(req.query.customerId, req.query.companyId);
    return successResponse(res, businessPartnerTeam, CUSTOMER_MESSAGES.FETCH_BUSINESS_PARTNER_TEAM_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBusinessPartnerTeam',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_BUSINESS_PARTNER_TEAM_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createBusinessPartnerTeam = catchAsync(
  async (req, res) => {
    const member = await customerService.createBusinessPartnerTeam(req.query.customerId, req.query.companyId, req.body);
    return successResponse(res, member, CUSTOMER_MESSAGES.ADD_BUSINESS_PARTNER_TEAM_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createBusinessPartnerTeam',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.ADD_BUSINESS_PARTNER_TEAM_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateBusinessPartnerTeam = catchAsync(
  async (req, res) => {
    const member = await customerService.updateBusinessPartnerTeam(
      req.query.customerId,
      req.query.companyId,
      req.params.businessPartnerTeamId,
      req.body,
    );
    return successResponse(res, member, CUSTOMER_MESSAGES.UPDATE_BUSINESS_PARTNER_TEAM_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateBusinessPartnerTeam',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.UPDATE_BUSINESS_PARTNER_TEAM_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteBusinessPartnerTeam = catchAsync(
  async (req, res) => {
    await customerService.deleteBusinessPartnerTeam(req.query.customerId, req.query.companyId, req.params.businessPartnerTeamId);
    return successResponse(res, {}, CUSTOMER_MESSAGES.DELETE_BUSINESS_PARTNER_TEAM_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteBusinessPartnerTeam',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.DELETE_BUSINESS_PARTNER_TEAM_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateCustomerAddressStatus = catchAsync(
  async (req, res) => {
    const address = await customerService.updateCustomerAddressStatus(req.params.addressId, req.query.companyId);
    return successResponse(res, address, CUSTOMER_MESSAGES.UPDATE_ADDRESS_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCustomerAddressStatus',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.UPDATE_ADDRESS_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const customerId = req.params.customerId;
    const { isActive, companyId } = req.query;
    const customer = await customerService.updateStatus(customerId, isActive, companyId);
    return successResponse(res, customer, CUSTOMER_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateStatus',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPortalCustomers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'branchId', 'isActive']);
    const result = await customerService.getPortalCustomers(filter);
    return successResponse(res, result, CUSTOMER_MESSAGES.FETCH_PORTAL_CUSTOMERS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPortalCustomers',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_PORTAL_CUSTOMERS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomer360Analysis = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'fy', 'isSplit']);

    const payload = await customerService.getCustomer360Analysis({
      ...filter,
      customerId: req.params.customerId,
    });

    return successResponse(res, payload, CUSTOMER_MESSAGES.FETCH_360_ANALYSIS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomer360Analysis',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_360_ANALYSIS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerCreditDashboard = catchAsync(
  async (req, res) => {
    const query = pick(req.query, ['companyId', 'fy', 'isSplit']);
    const payload = await customerService.getCustomerCreditDashboard({
      ...query,
      customerId: req.params.customerId,
    });
    return successResponse(res, payload, CUSTOMER_MESSAGES.FETCH_CREDIT_DASHBOARD_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCustomerCreditDashboard',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_CREDIT_DASHBOARD_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCreditOverview = catchAsync(
  async (req, res) => {
    const query = pick(req.query, ['companyId', 'isCustomer', 'isVendor']);
    const payload = await customerService.getCreditOverview(query);
    return successResponse(res, payload, CUSTOMER_MESSAGES.FETCH_CREDIT_OVERVIEW_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCreditOverview',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_CREDIT_OVERVIEW_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCreditUtilization = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isCustomer', 'isVendor']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { results, ...otherFields } = await customerService.getCreditUtilization(filter, options);
    return successResponse(res, results, CUSTOMER_MESSAGES.FETCH_CREDIT_UTILIZATION_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getCreditUtilization',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_CREDIT_UTILIZATION_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getOverLimitCustomers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isCustomer', 'isVendor']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const { results, ...otherFields } = await customerService.getOverLimitCustomers(filter, options);
    return successResponse(res, results, CUSTOMER_MESSAGES.FETCH_OVER_LIMIT_CUSTOMERS_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getOverLimitCustomers',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_OVER_LIMIT_CUSTOMERS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const resendPortalInvite = catchAsync(
  async (req, res) => {
    const { customerId } = req.params;
    const { companyId } = req.query;
    const result = await customerService.resendPortalInvite(customerId, companyId);
    return successResponse(res, result, CUSTOMER_MESSAGES.RESEND_PORTAL_INVITE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'resendPortalInvite',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.RESEND_PORTAL_INVITE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const acceptCustomerVerification = catchAsync(
  async (req, res) => {
    const { customerId } = req.params;
    const { companyId } = req.query;
    const result = await customerService.updateVerificationStatus(customerId, companyId, VERIFICATION_LINK_STATUS.APPROVED);
    return successResponse(res, result, CUSTOMER_MESSAGES.ACCEPT_VERIFICATION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'acceptCustomerVerification',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.ACCEPT_VERIFICATION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const rejectCustomerVerification = catchAsync(
  async (req, res) => {
    const { customerId } = req.params;
    const { companyId } = req.query;
    const result = await customerService.updateVerificationStatus(customerId, companyId, VERIFICATION_LINK_STATUS.REJECTED);
    return successResponse(res, result, CUSTOMER_MESSAGES.REJECT_VERIFICATION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'rejectCustomerVerification',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.REJECT_VERIFICATION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const exportCustomers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'role',
      'isActive',
      'status',
      'country',
      'state',
      'city',
      'startDate',
      'endDate',
      'customerDate',
      'appName',
      'verificationStatus',
    ]);
    const customers = await customerService.exportCustomers(req.query, filter);
    const transformedCustomers = customerTransformers.exportCustomers(customers);
    return successResponse(res, transformedCustomers, CUSTOMER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'exportCustomers',
    controller: 'customerMaster',
    failureMessage: CUSTOMER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createCustomer,
  getAllCustomers,
  updateCustomer,
  deleteCustomer,
  getVendorDropdown,
  getCustomerDropdown,
  createBulkCustomers,
  verifyBulkCustomerCreation,
  bulkAddCustomerOpeningBalance,
  verifyBulkCustomerOpeningBalance,
  getCustomerById,
  getVendorList,
  getCustomerList,
  getAllCustomerList,
  viewCustomer,
  getCustomerAddress,
  addCustomerShippingAddress,
  updateCustomerAddress,
  updateCustomerAddressStatus,
  getBusinessPartnerTeam,
  createBusinessPartnerTeam,
  updateBusinessPartnerTeam,
  deleteBusinessPartnerTeam,
  updateStatus,
  getPortalCustomers,
  getCustomer360Analysis,
  getCustomerCreditDashboard,
  getCreditOverview,
  getCreditUtilization,
  getOverLimitCustomers,
  resendPortalInvite,
  acceptCustomerVerification,
  rejectCustomerVerification,
  exportCustomers,
};
