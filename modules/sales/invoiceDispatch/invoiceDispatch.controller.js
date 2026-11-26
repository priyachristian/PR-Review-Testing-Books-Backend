const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const invoiceDispatchService = require('./invoiceDispatch.service');
const { INVOICE_DISPATCH_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');
const { getUploadedFiles } = require('../../../utils/fileUploadHelper');

const createInvoiceDispatch = catchAsync(
  async (req, res) => {
    const bookingCopyImage = getUploadedFiles(req, 'bookingCopyImage');
    const truck_goodsImage = getUploadedFiles(req, 'truck_goodsImage');
    const vehicle_goodsImage = getUploadedFiles(req, 'vehicle_goodsImage');
    const invoiceDispatch = await invoiceDispatchService.createInvoiceDispatch(
      req.body,
      req.query.companyId,
      req.user._id,
      bookingCopyImage,
      truck_goodsImage,
      vehicle_goodsImage,
    );
    return successResponse(res, invoiceDispatch, INVOICE_DISPATCH_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createInvoiceDispatch',
    controller: 'invoiceDispatch',
    failureMessage: INVOICE_DISPATCH_MESSAGES.FAILED_TO_CREATE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDispatch = catchAsync(
  async (req, res) => {
    const dispatch = await invoiceDispatchService.getDispatchById(req.params.id, req.query.companyId);
    return successResponse(res, dispatch, INVOICE_DISPATCH_MESSAGES.FETCH_DISPATCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getDispatchById',
    controller: 'invoiceDispatch',
    failureMessage: INVOICE_DISPATCH_MESSAGES.FETCH_DISPATCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateInvoiceDispatch = catchAsync(
  async (req, res) => {
    const bookingCopyImage = getUploadedFiles(req, 'bookingCopyImage');
    const truck_goodsImage = getUploadedFiles(req, 'truck_goodsImage');
    const vehicle_goodsImage = getUploadedFiles(req, 'vehicle_goodsImage');
    const updatedDispatch = await invoiceDispatchService.updateInvoiceDispatchById(
      req.params.id,
      req.body,
      req.user._id,
      req.query.companyId,
      bookingCopyImage,
      truck_goodsImage,
      vehicle_goodsImage,
    );
    return successResponse(res, updatedDispatch, INVOICE_DISPATCH_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateInvoiceDispatchById',
    controller: 'invoiceDispatch',
    failureMessage: INVOICE_DISPATCH_MESSAGES.FAILED_TO_UPDATE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteInvoiceDispatch = catchAsync(
  async (req, res) => {
    await invoiceDispatchService.deleteInvoiceDispatch(req.params.id, req.query.companyId, req.user._id);
    return successResponse(res, {}, INVOICE_DISPATCH_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteInvoiceDispatch',
    controller: 'invoiceDispatch',
    failureMessage: INVOICE_DISPATCH_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createInvoiceDispatch,
  getDispatch,
  updateInvoiceDispatch,
  deleteInvoiceDispatch,
};
