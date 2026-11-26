const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const paymentMadeValidation = require('./paymentMade.validations');
const paymentMadeController = require('./paymentMade.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.PAYMENT_MADE),
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.CREATE),
    validate(paymentMadeValidation.createPaymentMade),
    paymentMadeController.createPaymentMade,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.VIEW),
    validate(paymentMadeValidation.getPaymentMades),
    paymentMadeController.getPaymentMades,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.VIEW),
    validate(paymentMadeValidation.getPaymentMadesExports),
    paymentMadeController.getPaymentMadesExports,
  );

router
  .route('/:paymentMadeId')
  .get(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.VIEW),
    validate(paymentMadeValidation.getPaymentMade),
    paymentMadeController.getPaymentMade,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.DELETE),
    validate(paymentMadeValidation.deletePaymentMade),
    paymentMadeController.deletePaymentMade,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(paymentMadeValidation.updatePaymentMade),
    paymentMadeController.updatePaymentMade,
  );

router
  .route('/approve/:paymentMadeId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(paymentMadeValidation.approveStatus),
    paymentMadeController.approvePaymentMade,
  );

router
  .route('/reject/:paymentMadeId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(paymentMadeValidation.rejectStatus),
    paymentMadeController.rejectPaymentMade,
  );

router
  .route('/cancel/:paymentMadeId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.cancelStatus),
    paymentMadeController.cancelPaymentMade,
  );

router
  .route('/deleteBill/:paymentMadeId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.deletePaymentMadeBill),
    paymentMadeController.deletePaymentMadeBill,
  );

router
  .route('/:paymentMadeId/apply')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.applyAdvancePaymentMadeAgainstBill),
    paymentMadeController.applyAdvancePaymentMadeAgainstBill,
  );

router
  .route('/:paymentMadeId/deletePaymentMadeBill')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.removeAdvancePaymentMadeAgainstBill),
    paymentMadeController.removeAdvancePaymentMadeAgainstBill,
  );

router
  .route('/auto-apply')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.autoApplyPendingAdvancePaymentMade),
    paymentMadeController.autoApplyPendingAdvancePaymentMade,
  );

router
  .route('/refund')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.addRefund),
    paymentMadeController.addRefund,
  );

router
  .route('/refund/:paymentMadeId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.updateRefund),
    paymentMadeController.updateRefund,
  );

router
  .route('/refund/:paymentMadeId/:refundId')
  .delete(
    checkRoleRight(RIGHT_LIST.PAYMENT_MADE, RIGHTS.EDIT),
    validate(paymentMadeValidation.deleteRefund),
    paymentMadeController.deleteRefund,
  );

module.exports = router;
