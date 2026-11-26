const express = require('express');
const deviceValidation = require('./device.validation');
const deviceController = require('./device.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router.post('/token', validate(deviceValidation.storeDeviceToken), deviceController.storeDeviceToken);

module.exports = router;
