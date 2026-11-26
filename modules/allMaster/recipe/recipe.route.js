const express = require('express');
const recipeValidation = require('./recipe.validation');
const recipeController = require('./recipe.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(checkRoleRight(RIGHT_LIST.RECIPE, RIGHTS.CREATE), validate(recipeValidation.createRecipe), recipeController.createRecipe)
  .get(checkRoleRight(RIGHT_LIST.RECIPE, RIGHTS.VIEW), validate(recipeValidation.getRecipes), recipeController.getRecipes);

router.route('/dropdown').get(validate(recipeValidation.getRecipeDropdown), recipeController.getRecipesDropdown);

router
  .route('/:recipeId')
  .get(checkRoleRight(RIGHT_LIST.RECIPE, RIGHTS.VIEW), validate(recipeValidation.getRecipe), recipeController.getRecipe)
  .delete(
    checkRoleRight(RIGHT_LIST.RECIPE, RIGHTS.DELETE),
    validate(recipeValidation.deleteRecipe),
    recipeController.deleteRecipe,
  )
  .patch(checkRoleRight(RIGHT_LIST.RECIPE, RIGHTS.EDIT), validate(recipeValidation.updateRecipe), recipeController.updateRecipe);

module.exports = router;
