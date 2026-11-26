const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { checkEWayBillSubscription } = require('../../../middlewares/checkEWayBillSubscription');
const { RIGHTS } = require('../../../utils/enum');
const gstDocumentGenerationValidation = require('./gstDocumentGeneration.validation');
const { buildGstDocumentController } = require('./gstDocumentGeneration.controller');

/**
 * Adds the e-invoice and e-way bill routes of a document module to its router.
 * `type` is a GST_DOCUMENT_TYPES config and `rightKey` the module's RIGHT_LIST key.
 * E-invoice routes are added only for types that can have an e-invoice.
 */
const registerGstDocumentRoutes = (router, { type, rightKey }) => {
  const controller = buildGstDocumentController(type);

  if (type.nicDocType) {
    router
      .route('/:documentId/einvoice')
      .post(
        checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL),
        checkRoleRight(rightKey, RIGHTS.CREATE),
        validate(gstDocumentGenerationValidation.generateEInvoice),
        controller.generateEInvoice,
      );
    router
      .route('/:documentId/einvoice/cancel')
      .post(
        checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL),
        checkRoleRight(rightKey, RIGHTS.EDIT),
        validate(gstDocumentGenerationValidation.cancel),
        controller.cancelEInvoice,
      );
  }

  router
    .route('/:documentId/ewaybill')
    .post(
      checkEWayBillSubscription(),
      checkRoleRight(rightKey, RIGHTS.CREATE),
      validate(gstDocumentGenerationValidation.generateEWayBill),
      controller.generateEWayBill,
    );
  router
    .route('/:documentId/ewaybill/cancel')
    .post(
      checkEWayBillSubscription(),
      checkRoleRight(rightKey, RIGHTS.EDIT),
      validate(gstDocumentGenerationValidation.cancel),
      controller.cancelEWayBill,
    );
  router
    .route('/:documentId/gst-document-options')
    .get(checkRoleRight(rightKey, RIGHTS.VIEW), validate(gstDocumentGenerationValidation.getOptions), controller.getOptions);
};

module.exports = { registerGstDocumentRoutes };
