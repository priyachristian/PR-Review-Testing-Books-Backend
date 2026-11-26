const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const invoiceService = require('./invoice.service');
const { successResponse, errorResponse } = require('../../../services/response.service');
const { INVOICE_MESSAGES } = require('../../../utils/messages');
const invoiceTransformers = require('./invoice.transformer');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');
const { getDocumentStockMovements, STOCK_MOVEMENT_DOCUMENT_TYPE } = require('../../../services/documentStockMovement.service');

const createInvoice = catchAsync(async (req, res) => {
  try {
    const invoiceBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const uploadedFile = uploadedFiles.length > 0 ? uploadedFiles : null;

    const invoice = await invoiceService.createInvoice(
      { ...invoiceBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFile,
    );
    return successResponse(res, invoice, INVOICE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    console.log({ error });
    return errorResponse(
      { req, error, service: 'createInvoice', controller: 'invoice' },
      res,
      error?.message || INVOICE_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const getInvoices = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'invoiceId',
      'companyId',
      'customerId',
      'search',
      'status',
      'invoiceDate',
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
      'eInvoicePending',
      'eWayBillPending',
      'includeComplianceCount',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await invoiceService.queryInvoices(filter, options);
    const { results, ...otherFields } = result;
    const transformedInvoices = invoiceTransformers.queryInvoice(results);
    return successResponse(res, transformedInvoices, INVOICE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryInvoices',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getInvoicesExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'invoiceId',
      'companyId',
      'customerId',
      'search',
      'status',
      'invoiceDate',
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
    const result = await invoiceService.queryInvoicesExports(filter, options);
    const { results, ...otherFields } = result;
    const transformedInvoices = invoiceTransformers.queryInvoice(results);
    return successResponse(res, transformedInvoices, INVOICE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryInvoicesExports',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCustomerWisePendingInvoices = catchAsync(
  async (req, res) => {
    const filter = {
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
      customerId: req.params.customerId,
    };
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await invoiceService.queryCustomerWisePendingInvoices(filter, options);
    return successResponse(res, result, INVOICE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryCustomerWisePendingInvoices',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getInvoice = catchAsync(
  async (req, res) => {
    const invoice = await invoiceService.getInvoiceById(req.params.invoiceId, req.query.companyId);
    return successResponse(res, invoice, INVOICE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getInvoiceById',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateInvoice = catchAsync(async (req, res) => {
  try {
    const invoiceBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const uploadedFile = uploadedFiles.length > 0 ? uploadedFiles : null;

    const invoice = await invoiceService.updateInvoiceById(
      req.params.invoiceId,
      { ...invoiceBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFile,
    );
    return successResponse(res, invoice, INVOICE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  } catch (error) {
    console.log({ error });
    return errorResponse(
      { req, error, service: 'updateInvoiceById', controller: 'invoice' },
      res,
      error?.message || INVOICE_MESSAGES.UPDATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const deleteInvoice = catchAsync(
  async (req, res) => {
    await invoiceService.deleteInvoiceById(req.params.invoiceId, req.query.companyId, req.user._id);
    return successResponse(res, {}, INVOICE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteInvoiceById',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPendingInvoices = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'customerId',
      'branchId',
      'creditBranchId',
      'isSplit',
      'forCreditMapping',
      'allowCrossBranchMapping',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await invoiceService.queryPendingInvoices(filter, options);
    return successResponse(res, result, INVOICE_MESSAGES.PENDING_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryPendingInvoices',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.PENDING_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getInvoicesDropdown = catchAsync(
  async (req, res) => {
    const filters = pick(req.query, ['companyId', 'customerId', 'search']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await invoiceService.getInvoicesForDropdown(filters, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, INVOICE_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getInvoicesForDropdown',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateInvoiceStatus = catchAsync(
  async (req, res) => {
    const invoice = await invoiceService.updateInvoiceStatus(
      req.params.invoiceId,
      req.query.companyId,
      req.body.status,
      req.user._id,
    );
    return successResponse(res, invoice, INVOICE_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateInvoiceStatus',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const generateFynamicsEInvoice = catchAsync(async (req, res) => {
  try {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const invoice = await invoiceService.generateFynamicsEInvoiceFromInvoice(
      invoiceId,
      req.body.EwbDtls,
      companyId,
      req.user._id,
      req.body.items,
    );
    return successResponse(res, invoice, INVOICE_MESSAGES.GENERATE_E_INVOICE_SUCCESS, httpStatus.OK);
  } catch (error) {
    const isHsnInclude = error?.data?.invalidHsn || error.message?.toLowerCase()?.includes('hsn');
    const hsnCodes = error?.data?.invalidHsnCodes?.length
      ? error.data.invalidHsnCodes
      : error?.message?.match(/\b\d{4,8}\b/g) || [];
    return errorResponse(
      { req, error, service: 'generateFynamicsEInvoiceFromInvoice', controller: 'invoice' },
      res,
      error?.message || INVOICE_MESSAGES.GENERATE_E_INVOICE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      0,
      isHsnInclude ? { isInvalidHsn: true, invalidHsnCodes: hsnCodes } : {},
    );
  }
});

const generateEInvoice = catchAsync(async (req, res) => {
  try {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const invoice = await invoiceService.generateEInvoiceFromInvoice(
      invoiceId,
      req.body.EwbDtls,
      companyId,
      req.user._id,
      req.body.items,
      req.body.updateItemMaster,
      req.body.EInvDtls,
    );
    return successResponse(res, invoice, INVOICE_MESSAGES.GENERATE_E_INVOICE_SUCCESS, httpStatus.OK);
  } catch (error) {
    const isHsnInclude = error?.data?.invalidHsn || error.message?.toLowerCase()?.includes('hsn');
    const hsnCodes = error?.data?.invalidHsnCodes?.length
      ? error.data.invalidHsnCodes
      : error?.message?.match(/\b\d{4,8}\b/g) || [];
    return errorResponse(
      { req, error, service: 'generateEInvoiceFromInvoice', controller: 'invoice' },
      res,
      error?.message || INVOICE_MESSAGES.GENERATE_E_INVOICE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      0,
      isHsnInclude ? { isInvalidHsn: true, invalidHsnCodes: hsnCodes } : {},
    );
  }
});

const getGstDocumentOptions = catchAsync(
  async (req, res) => {
    const { invoiceId } = req.params;
    const { companyId } = req.query;
    const result = await invoiceService.getInvoiceGstDocumentOptions(invoiceId, companyId);
    return successResponse(res, result, INVOICE_MESSAGES.FETCH_GST_DOCUMENT_OPTIONS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getInvoiceGstDocumentOptions',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.FETCH_GST_DOCUMENT_OPTIONS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const refetchEInvoice = catchAsync(
  async (req, res) => {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const result = await invoiceService.refetchEInvoiceFromInvoice(invoiceId, companyId, req.user._id);
    return successResponse(res, result, INVOICE_MESSAGES.REFETCH_E_INVOICE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'refetchEInvoiceFromInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.REFETCH_E_INVOICE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const generateEWayBill = catchAsync(
  async (req, res) => {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const invoice = await invoiceService.generateEWayBillFromInvoice(invoiceId, req.body.EwbDtls, companyId, req.user._id);
    return successResponse(res, invoice, INVOICE_MESSAGES.GENERATE_E_WAY_BILL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'generateEWayBillFromInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.GENERATE_E_WAY_BILL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const cancelEInvoice = catchAsync(
  async (req, res) => {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const invoice = await invoiceService.cancelEInvoiceFromInvoice(req.body, invoiceId, companyId, req.user._id);
    return successResponse(res, invoice, INVOICE_MESSAGES.CANCEL_E_INVOICE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'cancelEInvoiceFromInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.CANCEL_E_INVOICE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const cancelEWayBill = catchAsync(
  async (req, res) => {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const invoice = await invoiceService.cancelEWayBillFromInvoice(req.body, invoiceId, companyId, req.user._id);
    return successResponse(res, invoice, INVOICE_MESSAGES.CANCEL_E_WAY_BILL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'cancelEWayBillFromInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.CANCEL_E_WAY_BILL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const paymentHistoryForInvoice = catchAsync(
  async (req, res) => {
    const invoiceId = req.params.invoiceId;
    const companyId = req.query.companyId;
    const result = await invoiceService.paymentHistoryForInvoice(invoiceId, companyId);
    return successResponse(res, result, INVOICE_MESSAGES.FETCH_PAYMENT_HISTORY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'paymentHistoryForInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.FETCH_PAYMENT_HISTORY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const generateEWayBillUnified = catchAsync(async (req, res) => {
  try {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const result = await invoiceService.generateEWayBillForInvoice(
      invoiceId,
      req.body.EwbDtls,
      companyId,
      req.user._id,
      req.body.items,
      req.body.updateItemMaster,
    );
    return successResponse(res, result, INVOICE_MESSAGES.GENERATE_ONLY_E_WAY_BILL_SUCCESS, httpStatus.OK);
  } catch (error) {
    const isHsnInclude = error?.data?.invalidHsn || error.message?.toLowerCase()?.includes('hsn');
    const hsnCodes = error?.data?.invalidHsnCodes?.length ? error.data.invalidHsnCodes : error?.message?.match(/\d{4,8}/g) || [];
    return errorResponse(
      { req, error, service: 'generateEWayBillForInvoice', controller: 'invoice' },
      res,
      error?.message || INVOICE_MESSAGES.GENERATE_ONLY_E_WAY_BILL_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      0,
      isHsnInclude ? { isInvalidHsn: true, invalidHsnCodes: hsnCodes } : {},
    );
  }
});

const generateOnlyEWayBill = catchAsync(async (req, res) => {
  try {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const invoice = await invoiceService.generateOnlyEWayBillFromInvoice(
      invoiceId,
      req.body.EwbDtls,
      companyId,
      req.user._id,
      req.body.items,
      req.body.updateItemMaster,
    );
    return successResponse(res, invoice, INVOICE_MESSAGES.GENERATE_ONLY_E_WAY_BILL_SUCCESS, httpStatus.OK);
  } catch (error) {
    const isHsnInclude = error?.data?.invalidHsn || error.message?.toLowerCase()?.includes('hsn');
    const hsnCodes = error?.data?.invalidHsnCodes?.length ? error.data.invalidHsnCodes : error?.message?.match(/\d{4,8}/g) || [];
    return errorResponse(
      { req, error, service: 'generateOnlyEWayBillFromInvoice', controller: 'invoice' },
      res,
      error?.message || INVOICE_MESSAGES.GENERATE_ONLY_E_WAY_BILL_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      0,
      isHsnInclude ? { isInvalidHsn: true, invalidHsnCodes: hsnCodes } : {},
    );
  }
});

const cancelOnlyEWayBill = catchAsync(
  async (req, res) => {
    const { invoiceId } = req.body;
    const { companyId } = req.query;
    const invoice = await invoiceService.cancelOnlyEWayBillFromInvoice(req.body, invoiceId, companyId, req.user._id);
    return successResponse(res, invoice, INVOICE_MESSAGES.CANCEL_E_WAY_BILL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'cancelOnlyEWayBillFromInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.CANCEL_E_WAY_BILL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createSplitInvoice = catchAsync(async (req, res) => {
  try {
    const invoiceBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const uploadedFile = uploadedFiles.length > 0 ? uploadedFiles : null;
    const invoice = await invoiceService.createSplitInvoice(
      { ...invoiceBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFile,
    );
    return successResponse(res, invoice, INVOICE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  } catch (error) {
    return errorResponse(
      { req, error, service: 'createSplitInvoice', controller: 'invoice' },
      res,
      error?.message || INVOICE_MESSAGES.CREATE_FAILURE,
      error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
      error?.code,
      error?.data,
    );
  }
});

const applyCustomerCreditToInvoice = catchAsync(
  async (req, res) => {
    const { applications = [], contextInvoiceId = null } = req.body;
    const { customerId } = req.params;
    const { branchId } = req.query;
    await invoiceService.applyCustomerCreditToInvoice(
      customerId,
      req.query.companyId,
      branchId,
      applications,
      req.user._id,
      contextInvoiceId,
    );
    return successResponse(res, { success: true }, INVOICE_MESSAGES.APPLY_CREDIT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'applyCustomerCreditToInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.APPLY_CREDIT_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const autoMapOpeningBalanceToInvoices = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'customerId', 'branchId', 'isSplit']);
    const payload = await invoiceService.autoMapOpeningBalanceToInvoices(filter);
    return successResponse(res, payload, INVOICE_MESSAGES.AUTO_MAP_OB_SUCCESS, httpStatus.OK);
  },
  {
    service: 'autoMapOpeningBalanceToInvoices',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.AUTO_MAP_OB_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const removeOpeningBalanceApplicationFromInvoice = catchAsync(
  async (req, res) => {
    const { invoiceId, applicationId } = req.params;
    const { companyId } = req.query;
    await invoiceService.removeOpeningBalanceApplicationFromInvoice(invoiceId, companyId, applicationId, req.user._id);
    return successResponse(res, { success: true }, INVOICE_MESSAGES.REMOVE_OB_APPLICATION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'removeOpeningBalanceApplicationFromInvoice',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.REMOVE_OB_APPLICATION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const removeOpeningBalanceApplicationFromOb = catchAsync(
  async (req, res) => {
    const { creditTxnId, applicationId } = req.params;
    const { companyId } = req.query;
    await invoiceService.removeOpeningBalanceApplicationFromOb(creditTxnId, companyId, applicationId);
    return successResponse(res, { success: true }, INVOICE_MESSAGES.REMOVE_OB_APPLICATION_SUCCESS, httpStatus.OK);
  },
  {
    service: 'removeOpeningBalanceApplicationFromOb',
    controller: 'invoice',
    failureMessage: INVOICE_MESSAGES.REMOVE_OB_APPLICATION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getStockMovement = catchAsync(async (req, res) => {
  const result = await getDocumentStockMovements({
    companyId: req.query.companyId,
    sourceId: req.params.invoiceId,
    documentType: STOCK_MOVEMENT_DOCUMENT_TYPE.INVOICE,
  });
  return successResponse(res, result, 'Stock movement fetched successfully', httpStatus.OK);
});

module.exports = {
  createInvoice,
  getStockMovement,
  getInvoices,
  getInvoicesExports,
  getCustomerWisePendingInvoices,
  getInvoice,
  updateInvoice,
  deleteInvoice,
  getPendingInvoices,
  getInvoicesDropdown,
  updateInvoiceStatus,
  generateEInvoice,
  getGstDocumentOptions,
  generateFynamicsEInvoice,
  refetchEInvoice,
  generateEWayBill,
  cancelEInvoice,
  cancelEWayBill,
  paymentHistoryForInvoice,
  generateOnlyEWayBill,
  generateEWayBillUnified,
  cancelOnlyEWayBill,
  createSplitInvoice,
  applyCustomerCreditToInvoice,
  autoMapOpeningBalanceToInvoices,
  removeOpeningBalanceApplicationFromInvoice,
  removeOpeningBalanceApplicationFromOb,
};
