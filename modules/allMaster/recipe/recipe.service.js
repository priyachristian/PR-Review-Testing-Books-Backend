const httpStatus = require('http-status');
const { getBooksModels, getBooksCrmModels, getClientConnection } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { RECIPE_MESSAGES } = require('../../../utils/messages');
const { MODULE_NAMES } = require('../../../utils/enum');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');

/**
 * Create a recipe
 * @param {Object} recipeBody
 * @returns {Promise<Recipe>}
 */
const createRecipe = async (recipeBody, userId) => {
  const { Recipe } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const existingRecipe = await Recipe.findOne({
      name: { $regex: new RegExp(`^${recipeBody.name}$`, 'i') },
      companyId: recipeBody.companyId,
    }).session(session);

    if (existingRecipe) {
      throw new ApiError(httpStatus.CONFLICT, 'Recipe with this name already exists');
    }

    recipeBody.recipeId = await generateUniqueId(
      Recipe,
      recipeBody?.companyId,
      MODULE_NAMES.RECIPE,
      'recipeId',
      'REC',
      session,
      recipeBody.recipeId,
    );

    const recipeData = {
      ...recipeBody,
      addedBy: userId,
      updatedBy: userId,
    };
    const newRecipe = await Recipe.create([recipeData], { session });
    await session.commitTransaction();
    return newRecipe[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Query for recipes
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryRecipes = async (query, filter, options) => {
  const { Recipe } = getBooksModels();
  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    filter.$or = [{ name: searchRegex }, { recipeId: searchRegex }];
  }
  options.populate = `processes`;
  const recipes = await Recipe.paginate(filter, options);
  return recipes;
};

/**
 * Get recipe by id
 * @param {ObjectId} id
 * @returns {Promise<Recipe>}
 */
const getRecipeById = async (id, companyId) => {
  const { Recipe } = getBooksModels();
  const recipe = await Recipe.findOne({ _id: id, companyId }).populate('processes');
  if (!recipe) {
    throw new ApiError(httpStatus.NOT_FOUND, RECIPE_MESSAGES.FETCH_NOT_FOUND);
  }
  return recipe;
};

/**
 * Update recipe by id
 * @param {ObjectId} recipeId
 * @param {Object} updateBody
 * @returns {Promise<Recipe>}
 */
const updateRecipeById = async (recipeId, updateBody, userId) => {
  const { Recipe } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const recipe = await Recipe.findById(recipeId).session(session);
    if (!recipe) {
      throw new ApiError(httpStatus.NOT_FOUND, RECIPE_MESSAGES.FETCH_NOT_FOUND);
    }

    const existingRecipe = await Recipe.findOne({
      name: { $regex: new RegExp(`^${updateBody.name}$`, 'i') },
      companyId: recipe.companyId,
      _id: { $ne: recipeId },
    }).session(session);

    if (existingRecipe) {
      throw new ApiError(httpStatus.CONFLICT, 'Recipe with this name already exists');
    }

    Object.assign(recipe, updateBody);
    recipe.updatedBy = userId;
    await recipe.save({ session });
    await session.commitTransaction();
    return recipe;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Delete recipe by id
 * @param {ObjectId} recipeId
 * @returns {Promise<Recipe>}
 */
const deleteRecipeById = async (recipeId, companyId) => {
  const { Recipe, ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const [productionOrderUsingRecipe, itemUsingRecipe] = await Promise.all([
    ProductionOrder.findOne({ 'processBased.recipeId': recipeId, companyId }),
    Item.findOne({ 'productionData.selectProcessRecipe': recipeId, companyId }),
  ]);
  if (productionOrderUsingRecipe || itemUsingRecipe) {
    throw new ApiError(httpStatus.BAD_REQUEST, RECIPE_MESSAGES.DELETE_IN_USE);
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const recipe = await Recipe.findOne({ _id: recipeId, companyId }).session(session);
    if (!recipe) {
      throw new ApiError(httpStatus.NOT_FOUND, RECIPE_MESSAGES.FETCH_NOT_FOUND);
    }
    await Recipe.deleteOne({ _id: recipeId, companyId }, { session });
    await session.commitTransaction();
    return recipe;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Get Recipe for dropdown (only name, id and recipeId)
 * @param {Object} filter - Mongo filter
 * @returns {Promise<Array>}
 */
const getRecipesDropdown = async filter => {
  const { Recipe } = getBooksModels();
  const Recipes = await Recipe.find(filter).select('name recipeId id').populate('processes', 'name processId ').lean();
  return Recipes;
};

module.exports = {
  createRecipe: withTransientRetry(createRecipe),
  queryRecipes,
  getRecipeById,
  updateRecipeById,
  deleteRecipeById,
  getRecipesDropdown,
};
