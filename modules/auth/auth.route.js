const express = require('express');
const authValidation = require('./auth.validation');
const authController = require('./auth.controller');
const validate = require('../../middlewares/validate');

const router = express.Router();

router.post('/logout', validate(authValidation.logout), authController.logout);
router.post('/refresh-tokens', validate(authValidation.refreshTokens), authController.refreshTokens);
router.get('/validate-token', authController.validateToken);

module.exports = router;
