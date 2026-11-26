const express = require('express');
const rejectionAnalyticsValidation = require('./rejectionAnalytics.validation');
const rejectionAnalyticsController = require('./rejectionAnalytics.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS, ANALYTICS_RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router.get(
  '/summary',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.summaryValidation),
  rejectionAnalyticsController.getRejectionSummary,
);

router.get(
  '/trend',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.trendValidation),
  rejectionAnalyticsController.getRejectionTrend,
);

router.get(
  '/by-item',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.byItemValidation),
  rejectionAnalyticsController.getRejectionByItem,
);

router.get(
  '/by-raw-material',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.byRawMaterialValidation),
  rejectionAnalyticsController.getRejectionByRawMaterial,
);

router.get(
  '/by-process',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.byProcessValidation),
  rejectionAnalyticsController.getRejectionByProcess,
);

router.get(
  '/by-branch',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.byBranchValidation),
  rejectionAnalyticsController.getRejectionByBranch,
);

router.get(
  '/item-rejection-report-of-production-order',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS_BY_ITEM, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.itemRejectionReportOfProductionOrder),
  rejectionAnalyticsController.itemRejectionReportOfProductionOrder,
);

router.get(
  '/item-rejection-report-of-production-order/production-orders',
  checkRoleRight(RIGHT_LIST.ANALYTICS, RIGHTS.VIEW),
  checkAnalyticsRight(ANALYTICS_RIGHTS.REJECTION_ANALYTICS_BY_ITEM, RIGHTS.VIEW),
  validate(rejectionAnalyticsValidation.itemRejectionProductionOrderList),
  rejectionAnalyticsController.itemRejectionProductionOrderList,
);

module.exports = router;
