const express = require('express');
const profitLossValidation = require('./profitLoss.validation');
const profitLossController = require('./profitLoss.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkReportRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, REPORT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/customerdetails')
  .get(validate(profitLossValidation.getProfitLossByCustomer), profitLossController.getProfitLossByCustomer);

router
  .route('/customersummary')
  .get(
    checkRoleRight(RIGHT_LIST.REPORTS, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.BANK_LEDGER, RIGHTS.VIEW),
    validate(profitLossValidation.getProfitLossSummaryByCustomer),
    profitLossController.getProfitLossSummaryByCustomer,
  );

router
  .route('/itemsummary')
  .get(validate(profitLossValidation.getProfitLossSummaryByItem), profitLossController.getProfitLossSummaryByItem);

router.route('/itemdetails').get(validate(profitLossValidation.getProfitLossByItem), profitLossController.getProfitLossByItem);

router
  .route('/customerMonthWise')
  .get(validate(profitLossValidation.getProfitLossByCustomerMonthWise), profitLossController.getProfitLossByCustomerMonthWise);

router.route('/documentdetails').get(validate(profitLossValidation.getDocumentDetails), profitLossController.getDocumentDetails);

router
  .route('/documentdetailsbyitemid')
  .get(validate(profitLossValidation.getDocumentDetailsByItemId), profitLossController.getDocumentDetailsByItemId);

router
  .route('/productionorderdetails')
  .get(validate(profitLossValidation.getProductionOrderDetails), profitLossController.getProductionOrderDetails);

router
  .route('/productionorderdetails/v2')
  .get(validate(profitLossValidation.getProductionOrderDetails), profitLossController.getProductionOrderDetails_v2);

router
  .route('/productionorderdetails/v2/rawMaterials')
  .post(validate(profitLossValidation.getBatchSourceDetailsBulk), profitLossController.getBatchSourceDetailsBulk);

module.exports = router;
