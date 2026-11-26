const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const debitNoteValidation = require('./debitNote.validation');
const debitNoteController = require('./debitNote.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT, GST_DOCUMENT_TYPES } = require('../../../utils/enum');
const { registerGstDocumentRoutes } = require('../../sales/gstDocument/gstDocumentGeneration.route');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.DEBIT_NOTES),
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.CREATE),
    validate(debitNoteValidation.createDebitNote),
    validateDocumentTotals,
    debitNoteController.createDebitNote,
  )
  .get(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.VIEW),
    validate(debitNoteValidation.getDebitNotes),
    debitNoteController.getDebitNotes,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.VIEW),
    validate(debitNoteValidation.getDebitNotesExports),
    debitNoteController.getDebitNotesExports,
  );

router
  .route('/:id')
  .get(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.VIEW),
    validate(debitNoteValidation.getDebitNoteById),
    debitNoteController.getDebitNoteById,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.DELETE),
    validate(debitNoteValidation.deleteDebitNote),
    debitNoteController.deleteDebitNote,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(debitNoteValidation.updateDebitNote),
    validateDocumentTotals,
    debitNoteController.updateDebitNote,
  );

router
  .route('/:debitNoteId/apply')
  .post(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.EDIT),
    validate(debitNoteValidation.applyDebitNote),
    debitNoteController.applyDebitNote,
  );

router
  .route('/:debitNoteId/deleteBillsApplied')
  .patch(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.EDIT),
    validate(debitNoteValidation.deleteDebitNoteBill),
    debitNoteController.deleteDebitNoteBill,
  );

router
  .route('/:debitNoteId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.EDIT),
    validate(debitNoteValidation.updateDebitNoteNoteStatus),
    debitNoteController.updateDebitNoteNoteStatus,
  );

router
  .route('/:debitNoteId/refund')
  .post(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.EDIT),
    validate(debitNoteValidation.createDebitNoteRefund),
    debitNoteController.createDebitNoteRefund,
  );

router
  .route('/:debitNoteId/deleteRefund')
  .patch(
    checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.EDIT),
    validate(debitNoteValidation.deleteDebitNoteRefund),
    debitNoteController.deleteDebitNoteRefund,
  );

router.route('/:id/stock-movement').get(checkRoleRight(RIGHT_LIST.DEBIT_NOTE, RIGHTS.VIEW), debitNoteController.getStockMovement);

// E-way bill for goods returned to the vendor
registerGstDocumentRoutes(router, { type: GST_DOCUMENT_TYPES.DEBIT_NOTE, rightKey: RIGHT_LIST.DEBIT_NOTE });

module.exports = router;
