const express = require('express');
const analyticsValidation = require('./analytics.validation');
const analyticsController = require('./analytics.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS, ANALYTICS_RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.get(
  '/topCustomersOfSales',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.TOP_CUSTOMERS_OF_SALES, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.topCustomersOfSales,
);

router.get(
  '/topItemsOfSales',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.TOP_ITEMS_OF_SALES, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.topItemsOfSales,
);

router.get(
  '/topPurchasedItems',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.TOP_ITEM_OF_PURCHASE, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.topPurchasedItems,
);

router.get(
  '/topPurchaseOrders',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.TOP_VENDORS_BY_AMOUNT_PURCHASE, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.topPurchaseOrders,
);

router.get(
  '/topVendorsOfPurchase',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.VENDORS_BY_PURCHASE, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.topVendorsOfPurchase,
);

router.get(
  '/topCustomersByBalance',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.TOP_CUSTOMER_BY_AMOUNT_COLLECTION, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.topCustomersByBalance,
);

router.get(
  '/recentPayments',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.RECENTLY_RECEIVED_PAYMENTS, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.recentPayments,
);

router.get(
  '/upcomingReceivables',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.UPCOMING_RECEIVABLES_INVOICE, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.upcomingReceivables,
);

router.get(
  '/overdueInvoices',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.OVERDUE_INVOICES, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.overdueInvoices,
);

router.get(
  '/topVendorsByBalance',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.TOP_VENDORS_BY_AMOUNT_PAYMENTS, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.topVendorsByBalance,
);

router.get(
  '/recentPaymentsMade',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.RECENTLY_PAYMENTS_MADE, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.recentPaymentsMade,
);

router.get(
  '/upcomingPayables',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.UPCOMING_PAYABLES_BILLS, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.upcomingPayables,
);

router.get(
  '/overdueBills',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.OVERDUE_BILLS, RIGHTS.VIEW),
  validate(analyticsValidation.salesAnalyticsValidation),
  analyticsController.overdueBills,
);

router.get(
  '/itemProcessAnalytics',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.ITEM_PROCESS_ANALYTICS, RIGHTS.VIEW),
  validate(analyticsValidation.itemProcessAnalyticsValidation),
  analyticsController.itemProcessAnalytics,
);

router.get(
  '/customersWithSingleInvoice',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.CUSTOMER_ONE_INVOICE, RIGHTS.VIEW),
  validate(analyticsValidation.customersWithSingleInvoiceValidation),
  analyticsController.customersWithSingleInvoice,
);

router.get(
  '/partyWiseBusinessPerformance',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.PARTY_WISE_BUSINESS_PERFORMANCE, RIGHTS.VIEW),
  validate(analyticsValidation.partyWiseBusinessPerformanceValidation),
  analyticsController.partyWiseBusinessPerformance,
);

router.get(
  '/partyWiseBusinessPerformance/export',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.PARTY_WISE_BUSINESS_PERFORMANCE, RIGHTS.VIEW),
  validate(analyticsValidation.exportPartyWiseBusinessPerformanceValidation),
  analyticsController.exportPartyWiseBusinessPerformance,
);

router
  .route('/generalSalesAnalytics')
  .get(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.GENERAL_SALES_ANALYTICS, RIGHTS.VIEW),
    validate(analyticsValidation.getGeneralSalesAnalytics),
    analyticsController.getGeneralSalesAnalytics,
  )
  .post(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.GENERAL_SALES_ANALYTICS, RIGHTS.VIEW),
    validate(analyticsValidation.createGeneralSalesAnalytics),
    analyticsController.createGeneralSalesAnalytics,
  );

router
  .route('/generalSalesAnalytics/:id')
  .get(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.GENERAL_SALES_ANALYTICS, RIGHTS.VIEW),
    validate(analyticsValidation.getGeneralSalesAnalyticsById),
    analyticsController.getGeneralSalesAnalyticsById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.GENERAL_SALES_ANALYTICS, RIGHTS.VIEW),
    validate(analyticsValidation.updateGeneralSalesAnalytics),
    analyticsController.updateGeneralSalesAnalytics,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.GENERAL_SALES_ANALYTICS, RIGHTS.VIEW),
    validate(analyticsValidation.deleteGeneralSalesAnalytics),
    analyticsController.deleteGeneralSalesAnalytics,
  );

module.exports = router;
