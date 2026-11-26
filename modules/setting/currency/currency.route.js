const express = require('express');
const currencyValidation = require('./currency.validation');
const currencyController = require('./currency.controller');
const validate = require('../../../middlewares/validate');
const { isAdmin } = require('../../../middlewares/isAdmin');

const router = express.Router();

router
  .route('/')
  .get(validate(currencyValidation.getCurrencies), currencyController.getCurrencies)
  .post(isAdmin, validate(currencyValidation.createCurrency), currencyController.createCurrency);

router
  .route('/:currencyId')
  .put(isAdmin, validate(currencyValidation.updateCurrency), currencyController.updateCurrency)
  .delete(isAdmin, validate(currencyValidation.deleteCurrency), currencyController.deleteCurrency);

module.exports = router;
