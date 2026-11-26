const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const purchaseOrderValidator = require('./purchaseOrder.validation');
const purchaseOrderController = require('./purchaseOrder.controller');
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
    checkSubscription(PLAN_FEATURES.PURCHASE_ORDER),
    checkRoleRight(RIGHT_LIST.PURCHASE_ORDER, RIGHTS.CREATE),
    validate(purchaseOrderValidator.createPurchaseOrder),
    validateDocumentTotals,
    purchaseOrderController.createPurchaseOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PURCHASE_ORDER, RIGHTS.VIEW),
    validate(purchaseOrderValidator.getPurchaseOrderValidation),
    purchaseOrderController.getAllPurchaseOrders,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.PURCHASE_ORDER, RIGHTS.VIEW),
    validate(purchaseOrderValidator.getPurchaseOrdersExports),
    purchaseOrderController.getPurchaseOrdersExports,
  );

router
  .route('/dropdown')
  .get(validate(purchaseOrderValidator.getPurchaseOrderConvertDropdown), purchaseOrderController.getPurchaseOrderConvertDropdown);

router
  .route('/partiallyConvertedItemList')
  .get(validate(purchaseOrderValidator.partiallyConvertedItemList), purchaseOrderController.partiallyConvertedItemList);

router
  .route('/:id')
  .delete(
    checkRoleRight(RIGHT_LIST.PURCHASE_ORDER, RIGHTS.DELETE),
    validate(purchaseOrderValidator.deletePurchaseOrder),
    purchaseOrderController.deletePurchaseOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PURCHASE_ORDER, RIGHTS.VIEW),
    validate(purchaseOrderValidator.getPurchaseOrder),
    purchaseOrderController.getPurchaseOrder,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.PURCHASE_ORDER, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(purchaseOrderValidator.updatePurchaseOrder),
    validateDocumentTotals,
    purchaseOrderController.updatePurchaseOrder,
  );

router
  .route('/:purchaseOrderId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.PURCHASE_ORDER, RIGHTS.EDIT),
    validate(purchaseOrderValidator.updatePurchaseOrderStatus),
    purchaseOrderController.updatePurchaseOrderStatus,
  );

module.exports = router;
