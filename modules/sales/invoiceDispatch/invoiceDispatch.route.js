const express = require('express');
const invoiceDispatchValidation = require('./invoiceDispatch.validation');
const invoiceDispatchController = require('./invoiceDispatch.controller');
const validate = require('../../../middlewares/validate');
const { multerErrorHandler, multipleAttachmentUploadFields } = require('../../../middlewares/uploadMiddleware');
const parseFormData = require('../../../middlewares/parseFormData');
const { ATTACHMENT_MAX_COUNT, ATTACHMENT_ONE_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUploadFields([
  { name: 'bookingCopyImage', maxCount: ATTACHMENT_ONE_COUNT },
  { name: 'truck_goodsImage', maxCount: ATTACHMENT_MAX_COUNT },
  { name: 'vehicle_goodsImage', maxCount: ATTACHMENT_MAX_COUNT },
]);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(invoiceDispatchValidation.createInvoiceDispatch),
    invoiceDispatchController.createInvoiceDispatch,
  );

router
  .route('/:id')
  .get(validate(invoiceDispatchValidation.getDispatch), invoiceDispatchController.getDispatch)
  .patch(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(invoiceDispatchValidation.updateInvoiceDispatch),
    invoiceDispatchController.updateInvoiceDispatch,
  )
  .delete(validate(invoiceDispatchValidation.deleteInvoiceDispatch), invoiceDispatchController.deleteInvoiceDispatch);

module.exports = router;
