const express = require('express');
const salesDashboardValidation = require('./salesDashboard.validation');
const salesDashboardController = require('./salesDashboard.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router.route('/summary').get(validate(salesDashboardValidation.summaryValidation), salesDashboardController.getSummary);

router.route('/state-wise').get(validate(salesDashboardValidation.stateWiseValidation), salesDashboardController.getStateWise);

router.route('/city-wise').get(validate(salesDashboardValidation.cityWiseValidation), salesDashboardController.getCityWise);

router
  .route('/customer-wise')
  .get(validate(salesDashboardValidation.customerWiseValidation), salesDashboardController.getCustomerWise);

router.route('/item-wise').get(validate(salesDashboardValidation.itemWiseValidation), salesDashboardController.getItemWise);

router.route('/customers').get(validate(salesDashboardValidation.customersValidation), salesDashboardController.getCustomers);

router
  .route('/graph/state')
  .get(validate(salesDashboardValidation.summaryValidation), salesDashboardController.getStateWiseGraph);

router.get(
  '/graph/order-invoice-payment-trend',
  validate(salesDashboardValidation.summaryValidation),
  salesDashboardController.getOrderInvoicePaymentTrend,
);

router.get(
  '/graph/order-status-summary',
  validate(salesDashboardValidation.getOrderStatusSummary),
  salesDashboardController.getOrderStatusSummary,
);

router.get(
  '/item-wise/details/:itemId',
  validate(salesDashboardValidation.getItemWiseDetails),
  salesDashboardController.getItemWiseDetails,
);

router.get(
  '/customer-wise/details/:customerId',
  validate(salesDashboardValidation.getCustomerWiseDetails),
  salesDashboardController.getCustomerWiseDetails,
);

router.get(
  '/state-wise/details/:stateId',
  validate(salesDashboardValidation.getStateWiseDetails),
  salesDashboardController.getStateWiseDetails,
);

router
  .route('/inactive-customers')
  .get(validate(salesDashboardValidation.inactiveCustomersValidation), salesDashboardController.getInactiveCustomers);

router
  .route('/non-order-customers')
  .get(validate(salesDashboardValidation.nonOrderCustomersValidation), salesDashboardController.getNonOrderCustomers);

router
  .route('/non-order-customer-list')
  .get(validate(salesDashboardValidation.nonOrderCustomerListValidation), salesDashboardController.getNonOrderCustomerList);

router
  .route('/customer-invoices')
  .get(validate(salesDashboardValidation.customerInvoicesValidation), salesDashboardController.getCustomerInvoices);

router
  .route('/item-group-analytics')
  .get(validate(salesDashboardValidation.itemGroupAnalyticsValidation), salesDashboardController.getItemGroupAnalytics);

module.exports = router;
