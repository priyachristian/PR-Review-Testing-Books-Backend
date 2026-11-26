const express = require('express');
const validate = require('../../middlewares/validate');
const { checkRoleRight } = require('../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../utils/enum');
const problemListValidation = require('./problemList.validation');
const problemListController = require('./problemList.controller');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.PROBLEM_LIST, RIGHTS.CREATE),
    validate(problemListValidation.createProblemList),
    problemListController.createProblemList,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PROBLEM_LIST, RIGHTS.VIEW),
    validate(problemListValidation.getProblemLists),
    problemListController.getProblemLists,
  );

router
  .route('/:problemListId')
  .get(
    checkRoleRight(RIGHT_LIST.PROBLEM_LIST, RIGHTS.VIEW),
    validate(problemListValidation.getProblemListById),
    problemListController.getProblemListById,
  )
  .put(
    checkRoleRight(RIGHT_LIST.PROBLEM_LIST, RIGHTS.EDIT),
    validate(problemListValidation.updateProblemList),
    problemListController.updateProblemList,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.PROBLEM_LIST, RIGHTS.DELETE),
    validate(problemListValidation.deleteProblemList),
    problemListController.deleteProblemList,
  );

module.exports = router;
