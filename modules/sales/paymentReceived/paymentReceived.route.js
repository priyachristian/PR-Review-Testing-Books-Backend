const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const paymentReceivedValidation = require('./paymentReceived.validation');
const paymentReceivedController = require('./paymentReceived.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.PAYMENT_RECEIVED),
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.CREATE),
    validate(paymentReceivedValidation.createPaymentReceived),
    paymentReceivedController.createPaymentReceived,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.VIEW),
    validate(paymentReceivedValidation.getPayments),
    paymentReceivedController.getPayments,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.VIEW),
    validate(paymentReceivedValidation.getPaymentsExports),
    paymentReceivedController.getPaymentsExports,
  );

router
  .route('/:paymentReceivedId')
  .get(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.VIEW),
    validate(paymentReceivedValidation.getPayment),
    paymentReceivedController.getPayment,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.DELETE),
    validate(paymentReceivedValidation.deletePayment),
    paymentReceivedController.deletePayment,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(paymentReceivedValidation.updatePaymentReceived),
    paymentReceivedController.updatePaymentReceived,
  );

router
  .route('/approve/:paymentReceivedId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.approveStatus),
    paymentReceivedController.approvePaymentReceived,
  );

router
  .route('/reject/:paymentReceivedId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.rejectStatus),
    paymentReceivedController.rejectPaymentReceived,
  );

router
  .route('/cancel/:paymentReceivedId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.cancelStatus),
    paymentReceivedController.cancelPaymentReceived,
  );

router
  .route('/deleteInvoice/:paymentReceivedId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.DELETE),
    validate(paymentReceivedValidation.deletePaymentReceiveInvoice),
    paymentReceivedController.deletePaymentReceiveInvoice,
  );

router
  .route('/:paymentReceivedId/apply')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.applyAdvancePaymentReceivedAgainstInvoice),
    paymentReceivedController.applyAdvancePaymentReceivedAgainstInvoice,
  );

router
  .route('/:paymentReceivedId/deletePaymentReceivedInvoice')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.removeAdvancePaymentReceivedAgainstInvoice),
    paymentReceivedController.removeAdvancePaymentReceivedAgainstInvoice,
  );

router
  .route('/auto-apply')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.autoApplyPendingAdvancePayments),
    paymentReceivedController.autoApplyPendingAdvancePayments,
  );

router
  .route('/refund')
  .post(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.addRefund),
    paymentReceivedController.addRefund,
  );

router
  .route('/refund/:paymentReceivedId')
  .patch(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.updateRefund),
    paymentReceivedController.updateRefund,
  );

router
  .route('/refund/:paymentReceivedId/:refundId')
  .delete(
    checkRoleRight(RIGHT_LIST.PAYMENT_RECEIVED, RIGHTS.EDIT),
    validate(paymentReceivedValidation.deleteRefund),
    paymentReceivedController.deleteRefund,
  );

module.exports = router;
