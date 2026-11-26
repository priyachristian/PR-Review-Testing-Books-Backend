const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const divisionValidation = require('./division.validation');
const divisionController = require('./division.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkSubscription(PLAN_FEATURES.DIVISION),
    checkRoleRight(RIGHT_LIST.DIVISION, RIGHTS.CREATE),
    validate(divisionValidation.createDivision),
    divisionController.createDivision,
  )
  .get(
    checkRoleRight(RIGHT_LIST.DIVISION, RIGHTS.VIEW),
    validate(divisionValidation.getDivisions),
    divisionController.getDivisions,
  );

router.get('/dropdown', validate(divisionValidation.getDivisionDropdown), divisionController.getDivisionDropDown);

router.put(
  '/updateStatus/:divisionId',
  checkRoleRight(RIGHT_LIST.DIVISION, RIGHTS.EDIT),
  validate(divisionValidation.updateStatus),
  divisionController.updateStatus,
);

router
  .route('/:divisionId')
  .delete(
    checkRoleRight(RIGHT_LIST.DIVISION, RIGHTS.DELETE),
    validate(divisionValidation.deleteDivision),
    divisionController.deleteDivision,
  )
  .get(
    checkRoleRight(RIGHT_LIST.DIVISION, RIGHTS.VIEW),
    validate(divisionValidation.getDivisonById),
    divisionController.getDivisonById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.DIVISION, RIGHTS.EDIT),
    validate(divisionValidation.updateDivision),
    divisionController.updateDivision,
  );

module.exports = router;
