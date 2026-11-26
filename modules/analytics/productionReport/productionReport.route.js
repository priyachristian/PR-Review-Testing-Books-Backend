const express = require('express');
const productionReportValidation = require('./productionReport.validation');
const productionReportController = require('./productionReport.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS, ANALYTICS_RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.get(
  '/monthly-summary',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.MONTHLY_PRODUCTION_REPORT, RIGHTS.VIEW),
  validate(productionReportValidation.monthlySummaryValidation),
  productionReportController.getMonthlySummary,
);

router.get(
  '/monthly-detail/orders',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.MONTHLY_PRODUCTION_REPORT, RIGHTS.VIEW),
  validate(productionReportValidation.monthlyDetailValidation),
  productionReportController.getMonthlyDetailOrders,
);

router.get(
  '/monthly-detail/by-item',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.MONTHLY_PRODUCTION_REPORT, RIGHTS.VIEW),
  validate(productionReportValidation.monthlyDetailByItemValidation),
  productionReportController.getMonthlyDetailByItem,
);

module.exports = router;
