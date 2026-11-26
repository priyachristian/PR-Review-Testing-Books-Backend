const express = require('express');
const roleValidation = require('./role.validation');
const roleController = require('./role.controller');
const validate = require('../../../middlewares/validate');
const { isAdmin } = require('../../../middlewares/isAdmin');

const router = express.Router();

router
  .route('/')
  .post(isAdmin, validate(roleValidation.createRole), roleController.createRole)
  .get(isAdmin, validate(roleValidation.getRoles), roleController.getRoles);

router.route('/dropdown').get(validate(roleValidation.getRolesDropdown), roleController.getRolesDropdown);

router
  .route('/:roleId')
  .get(isAdmin, validate(roleValidation.getRole), roleController.getRole)
  .patch(isAdmin, validate(roleValidation.updateRole), roleController.updateRole)
  .delete(isAdmin, validate(roleValidation.deleteRole), roleController.deleteRole);

module.exports = router;
