const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const invoiceValidation = require('./invoice.validation');
const invoiceController = require('./invoice.controller');
const validate = require('../../../middlewares/validate');
const { checkEWayBillSubscription } = require('../../../middlewares/checkEWayBillSubscription');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { checkPrimaryBank } = require('../../../middlewares/checkPrimaryBank');
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
    checkSubscription(PLAN_FEATURES.INVOICE),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.CREATE),
    checkPrimaryBank,
    validate(invoiceValidation.createInvoice),
    validateDocumentTotals,
    invoiceController.createInvoice,
  )
  .get(checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.VIEW), validate(invoiceValidation.getInvoices), invoiceController.getInvoices);

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.VIEW),
    validate(invoiceValidation.getInvoicesExports),
    invoiceController.getInvoicesExports,
  );

router
  .route('/splitInvoice')
  .post(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.CREATE),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(invoiceValidation.createSplitInvoice),
    validateDocumentTotals,
    invoiceController.createSplitInvoice,
  );

router
  .route('/payment-history/:invoiceId')
  .get(validate(invoiceValidation.getPaymentHistoryForInvoice), invoiceController.paymentHistoryForInvoice);

router
  .route('/opening-balance-applications/:invoiceId/:applicationId')
  .delete(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.removeOpeningBalanceApplicationFromInvoice),
    invoiceController.removeOpeningBalanceApplicationFromInvoice,
  );

router
  .route('/opening-balance-ob-applications/:creditTxnId/:applicationId')
  .delete(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.removeOpeningBalanceApplicationFromOb),
    invoiceController.removeOpeningBalanceApplicationFromOb,
  );

router.route('/pending').get(validate(invoiceValidation.getPendingInvoices), invoiceController.getPendingInvoices);

router.route('/dropdown').get(validate(invoiceValidation.getInvoicesDropdown), invoiceController.getInvoicesDropdown);

router
  .route('/customer/:customerId/pending')
  .get(validate(invoiceValidation.getCustomerWisePendingInvoices), invoiceController.getCustomerWisePendingInvoices);

router
  .route('/customer/:customerId/apply-credit')
  .post(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.applyCustomerCreditToInvoice),
    invoiceController.applyCustomerCreditToInvoice,
  );

router
  .route('/ob-credit-map')
  .post(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.autoMapOpeningBalanceToInvoices),
    invoiceController.autoMapOpeningBalanceToInvoices,
  );

router
  .route('/einvoice')
  .post(
    checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.CREATE),
    validate(invoiceValidation.generateEInvoice),
    invoiceController.generateEInvoice,
  );
router
  .route('/einvoice/fynamics')
  .post(
    checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.CREATE),
    validate(invoiceValidation.generateEInvoice),
    invoiceController.generateFynamicsEInvoice,
  );
router
  .route('/ewaybill')
  .post(
    checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.CREATE),
    validate(invoiceValidation.generateEInvoice),
    invoiceController.generateEWayBill,
  );
router
  .route('/:invoiceId/gst-document-options')
  .get(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.VIEW),
    validate(invoiceValidation.getGstDocumentOptions),
    invoiceController.getGstDocumentOptions,
  );
router
  .route('/einvoice/refetch')
  .post(
    checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.refetchEInvoiceOrEWayBill),
    invoiceController.refetchEInvoice,
  );
router
  .route('/einvoice/cancel')
  .post(
    checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.cancelEInvoice),
    invoiceController.cancelEInvoice,
  );
router
  .route('/ewaybill/cancel')
  .post(
    checkEWayBillSubscription(),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.cancelOnlyEWayBill),
    invoiceController.cancelEWayBill,
  );
router
  .route('/ewaybill/generate')
  .post(
    checkEWayBillSubscription(),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.CREATE),
    validate(invoiceValidation.generateOnlyEWayBill),
    invoiceController.generateEWayBillUnified,
  );
router
  .route('/only-ewaybill/')
  .post(
    checkSubscription(PLAN_FEATURES.ONLY_E_WAY_BILL),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.CREATE),
    validate(invoiceValidation.generateOnlyEWayBill),
    invoiceController.generateOnlyEWayBill,
  );
router
  .route('/only-ewaybill/cancel')
  .post(
    checkSubscription(PLAN_FEATURES.ONLY_E_WAY_BILL),
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.cancelOnlyEWayBill),
    invoiceController.cancelOnlyEWayBill,
  );

router
  .route('/:invoiceId')
  .get(checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.VIEW), validate(invoiceValidation.getInvoice), invoiceController.getInvoice)
  .delete(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.DELETE),
    validate(invoiceValidation.deleteInvoice),
    invoiceController.deleteInvoice,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(invoiceValidation.updateInvoice),
    validateDocumentTotals,
    invoiceController.updateInvoice,
  );

router
  .route('/:invoiceId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.EDIT),
    validate(invoiceValidation.updateInvoiceStatus),
    invoiceController.updateInvoiceStatus,
  );

router
  .route('/:invoiceId/stock-movement')
  .get(checkRoleRight(RIGHT_LIST.INVOICES, RIGHTS.VIEW), invoiceController.getStockMovement);

module.exports = router;
