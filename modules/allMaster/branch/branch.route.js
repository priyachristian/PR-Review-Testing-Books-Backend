const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const branchValidation = require('./branch.validation');
const branchController = require('./branch.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkSubscription(PLAN_FEATURES.BRANCH),
    checkRoleRight(RIGHT_LIST.BRANCH, RIGHTS.CREATE),
    validate(branchValidation.createBranch),
    branchController.createBranch,
  )
  .get(validate(branchValidation.getBranches), branchController.getAllBranches);

router.get(
  '/listofbranches/all',
  validate(branchValidation.getAllBranchesWithDivision),
  branchController.getAllBranchesWithDivision,
);

router.get('/dropdown', validate(branchValidation.getBranchDropdown), branchController.getBranchDropDown);

router
  .route('/updateStatus/:branchId')
  .put(checkRoleRight(RIGHT_LIST.BRANCH, RIGHTS.EDIT), validate(branchValidation.updateStatus), branchController.updateStatus);

router
  .route('/:branchId')
  .get(checkRoleRight(RIGHT_LIST.BRANCH, RIGHTS.VIEW), validate(branchValidation.getBranchById), branchController.getBranchById)
  .delete(
    checkRoleRight(RIGHT_LIST.BRANCH, RIGHTS.DELETE),
    validate(branchValidation.deleteBranch),
    branchController.deleteBranch,
  )
  .put(checkRoleRight(RIGHT_LIST.BRANCH, RIGHTS.EDIT), validate(branchValidation.updateBranch), branchController.updateBranch);

module.exports = router;
