const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const userValidation = require('./user.validation');
const userController = require('./user.controller');
const validate = require('../../../middlewares/validate');
const { isAdmin } = require('../../../middlewares/isAdmin');
const { checkSubscription } = require('../../../middlewares/checkSubscription');

const router = express.Router();

router
  .route('/')
  .post(isAdmin, validate(userValidation.createUser), userController.createUser)
  .get(isAdmin, validate(userValidation.getUsers), userController.getUsers);

router.route('/dropdown').get(validate(userValidation.getUsersDropdown), userController.getUsersDropdown);

router
  .route('/invite')
  .post(checkSubscription(PLAN_FEATURES.USER), isAdmin, validate(userValidation.inviteUser), userController.inviteUser);

router.route('/verify-invite').post(validate(userValidation.verifyInvite), userController.verifyInvite);

router.route('/change-status').post(isAdmin, validate(userValidation.changeUserStatus), userController.changeUserStatus);

router.route('/defaultconfiguration').patch(validate(userValidation.defaultconfiguration), userController.defaultconfiguration);

router
  .route('/:userId/updateUserStatusAndRole')
  .put(isAdmin, validate(userValidation.updateUserStatusAndRole), userController.updateUserStatusAndRole);

router
  .route('/:userId/companyUser')
  .delete(isAdmin, validate(userValidation.deleteCompanyUser), userController.deleteCompanyUser);

router.route('/:userId/role').get(validate(userValidation.getUser), userController.getUserRole);

router.route('/:userId/profile').get(validate(userValidation.getUserProfile), userController.getUserProfile);

router
  .route('/:userId')
  .get(isAdmin, validate(userValidation.getUser), userController.getUser)
  .patch(isAdmin, validate(userValidation.updateUser), userController.updateUser)
  .delete(isAdmin, validate(userValidation.deleteUser), userController.deleteUser);

module.exports = router;
