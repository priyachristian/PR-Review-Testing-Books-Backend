const express = require('express');
const validate = require('../../../middlewares/validate');
const validation = require('./productionDashboard.validation');
const controller = require('./productionDashboard.controller');

const router = express.Router();

router.get('/summary', validate(validation.summaryValidation), controller.getSummary);
router.get('/pipeline', validate(validation.pipelineValidation), controller.getPipeline);
router.get('/sales-order-funnel', validate(validation.salesFunnelValidation), controller.getSalesOrderFunnel);
router.get('/trend', validate(validation.trendValidation), controller.getTrend);
router.get('/top-items', validate(validation.topItemsValidation), controller.getTopItems);

module.exports = router;
