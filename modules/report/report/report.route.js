const express = require('express');
const reportValidation = require('./report.validation');
const reportController = require('./report.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkReportRight, checkAnalyticsRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, REPORT_LIST, RIGHTS, ANALYTICS_RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/ledger')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkReportRight([REPORT_LIST.GENERAL_LEDGER, REPORT_LIST.CREDITORS_LEDGER, REPORT_LIST.DEBTORS_LEDGER]),
    validate(reportValidation.getLedgerReport),
    reportController.getLedgerReport,
  );

router
  .route('/invoice-bargraph')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.SALES_LEDGER, RIGHTS.VIEW),
    validate(reportValidation.invoiceBarGraph),
    reportController.invoiceBarGraph,
  );

router
  .route('/invoice-bargraph-detail')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(reportValidation.invoiceBarGraphDetail),
    reportController.invoiceBarGraphDetail,
  );

router
  .route('/bill-bargraph')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.PURCHASE_LEDGER, RIGHTS.VIEW),
    validate(reportValidation.billBarGraph),
    reportController.billBarGraph,
  );

router
  .route('/bill-bargraph-detail')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(reportValidation.billBarGraphDetail),
    reportController.billBarGraphDetail,
  );

router
  .route('/creditors-report')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.CREDITORS_LEDGER, RIGHTS.VIEW),
    validate(reportValidation.creditorsReport),
    reportController.creditorsReport,
  );

router
  .route('/debtors-report')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.DEBTORS_LEDGER, RIGHTS.VIEW),
    validate(reportValidation.creditorsReport),
    reportController.debtorsReport,
  );

router
  .route('/bank-ledger')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.BANK_LEDGER, RIGHTS.VIEW),
    validate(reportValidation.getBankHistory),
    reportController.getBankHistory,
  );

router
  .route('/item-modulewise-details')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkAnalyticsRight(ANALYTICS_RIGHTS.ITEM_ANALYTICS, RIGHTS.VIEW),
    validate(reportValidation.itemModulewiseDetails),
    reportController.itemModulewiseDetails,
  );

router
  .route('/profit-loss-sheet')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(reportValidation.getProfitLossSheet),
    reportController.getProfitLossSheet,
  );

router
  .route('/balance-sheet')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    validate(reportValidation.getBalanceSheetSummary),
    reportController.getBalanceSheetSummary,
  );

module.exports = router;
