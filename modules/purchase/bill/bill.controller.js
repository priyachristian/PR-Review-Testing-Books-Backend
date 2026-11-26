const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const billService = require('./bill.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const { BILL_MESSAGES } = require('../../../utils/messages');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');
const billTransformers = require('./bill.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');

const createBill = catchAsync(async (req, res) => {
  try {
    const billBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const bill = await billService.createBill({ ...billBody, companyId: req.query.companyId }, req.user._id, uploadedFiles);
    return successResponse(res, bill, BILL_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createBill', controller: 'bill' },
      res,
      error?.message || BILL_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getBills = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'billId',
      'companyId',
      'customerId',
      'search',
      'status',
      'billDate',
      'startDate',
      'endDate',
      'isSplit',
      'branchId',
      'divisionId',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await billService.queryBills(filter, options);
    const { results, ...otherFields } = result;
    const transformedBill = billTransformers.queryBill(results);
    return successResponse(res, transformedBill, BILL_MESSAGES.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryBills',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getBillsExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'billId',
      'companyId',
      'customerId',
      'search',
      'status',
      'billDate',
      'startDate',
      'endDate',
      'isSplit',
      'branchId',
      'divisionId',
      'addedBy',
      'country',
      'state',
      'city',
      'addressType',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await billService.queryBillsExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedBill = billTransformers.queryBill(results);
    return successResponse(res, transformedBill, BILL_MESSAGES.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryBillsExports',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getBill = catchAsync(
  async (req, res) => {
    const bill = await billService.getBillById(req.params.billId, req.query.companyId);
    return successResponse(res, bill, BILL_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBillById',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateBill = catchAsync(async (req, res) => {
  try {
    const billBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const bill = await billService.updateBillById(
      req.params.billId,
      { ...billBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
    );
    return successResponse(res, bill, BILL_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'updateBillById', controller: 'bill' },
      res,
      error?.message || BILL_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const deleteBill = catchAsync(
  async (req, res) => {
    await billService.deleteBillById(req.params.billId, req.query.companyId, req.user._id);
    return successResponse(res, {}, BILL_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteBillById',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

/**
 * Get pending bills
 */
const getPendingBills = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'vendor',
      'branchId',
      'creditBranchId',
      'isSplit',
      'forCreditMapping',
      'allowCrossBranchMapping',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await billService.queryPendingBills(filter, options);
    return successResponse(res, result, BILL_MESSAGES.PENDING_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryPendingBills',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.PENDING_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getBillsDropdown = catchAsync(
  async (req, res) => {
    const filters = pick(req.query, ['companyId', 'vendor', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await billService.getBillsForDropdown(filters, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, BILL_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getBillsForDropdown',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getVendorWisePendingBills = catchAsync(
  async (req, res) => {
    const filter = {
      vendor: req.params.vendorId,
      ...pick(req.query, [
        'companyId',
        'isAdd',
        'isSplit',
        'forCreditMapping',
        'allowCrossBranchMapping',
        'branchId',
        'divisionId',
        'warehouseId',
      ]),
      ...(req.query.isAdd ? {} : { balanceAmount: { $gt: 0 } }),
    };
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await billService.queryVendorWisePendingBills(filter, options);
    return successResponse(res, result, BILL_MESSAGES.PENDING_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryVendorWisePendingBills',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.PENDING_FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateBillStatus = catchAsync(
  async (req, res) => {
    const bill = await billService.updateBillStatus(req.params.billId, req.query.companyId, req.body.status, req.user._id);
    return successResponse(res, bill, BILL_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateBillStatus',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const exportBills = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'billId',
      'companyId',
      'customerId',
      'search',
      'status',
      'billDate',
      'startDate',
      'endDate',
      'isSplit',
      'branchId',
      'divisionId',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await billService.exportBills(filter, options, res);
    return successResponse(res, {}, BILL_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'exportBills',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const paymentHistoryForBill = catchAsync(
  async (req, res) => {
    const billId = req.params.billId;
    const companyId = req.query.companyId;
    const paymentHistory = await billService.paymentHistoryForBill(billId, companyId);
    return successResponse(res, paymentHistory, BILL_MESSAGES.PAYMENT_HISTORY_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'paymentHistoryForBill',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.PAYMENT_HISTORY_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createSplitBill = catchAsync(async (req, res) => {
  try {
    const billBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const bill = await billService.createSplitBill({ ...billBody, companyId: req.query.companyId }, req.user._id, uploadedFiles);
    return successResponse(res, bill, BILL_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createSplitBill', controller: 'bill' },
      res,
      error?.message || BILL_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const applyVendorCreditToBill = catchAsync(
  async (req, res) => {
    const { applications = [], contextBillId = null } = req.body;
    const { vendorId } = req.params;
    const { branchId } = req.query;
    await billService.applyVendorCreditToBill(vendorId, req.query.companyId, branchId, applications, req.user._id, contextBillId);
    return successResponse(res, { success: true }, BILL_MESSAGES.APPLY_CREDIT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'applyVendorCreditToBill',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.APPLY_CREDIT_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const autoMapOpeningBalanceToBills = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'vendorId', 'branchId', 'isSplit']);
    const payload = await billService.autoMapOpeningBalanceToBills(filter);
    return successResponse(res, payload, BILL_MESSAGES.AUTO_MAP_OB_SUCCESS, httpStatus.OK);
  },
  {
    service: 'autoMapOpeningBalanceToBills',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.AUTO_MAP_OB_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const removeOpeningBalanceApplicationFromBill = catchAsync(
  async (req, res) => {
    const { billId, applicationId } = req.params;
    const { companyId } = req.query;
    await billService.removeOpeningBalanceApplicationFromBill(billId, companyId, applicationId, req.user._id);
    return successResponse(res, { success: true }, BILL_MESSAGES.REMOVE_OB_APPLICATION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'removeOpeningBalanceApplicationFromBill',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.REMOVE_OB_APPLICATION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const removeOpeningBalanceApplicationFromOb = catchAsync(
  async (req, res) => {
    const { creditTxnId, applicationId } = req.params;
    const { companyId } = req.query;
    await billService.removeOpeningBalanceApplicationFromOb(creditTxnId, companyId, applicationId);
    return successResponse(res, { success: true }, BILL_MESSAGES.REMOVE_OB_APPLICATION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'removeOpeningBalanceApplicationFromOb',
    controller: 'bill',
    failureMessage: BILL_MESSAGES.REMOVE_OB_APPLICATION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.billId,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.BILL,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  getStockMovement,
  createBill,
  getBills,
  getBillsExports,
  getBill,
  updateBill,
  deleteBill,
  getPendingBills,
  getBillsDropdown,
  getVendorWisePendingBills,
  updateBillStatus,
  exportBills,
  paymentHistoryForBill,
  createSplitBill,
  applyVendorCreditToBill,
  autoMapOpeningBalanceToBills,
  removeOpeningBalanceApplicationFromBill,
  removeOpeningBalanceApplicationFromOb,
};
