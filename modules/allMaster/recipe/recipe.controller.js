const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const recipeService = require('./recipe.service');
const { successResponse } = require('../../../services/response.service');
const { RECIPE_MESSAGES } = require('../../../utils/messages');

const createRecipe = catchAsync(
  async (req, res) => {
    const recipe = await recipeService.createRecipe({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, recipe, RECIPE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createRecipe',
    controller: 'recipe',
    failureMessage: RECIPE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getRecipes = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['name', 'companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await recipeService.queryRecipes(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, RECIPE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryRecipes',
    controller: 'recipe',
    failureMessage: RECIPE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecipe = catchAsync(
  async (req, res) => {
    const recipe = await recipeService.getRecipeById(req.params.recipeId, req.query.companyId);
    return successResponse(res, recipe, RECIPE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRecipeById',
    controller: 'recipe',
    failureMessage: RECIPE_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRecipe = catchAsync(
  async (req, res) => {
    const recipe = await recipeService.updateRecipeById(
      req.params.recipeId,
      { ...req.body, companyId: req.query.companyId },
      req.user._id,
    );
    return successResponse(res, recipe, RECIPE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRecipeById',
    controller: 'recipe',
    failureMessage: RECIPE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteRecipe = catchAsync(
  async (req, res) => {
    await recipeService.deleteRecipeById(req.params.recipeId, req.query.companyId);
    return successResponse(res, {}, RECIPE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteRecipeById',
    controller: 'recipe',
    failureMessage: RECIPE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecipesDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await recipeService.getRecipesDropdown(filter);
    return successResponse(res, result, RECIPE_MESSAGES.DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRecipesDropdown',
    controller: 'recipe',
    failureMessage: RECIPE_MESSAGES.DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createRecipe,
  getRecipes,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  getRecipesDropdown,
};
