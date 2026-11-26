const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const agingreportService = require('./agingreport.service');
const { successResponse } = require('../../../services/response.service');
const { AGING_REPORT_MESSAGES } = require('../../../utils/messages');
const pick = require('../../../utils/pick');

const normalizeIds = ids => {
  if (!ids) return undefined;
  const parsed = ids
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
};

const processFilter = filter => {
  if (filter.entityIds) {
    filter.entityIds = normalizeIds(filter.entityIds);
    if (!filter.entityIds) delete filter.entityIds;
  }
  if (filter.customerIds) {
    filter.customerIds = normalizeIds(filter.customerIds);
    if (!filter.customerIds) delete filter.customerIds;
  }
  if (filter.vendorIds) {
    filter.vendorIds = normalizeIds(filter.vendorIds);
    if (!filter.vendorIds) delete filter.vendorIds;
  }
  if (filter.divisionId) {
    filter.divisionId = normalizeIds(filter.divisionId);
    if (!filter.divisionId) delete filter.divisionId;
  }
  if (filter.branchId) {
    filter.branchId = normalizeIds(filter.branchId);
    if (!filter.branchId) delete filter.branchId;
  }
  return { filter };
};

const getCustomerAging = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'startDate',
      'endDate',
      'numberOfColumns',
      'columnType',
      'duration',
      'companyId',
      'customerIds',
      'divisionId',
      'branchId',
      'sortBy',
      'isSplit',
      'splitOnly',
    ]);
    const processed = processFilter(filter);
    const agingReport = await agingreportService.getCustomerAging(processed.filter);
    return successResponse(res, agingReport, AGING_REPORT_MESSAGES.GET_CUSTOMER_AGING_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getCustomerAging',
    controller: 'agingreport',
    failureMessage: AGING_REPORT_MESSAGES.GET_CUSTOMER_AGING_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getVendorAging = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'startDate',
      'endDate',
      'numberOfColumns',
      'columnType',
      'duration',
      'companyId',
      'vendorIds',
      'divisionId',
      'branchId',
      'sortBy',
      'isSplit',
      'splitOnly',
    ]);
    const processed = processFilter(filter);
    const agingReport = await agingreportService.getVendorAging(processed.filter);
    return successResponse(res, agingReport, AGING_REPORT_MESSAGES.GET_VENDOR_AGING_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getVendorAging',
    controller: 'agingreport',
    failureMessage: AGING_REPORT_MESSAGES.GET_VENDOR_AGING_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerAgingDetails = catchAsync(
  async (req, res) => {
    const { customerId } = req.params;
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'isSplit', 'splitOnly']);
    const details = await agingreportService.getCustomerAgingDetails(customerId, filter);
    return successResponse(res, details, AGING_REPORT_MESSAGES.GET_CUSTOMER_AGING_DETAILS_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getCustomerAgingDetails',
    controller: 'agingreport',
    failureMessage: AGING_REPORT_MESSAGES.GET_CUSTOMER_AGING_DETAILS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getVendorAgingDetails = catchAsync(
  async (req, res) => {
    const { vendorId } = req.params;
    const filter = pick(req.query, ['companyId', 'startDate', 'endDate', 'isSplit', 'splitOnly']);
    const details = await agingreportService.getVendorAgingDetails(vendorId, filter);
    return successResponse(res, details, AGING_REPORT_MESSAGES.GET_VENDOR_AGING_DETAILS_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getVendorAgingDetails',
    controller: 'agingreport',
    failureMessage: AGING_REPORT_MESSAGES.GET_VENDOR_AGING_DETAILS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerAgingBucket = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'minDays',
      'maxDays',
      'customerIds',
      'branchId',
      'isSplit',
      'splitOnly',
    ]);
    filter.customerIds = normalizeIds(filter.customerIds);
    if (!filter.customerIds) delete filter.customerIds;
    if (filter.branchId) {
      filter.branchId = normalizeIds(filter.branchId);
      if (!filter.branchId) delete filter.branchId;
    }
    const bucketData = await agingreportService.getCustomerAgingBucket(filter);
    return successResponse(res, bucketData, AGING_REPORT_MESSAGES.GET_CUSTOMER_AGING_BUCKET_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getCustomerAgingBucket',
    controller: 'agingreport',
    failureMessage: AGING_REPORT_MESSAGES.GET_CUSTOMER_AGING_BUCKET_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getVendorAgingBucket = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'startDate',
      'endDate',
      'minDays',
      'maxDays',
      'vendorIds',
      'branchId',
      'isSplit',
      'splitOnly',
    ]);
    filter.vendorIds = normalizeIds(filter.vendorIds);
    if (!filter.vendorIds) delete filter.vendorIds;
    if (filter.branchId) {
      filter.branchId = normalizeIds(filter.branchId);
      if (!filter.branchId) delete filter.branchId;
    }
    const bucketData = await agingreportService.getVendorAgingBucket(filter);
    return successResponse(res, bucketData, AGING_REPORT_MESSAGES.GET_VENDOR_AGING_BUCKET_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getVendorAgingBucket',
    controller: 'agingreport',
    failureMessage: AGING_REPORT_MESSAGES.GET_VENDOR_AGING_BUCKET_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getUpcomingPayments = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'branchId',
      'startDate',
      'endDate',
      'numberOfColumns',
      'columnType',
      'duration',
      'customerIds',
      'vendorIds',
      'includePartiallyPaid',
      'sortBy',
    ]);
    const processed = processFilter(filter);
    const data = await agingreportService.getUpcomingPayments(processed.filter);
    return successResponse(res, data, AGING_REPORT_MESSAGES.GET_UPCOMING_PAYMENTS_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'getUpcomingPayments',
    controller: 'agingreport',
    failureMessage: AGING_REPORT_MESSAGES.GET_UPCOMING_PAYMENTS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getCustomerAging,
  getVendorAging,
  getCustomerAgingDetails,
  getVendorAgingDetails,
  getCustomerAgingBucket,
  getVendorAgingBucket,
  getUpcomingPayments,
};
