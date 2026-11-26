const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const rejectionOrderValidation = require('./rejectionOrder.validation');
const rejectionOrderController = require('./rejectionOrder.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', 1);

router
  .route('/inventory-summary')
  .get(
    checkRoleRight(RIGHT_LIST.REJECTION_INVENTORY, RIGHTS.VIEW),
    validate(rejectionOrderValidation.getInventorySummary),
    rejectionOrderController.getInventorySummary,
  );

router
  .route('/analysis-summary')
  .get(
    checkRoleRight(RIGHT_LIST.REJECTION_ANALYSIS, RIGHTS.VIEW),
    validate(rejectionOrderValidation.getAnalysisSummary),
    rejectionOrderController.getAnalysisSummary,
  );

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.CREATE),
    checkSubscription(PLAN_FEATURES.REJECTION_ORDER),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(rejectionOrderValidation.createRejectionOrder),
    rejectionOrderController.createRejectionOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.VIEW),
    validate(rejectionOrderValidation.getRejectionOrders),
    rejectionOrderController.getRejectionOrders,
  );

router
  .route('/invoice-dropdown')
  .get(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.VIEW),
    validate(rejectionOrderValidation.getInvoiceDropdown),
    rejectionOrderController.getInvoiceDropdown,
  );

router
  .route('/:rejectionOrderId')
  .get(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.VIEW),
    validate(rejectionOrderValidation.getRejectionOrder),
    rejectionOrderController.getRejectionOrder,
  )
  .put(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(rejectionOrderValidation.updateRejectionBooking),
    rejectionOrderController.updateRejectionBooking,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.EDIT),
    validate(rejectionOrderValidation.saveRejectionWorkflow),
    rejectionOrderController.saveRejectionWorkflow,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.DELETE),
    validate(rejectionOrderValidation.deleteRejectionOrder),
    rejectionOrderController.deleteRejectionOrder,
  );

router
  .route('/:rejectionOrderId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.EDIT),
    validate(rejectionOrderValidation.updateRejectionOrderStatus),
    rejectionOrderController.updateRejectionOrderStatus,
  );

router
  .route('/:rejectionOrderId/recovery-bom')
  .get(
    checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.VIEW),
    validate(rejectionOrderValidation.getRecoveryBom),
    rejectionOrderController.getRecoveryBom,
  );

router
  .route('/:rejectionOrderId/stock-movement')
  .get(checkRoleRight(RIGHT_LIST.BOOK_REJECTION, RIGHTS.VIEW), rejectionOrderController.getStockMovement);

module.exports = router;
