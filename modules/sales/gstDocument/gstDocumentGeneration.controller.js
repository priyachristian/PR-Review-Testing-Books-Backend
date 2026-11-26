const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const { successResponse, errorResponse } = require('../../../services/response.service');
const { INVOICE_MESSAGES } = require('../../../utils/messages');
const gstDocumentGenerationService = require('./gstDocumentGeneration.service');

const CONTROLLER_NAME = 'gstDocumentGeneration';

// The generate modal highlights invalid HSN rows from this shape, same as the invoice endpoints return.
const sendGenerationError = ({ req, res, error, service, fallbackMessage }) => {
  const isHsnError = error?.data?.invalidHsn || error?.message?.toLowerCase()?.includes('hsn');
  const invalidHsnCodes = error?.data?.invalidHsnCodes?.length
    ? error.data.invalidHsnCodes
    : error?.message?.match(/\b\d{4,8}\b/g) || [];
  return errorResponse(
    { req, error, service, controller: CONTROLLER_NAME },
    res,
    error?.message || fallbackMessage,
    error?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
    0,
    isHsnError ? { isInvalidHsn: true, invalidHsnCodes } : {},
  );
};

const requestContext = (req, type) => ({
  type,
  documentId: req.params.documentId,
  companyId: req.query.companyId,
  userId: req.user._id,
});

/** Controllers for one document type (a GST_DOCUMENT_TYPES config). */
const buildGstDocumentController = type => ({
  generateEInvoice: catchAsync(async (req, res) => {
    try {
      const result = await gstDocumentGenerationService.generateEInvoice({
        ...requestContext(req, type),
        eInvoiceOptions: req.body.EInvDtls,
        items: req.body.items,
        updateItemMaster: req.body.updateItemMaster,
      });
      return successResponse(res, result, INVOICE_MESSAGES.GENERATE_E_INVOICE_SUCCESS, httpStatus.OK);
    } catch (error) {
      return sendGenerationError({
        req,
        res,
        error,
        service: 'generateEInvoice',
        fallbackMessage: INVOICE_MESSAGES.GENERATE_E_INVOICE_FAILURE,
      });
    }
  }),

  generateEWayBill: catchAsync(async (req, res) => {
    try {
      const result = await gstDocumentGenerationService.generateEWayBill({
        ...requestContext(req, type),
        ewbDtls: req.body.EwbDtls,
        items: req.body.items,
        updateItemMaster: req.body.updateItemMaster,
      });
      return successResponse(res, result, INVOICE_MESSAGES.GENERATE_ONLY_E_WAY_BILL_SUCCESS, httpStatus.OK);
    } catch (error) {
      return sendGenerationError({
        req,
        res,
        error,
        service: 'generateEWayBill',
        fallbackMessage: INVOICE_MESSAGES.GENERATE_ONLY_E_WAY_BILL_FAILURE,
      });
    }
  }),

  cancelEInvoice: catchAsync(
    async (req, res) => {
      const result = await gstDocumentGenerationService.cancelEInvoice({
        ...requestContext(req, type),
        cancellationDetails: req.body,
      });
      return successResponse(res, result, INVOICE_MESSAGES.CANCEL_E_INVOICE_SUCCESS, httpStatus.OK);
    },
    {
      service: 'cancelEInvoice',
      controller: CONTROLLER_NAME,
      failureMessage: INVOICE_MESSAGES.CANCEL_E_INVOICE_FAILURE,
      failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
    },
  ),

  cancelEWayBill: catchAsync(
    async (req, res) => {
      const result = await gstDocumentGenerationService.cancelEWayBill({
        ...requestContext(req, type),
        cancellationDetails: req.body,
      });
      return successResponse(res, result, INVOICE_MESSAGES.CANCEL_E_WAY_BILL_SUCCESS, httpStatus.OK);
    },
    {
      service: 'cancelEWayBill',
      controller: CONTROLLER_NAME,
      failureMessage: INVOICE_MESSAGES.CANCEL_E_WAY_BILL_FAILURE,
      failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
    },
  ),

  getOptions: catchAsync(
    async (req, res) => {
      const { type: documentType, documentId, companyId } = requestContext(req, type);
      const result = await gstDocumentGenerationService.getOptions({ type: documentType, documentId, companyId });
      return successResponse(res, result, INVOICE_MESSAGES.FETCH_GST_DOCUMENT_OPTIONS_SUCCESS, httpStatus.OK);
    },
    {
      service: 'getOptions',
      controller: CONTROLLER_NAME,
      failureMessage: INVOICE_MESSAGES.FETCH_GST_DOCUMENT_OPTIONS_FAILURE,
      failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
    },
  ),
});

module.exports = { buildGstDocumentController };
