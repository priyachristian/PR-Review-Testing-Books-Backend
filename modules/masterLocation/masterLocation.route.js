const express = require('express');
const masterLocationValidation = require('./masterLocation.validation');
const masterLocationController = require('./masterLocation.controller');
const validate = require('../../middlewares/validate');

const router = express.Router();

router.get('/countries', validate(masterLocationValidation.getCountries), masterLocationController.getCountries);
router.get('/states', validate(masterLocationValidation.getStates), masterLocationController.getStates);
router.get('/cities', validate(masterLocationValidation.getCities), masterLocationController.getCities);

module.exports = router;
