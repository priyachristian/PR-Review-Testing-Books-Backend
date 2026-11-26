const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const deliveryChallanValidation = require('./deliveryChallan.validation');
const deliveryChallanController = require('./deliveryChallan.controller');
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

// Multer middleware for handling file uploads - supports multiple files with field name 'attachment'
const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.DELIVERY_CHALLAN),
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.CREATE),
    checkPrimaryBank,
    validate(deliveryChallanValidation.createDeliveryChallan),
    validateDocumentTotals,
    deliveryChallanController.createDeliveryChallan,
  )
  .get(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.VIEW),
    validate(deliveryChallanValidation.getDeliveryChallans),
    deliveryChallanController.getDeliveryChallans,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.VIEW),
    validate(deliveryChallanValidation.getDeliveryChallansExports),
    deliveryChallanController.getDeliveryChallansExports,
  );

router
  .route('/fromSalesOrder')
  .get(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.VIEW),
    validate(deliveryChallanValidation.deliveryChallanfromSalesOrder),
    deliveryChallanController.deliveryChallanfromSalesOrder,
  );

router
  .route('/items')
  .get(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.VIEW),
    validate(deliveryChallanValidation.deliveryChallanItems),
    deliveryChallanController.deliveryChallanItems,
  );

router
  .route('/:challanId')
  .get(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.VIEW),
    validate(deliveryChallanValidation.getDeliveryChallan),
    deliveryChallanController.getDeliveryChallan,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.DELETE),
    validate(deliveryChallanValidation.deleteDeliveryChallan),
    deliveryChallanController.deleteDeliveryChallan,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(deliveryChallanValidation.updateDeliveryChallan),
    validateDocumentTotals,
    deliveryChallanController.updateDeliveryChallan,
  );

router
  .route('/:challanId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.EDIT),
    validate(deliveryChallanValidation.updateDeliveryChallanStatus),
    deliveryChallanController.updateDeliveryChallanStatus,
  );

router
  .route('/:challanId/stock-movement')
  .get(checkRoleRight(RIGHT_LIST.DELIVERY_CHALLANS, RIGHTS.VIEW), deliveryChallanController.getStockMovement);

// E-way bill for internal stock transfer challans (no e-invoice).
registerGstDocumentRoutes(router, { type: GST_DOCUMENT_TYPES.DELIVERY_CHALLAN, rightKey: RIGHT_LIST.DELIVERY_CHALLANS });

module.exports = router;
