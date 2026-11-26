const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const creditNoteValidation = require('./creditNote.validation');
const creditNoteController = require('./creditNote.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { checkPrimaryBank } = require('../../../middlewares/checkPrimaryBank');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT, GST_DOCUMENT_TYPES } = require('../../../utils/enum');
const { registerGstDocumentRoutes } = require('../gstDocument/gstDocumentGeneration.route');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.CREDIT_NOTES),
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.CREATE),
    checkPrimaryBank,
    validate(creditNoteValidation.createCreditNote),
    validateDocumentTotals,
    creditNoteController.createCreditNote,
  )
  .get(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.VIEW),
    validate(creditNoteValidation.getCreditNotes),
    creditNoteController.getCreditNotes,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.VIEW),
    validate(creditNoteValidation.getCreditNotesExports),
    creditNoteController.getCreditNotesExports,
  );

router
  .route('/:creditNoteId')
  .get(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.VIEW),
    validate(creditNoteValidation.getCreditNote),
    creditNoteController.getCreditNote,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.DELETE),
    validate(creditNoteValidation.deleteCreditNote),
    creditNoteController.deleteCreditNote,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(creditNoteValidation.updateCreditNote),
    validateDocumentTotals,
    creditNoteController.updateCreditNote,
  );

router
  .route('/:creditNoteId/apply')
  .post(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.EDIT),
    validate(creditNoteValidation.applyCreditNote),
    creditNoteController.applyCreditNote,
  );

router
  .route('/:creditNoteId/deleteCreditNoteInvoice')
  .patch(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.EDIT),
    validate(creditNoteValidation.deleteCreditNoteInvoice),
    creditNoteController.deleteCreditNoteInvoice,
  );

router
  .route('/:creditNoteId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.EDIT),
    validate(creditNoteValidation.updateCreditNoteStatus),
    creditNoteController.updateCreditNoteStatus,
  );

router
  .route('/:creditNoteId/refund')
  .post(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.EDIT),
    validate(creditNoteValidation.createCreditNoteRefund),
    creditNoteController.createCreditNoteRefund,
  );

router
  .route('/:creditNoteId/deleteRefund')
  .patch(
    checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.EDIT),
    validate(creditNoteValidation.deleteCreditNoteRefund),
    creditNoteController.deleteCreditNoteRefund,
  );

router
  .route('/:creditNoteId/stock-movement')
  .get(checkRoleRight(RIGHT_LIST.CREDIT_NOTES, RIGHTS.VIEW), creditNoteController.getStockMovement);

// E-invoice (credit note) and e-way bill (sales return)
registerGstDocumentRoutes(router, { type: GST_DOCUMENT_TYPES.CREDIT_NOTE, rightKey: RIGHT_LIST.CREDIT_NOTES });

module.exports = router;
