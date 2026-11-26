const express = require('express');
const gstValidation = require('./gst.validation');
const gstController = require('./gst.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router.get('/:gstin', validate(gstValidation.getGstDetails), gstController.getGstDetails);

module.exports = router;
