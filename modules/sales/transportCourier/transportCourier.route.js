const express = require('express');
const transportCourierValidation = require('./transportCourier.validation');
const transportCourierController = require('./transportCourier.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router
  .route('/')
  .post(validate(transportCourierValidation.createTransportCourier), transportCourierController.createTransportCourier)
  .get(validate(transportCourierValidation.getTransportCouriers), transportCourierController.getTransportCouriers);

router
  .route('/:transportCourierId')
  .get(validate(transportCourierValidation.getTransportCourier), transportCourierController.getTransportCourier)
  .delete(validate(transportCourierValidation.deleteTransportCourier), transportCourierController.deleteTransportCourier)
  .patch(validate(transportCourierValidation.updateTransportCourier), transportCourierController.updateTransportCourier);

module.exports = router;
