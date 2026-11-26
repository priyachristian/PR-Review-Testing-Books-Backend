const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const grpoOrderValidator = require('./grpoOrder.validation');
const grpoOrderController = require('./grpoOrder.controller');
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
    checkSubscription(PLAN_FEATURES.GRPO),
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.CREATE),
    validate(grpoOrderValidator.createGrpoOrder),
    validateDocumentTotals,
    grpoOrderController.createGrpoOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.VIEW),
    validate(grpoOrderValidator.getGrpoOrder),
    grpoOrderController.getAllGrpoOrders,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.VIEW),
    validate(grpoOrderValidator.getGrpoOrdersExports),
    grpoOrderController.getGrpoOrdersExports,
  );

router
  .route('/from-purchase-order')
  .get(
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.VIEW),
    validate(grpoOrderValidator.grpofromPurchaseOrder),
    grpoOrderController.grpofromPurchaseOrder,
  );

router
  .route('/items')
  .get(checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.VIEW), validate(grpoOrderValidator.grpoItems), grpoOrderController.grpoItems);

router
  .route('/:id')
  .delete(
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.DELETE),
    validate(grpoOrderValidator.deleteGrpoOrder),
    grpoOrderController.deleteGrpoOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.VIEW),
    validate(grpoOrderValidator.getGrpoOrderById),
    grpoOrderController.getGrpoOrder,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(grpoOrderValidator.updateGrpoOrder),
    validateDocumentTotals,
    grpoOrderController.updateGrpoOrder,
  );

router
  .route('/:grpoOrderId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.EDIT),
    validate(grpoOrderValidator.updateGrpoOrderStatus),
    grpoOrderController.updateGrpoOrderStatus,
  );

router.route('/:id/stock-movement').get(checkRoleRight(RIGHT_LIST.GRPO, RIGHTS.VIEW), grpoOrderController.getStockMovement);

module.exports = router;
