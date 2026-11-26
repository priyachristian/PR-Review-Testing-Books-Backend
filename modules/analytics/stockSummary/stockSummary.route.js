const express = require('express');
const stockSummaryValidation = require('./stockSummary.validation');
const stockSummaryController = require('./stockSummary.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS, ANALYTICS_RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.get(
  '/summary',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.STOCK_SUMMARY, RIGHTS.VIEW),
  validate(stockSummaryValidation.stockSummaryValidation),
  stockSummaryController.getStockSummary,
);

router.get(
  '/date-wise',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.STOCK_SUMMARY, RIGHTS.VIEW),
  validate(stockSummaryValidation.dateWiseValidation),
  stockSummaryController.getDateWiseBreakdown,
);

module.exports = router;
