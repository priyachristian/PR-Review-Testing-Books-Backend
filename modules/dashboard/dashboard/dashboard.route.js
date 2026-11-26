const express = require('express');
const dashboardValidation = require('./dashboard.validation');
const dashboardController = require('./dashboard.controller');
const validate = require('../../../middlewares/validate');
const { checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { ANALYTICS_RIGHTS, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/salesOrderAnalytics')
  .get(validate(dashboardValidation.getSalesOrderValidation), dashboardController.getDashboardSalesOrderAnalytics);

router
  .route('/purchaseOrderAnalytics')
  .get(validate(dashboardValidation.getPurchaseOrderValidation), dashboardController.getDashboardPurchaseOrderAnalytics);

router
  .route('/invoiceAnalytics')
  .get(validate(dashboardValidation.getInvoiceValidation), dashboardController.getDashboardInvoiceAnalytics);

router
  .route('/billAnalytics')
  .get(validate(dashboardValidation.getBillValidation), dashboardController.getDashboardBillAnalytics);

router.route('/top5SalesOrders').get(validate(dashboardValidation.salesAnalyticsValidation), dashboardController.top5SalesOrders);

router
  .route('/top5PurchaseOrders')
  .get(validate(dashboardValidation.salesAnalyticsValidation), dashboardController.top5PurchaseOrders);

router
  .route('/top5PaymentReceived')
  .get(validate(dashboardValidation.salesAnalyticsValidation), dashboardController.top5PaymentReceived);

router.route('/top5PaymentMade').get(validate(dashboardValidation.salesAnalyticsValidation), dashboardController.top5PaymentMade);

router.route('/top5Expense').get(validate(dashboardValidation.salesAnalyticsValidation), dashboardController.top5Expense);

router
  .route('/dashboardSummary')
  .get(validate(dashboardValidation.dashboardSummaryValidation), dashboardController.dashboardSummary);

router
  .route('/userWiseSummary')
  .get(validate(dashboardValidation.userWiseSummaryValidation), dashboardController.userWiseSummary);

module.exports = router;
