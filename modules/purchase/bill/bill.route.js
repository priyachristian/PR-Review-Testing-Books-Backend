const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const billValidation = require('./bill.validation');
const billController = require('./bill.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.BILL),
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.CREATE),
    validate(billValidation.createBill),
    validateDocumentTotals,
    billController.createBill,
  )
  .get(checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.VIEW), validate(billValidation.getBills), billController.getBills);

router
  .route('/exports')
  .get(checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.VIEW), validate(billValidation.getBillsExports), billController.getBillsExports);

router
  .route('/splitBill')
  .post(
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.CREATE),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(billValidation.createSplitBill),
    billController.createSplitBill,
  );

router
  .route('/payment-history/:billId')
  .get(validate(billValidation.getPaymentHistoryForBill), billController.paymentHistoryForBill);

router
  .route('/opening-balance-applications/:billId/:applicationId')
  .delete(
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.EDIT),
    validate(billValidation.removeOpeningBalanceApplicationFromBill),
    billController.removeOpeningBalanceApplicationFromBill,
  );

router
  .route('/opening-balance-ob-applications/:creditTxnId/:applicationId')
  .delete(
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.EDIT),
    validate(billValidation.removeOpeningBalanceApplicationFromOb),
    billController.removeOpeningBalanceApplicationFromOb,
  );

router.get('/pending', validate(billValidation.getPendingBills), billController.getPendingBills);

router.get('/dropdown', validate(billValidation.getBillsDropdown), billController.getBillsDropdown);

router.get('/exportBill', validate(billValidation.getBills), billController.exportBills);

router
  .route('/vendor/:vendorId/pending')
  .get(validate(billValidation.getVendorWisePendingBills), billController.getVendorWisePendingBills);

router
  .route('/vendor/:vendorId/apply-credit')
  .post(
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.EDIT),
    validate(billValidation.applyVendorCreditToBill),
    billController.applyVendorCreditToBill,
  );

router
  .route('/ob-credit-map')
  .post(
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.EDIT),
    validate(billValidation.autoMapOpeningBalanceToBills),
    billController.autoMapOpeningBalanceToBills,
  );

router
  .route('/:billId')
  .get(checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.VIEW), validate(billValidation.getBill), billController.getBill)
  .delete(checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.DELETE), validate(billValidation.deleteBill), billController.deleteBill)
  .patch(
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(billValidation.updateBill),
    validateDocumentTotals,
    billController.updateBill,
  );

router
  .route('/:billId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.EDIT),
    validate(billValidation.updateBillStatus),
    billController.updateBillStatus,
  );

router.route('/:billId/stock-movement').get(checkRoleRight(RIGHT_LIST.BILLS, RIGHTS.VIEW), billController.getStockMovement);

module.exports = router;
