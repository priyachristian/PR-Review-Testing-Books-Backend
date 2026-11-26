const express = require('express');
const thirdPartyCredentialsValidation = require('./thirdPartyCredentials.validation');
const thirdPartyCredentialsController = require('./thirdPartyCredentials.controller');
const validate = require('../../../middlewares/validate');
const { isAdmin } = require('../../../middlewares/isAdmin');

const router = express.Router();

router
  .route('/')
  .get(isAdmin, validate(thirdPartyCredentialsValidation.getCredentials), thirdPartyCredentialsController.getCredentials)
  .post(isAdmin, validate(thirdPartyCredentialsValidation.createCredentials), thirdPartyCredentialsController.createCredentials)
  .put(isAdmin, validate(thirdPartyCredentialsValidation.updateCredentials), thirdPartyCredentialsController.updateCredentials)
  .delete(
    isAdmin,
    validate(thirdPartyCredentialsValidation.deleteCredentials),
    thirdPartyCredentialsController.deleteCredentials,
  );

router
  .route('/reveal')
  .get(isAdmin, validate(thirdPartyCredentialsValidation.revealCredentials), thirdPartyCredentialsController.revealCredentials);

router
  .route('/list')
  .get(isAdmin, validate(thirdPartyCredentialsValidation.getAllCredentials), thirdPartyCredentialsController.getAllCredentials);

module.exports = router;
