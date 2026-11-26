const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const salesOrderValidation = require('./salesOrder.validation');
const salesOrderController = require('./salesOrder.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { checkPrimaryBank } = require('../../../middlewares/checkPrimaryBank');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const { RIGHTS, RIGHT_LIST, ANALYTICS_RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

// Multer middleware for handling file uploads - supports multiple files with field name 'attachment'
const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.SALES_ORDER),
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.CREATE),
    checkPrimaryBank,
    validate(salesOrderValidation.createSalesOrder),
    validateDocumentTotals,
    salesOrderController.createSalesOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.VIEW),
    validate(salesOrderValidation.getSalesOrders),
    salesOrderController.getSalesOrders,
  );

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.VIEW),
    validate(salesOrderValidation.getSalesOrdersExports),
    salesOrderController.getSalesOrdersExports,
  );

router.post(
  '/convert-to-production-order',
  checkSubscription(PLAN_FEATURES.PRODUCTION_ORDER),
  checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.CREATE),
  validate(salesOrderValidation.createProductionOrder),
  salesOrderController.createProductionOrder,
);

router.route('/dropdown').get(validate(salesOrderValidation.getSalesOrderDropdown), salesOrderController.getSalesOrderDropdown);

router
  .route('/soAnalysis')
  .get(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.SALES_ORDER_WISE_RM_ANALYTICS, RIGHTS.VIEW),
    validate(salesOrderValidation.salesOrderAnalysis),
    salesOrderController.salesOrderAnalysis,
  );

router
  .route('/soItemAnalysis')
  .get(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.ITEM_WISE_RM_ANALYTICS, RIGHTS.VIEW),
    validate(salesOrderValidation.salesOrderAnalysis),
    salesOrderController.salesItemAnalysis,
  );

router
  .route('/salesOrderRMAnalysis')
  .get(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.RM_ANALYTICS, RIGHTS.VIEW),
    validate(salesOrderValidation.salesOrderAnalysis),
    salesOrderController.salesOrderRMAnalysis,
  );

router.get(
  '/partiallyconverteditem',
  validate(salesOrderValidation.partiallyconverteditem),
  salesOrderController.partiallyConvertedItemList,
);

router.route('/opensalesorder').get(validate(salesOrderValidation.openSalesOrders), salesOrderController.openSalesOrders);

router
  .route('/salesOrderWiseItemAnalysis')
  .get(
    checkAnalyticsRight(ANALYTICS_RIGHTS.SALES_ORDERS_ANALYTICS, RIGHTS.VIEW),
    validate(salesOrderValidation.getSalesOrderWiseItemAnalysis),
    salesOrderController.getSalesOrderWiseItemAnalysis,
  );

router
  .route('/itemWiseSalesOrderAnalysis')
  .get(
    checkAnalyticsRight(ANALYTICS_RIGHTS.ITEM_WISE_SALES_ORDERS_ANALYTICS, RIGHTS.VIEW),
    validate(salesOrderValidation.getSalesOrderWiseItemAnalysis),
    salesOrderController.getItemWiseSalesOrderAnalysis,
  );

router
  .route('/customerWiseSalesOrderAnalysis')
  .get(
    checkAnalyticsRight(ANALYTICS_RIGHTS.CUSTOMER_WISE_SALES_ORDERS_ANALYTICS, RIGHTS.VIEW),
    validate(salesOrderValidation.getCustomerWiseSalesOrderAnalysis),
    salesOrderController.getCustomerWiseSalesOrderAnalysis,
  );

router
  .route('/newVsOldCustomerReport')
  .get(
    checkAnalyticsRight(ANALYTICS_RIGHTS.NEW_VS_OLD_CUSTOMER_REPORT, RIGHTS.VIEW),
    validate(salesOrderValidation.getSalesOrderWiseItemAnalysis),
    salesOrderController.getNewVsOldCustomerReport,
  );

router
  .route('/newVsOldCustomerReport/moduleData')
  .post(
    checkAnalyticsRight(ANALYTICS_RIGHTS.NEW_VS_OLD_CUSTOMER_REPORT, RIGHTS.VIEW),
    validate(salesOrderValidation.getNewVsOldCustomerReportModuleData),
    salesOrderController.getNewVsOldCustomerReportModuleData,
  );

router
  .route('/:orderId')
  .get(
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.VIEW),
    validate(salesOrderValidation.getSalesOrder),
    salesOrderController.getSalesOrder,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.DELETE),
    validate(salesOrderValidation.deleteSalesOrder),
    salesOrderController.deleteSalesOrder,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(salesOrderValidation.updateSalesOrder),
    validateDocumentTotals,
    salesOrderController.updateSalesOrder,
  );

router
  .route('/:orderId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.EDIT),
    validate(salesOrderValidation.updateSalesOrderStatus),
    salesOrderController.updateSalesOrderStatus,
  );

router
  .route('/:orderId/revert-close')
  .patch(
    checkRoleRight(RIGHT_LIST.SALES_ORDER, RIGHTS.EDIT),
    validate(salesOrderValidation.revertSalesOrderClose),
    salesOrderController.revertSalesOrderClose,
  );

module.exports = router;
