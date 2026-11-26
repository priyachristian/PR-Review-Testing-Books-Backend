const express = require('express');
const productionOrderValidation = require('./productionOrder.validation');
const productionOrderController = require('./productionOrder.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkSubscription(PLAN_FEATURES.PRODUCTION_ORDER),
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.CREATE),
    validate(productionOrderValidation.createProductionOrder),
    productionOrderController.createProductionOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW),
    validate(productionOrderValidation.getProductionOrders),
    productionOrderController.getProductionOrders,
  );

router
  .route('/start-process')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.startProcess),
    productionOrderController.startProcess,
  );

router
  .route('/end-process')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.endProcess),
    productionOrderController.endProcess,
  );

router
  .route('/process-submission')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.submitProcess),
    productionOrderController.submitProcess,
  )
  .put(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.editProcessSubmission),
    productionOrderController.editProcessSubmission,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.DELETE),
    validate(productionOrderValidation.deleteProcessSubmission),
    productionOrderController.deleteProcessSubmission,
  );

router
  .route('/pendingSOdropdown')
  .get(validate(productionOrderValidation.getSalesOrderDropdown), productionOrderController.getSalesOrderDropdown);

router
  .route('/production-data')
  .get(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW),
    validate(productionOrderValidation.getItemProductionData),
    productionOrderController.getItemProductionData,
  );

router
  .route('/bom-based/:id')
  .get(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW),
    validate(productionOrderValidation.getBomBasedProductionOrderById),
    productionOrderController.getBomBasedProductionOrderById,
  );

router
  .route('/process-based/:id')
  .get(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW),
    validate(productionOrderValidation.getProcessBasedProductionOrderById),
    productionOrderController.getProcessBasedProductionOrderById,
  );

router
  .route('/:id')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.submitProductionOrder),
    productionOrderController.submitProductionOrder,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW),
    validate(productionOrderValidation.getProductionOrdersById),
    productionOrderController.getProductionOrdersById,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.DELETE),
    validate(productionOrderValidation.deleteProductionOrder),
    productionOrderController.deleteProductionOrder,
  );

router
  .route('/:id/submissions/:submissionId')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.editSubmission),
    productionOrderController.editSubmission,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.DELETE),
    validate(productionOrderValidation.deleteSubmission),
    productionOrderController.deleteSubmission,
  );

router
  .route('/:id/reorder-processes')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.reorderProcesses),
    productionOrderController.reorderProcesses,
  );

router
  .route('/:id/status')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.updateProductionOrderStatus),
    productionOrderController.updateProductionOrderStatus,
  );

router
  .route('/:id/re-raise-transfer')
  .patch(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.EDIT),
    validate(productionOrderValidation.reRaiseTransferRequest),
    productionOrderController.reRaiseTransferRequest,
  );

router
  .route('/:id/stock-movement')
  .get(checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW), productionOrderController.getStockMovement);

router
  .route('/:id/cost-breakdown')
  .get(checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW), productionOrderController.getCostBreakdown);

router
  .route('/:id/material-consumption')
  .get(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW),
    validate(productionOrderValidation.getMaterialConsumption),
    productionOrderController.getMaterialConsumption,
  );

router
  .route('/:id/scrap-rejections')
  .get(
    checkRoleRight(RIGHT_LIST.PRODUCTION, RIGHTS.VIEW),
    validate(productionOrderValidation.getScrapAndRejection),
    productionOrderController.getScrapAndRejection,
  );

module.exports = router;
