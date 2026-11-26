const express = require('express');
const gstr1Validation = require('./gstr1.validation');
const gstr1Controller = require('./gstr1.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router.get('/', validate(gstr1Validation.generateGstr1Report), gstr1Controller.generateGstr1Report);

module.exports = router;
