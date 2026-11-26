const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createRecipe = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    recipeId: Joi.string().required(),
    name: Joi.string().required().label('Recipe Name').messages({
      'any.required': '{{#label}} is required',
      'string.empty': '{{#label}} cannot be empty',
    }),
    processes: Joi.array().items(Joi.string().custom(objectId)).required().label('Processes').messages({
      'any.required': '{{#label}} is required',
      'array.base': '{{#label}} must be an array of process IDs',
    }),
    remarks: Joi.string().required().trim().label('Remarks'),
  }),
};

const getRecipes = {
  query: Joi.object().keys({
    name: Joi.string(),
    companyId: Joi.string().custom(objectId),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    search: Joi.string(),
  }),
};

const getRecipeDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const getRecipe = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    recipeId: Joi.string().custom(objectId),
  }),
};

const updateRecipe = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    recipeId: Joi.required().custom(objectId).label('Recipe ID').messages({
      'any.required': '{{#label}} is required',
      'string.empty': '{{#label}} cannot be empty',
    }),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().label('Recipe Name').messages({
        'string.empty': '{{#label}} cannot be empty',
      }),
      processes: Joi.array().items(Joi.string().custom(objectId)).label('Processes').messages({
        'array.base': '{{#label}} must be an array of process IDs',
      }),
      remarks: Joi.string().allow(null, '').trim().label('Remarks'),
    })
    .min(1)
    .label('Update Recipe Body')
    .messages({
      'object.min': '{{#label}} must have at least one field to update',
    }),
};

const deleteRecipe = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    recipeId: Joi.string().custom(objectId),
  }),
};

module.exports = {
  createRecipe,
  getRecipes,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  getRecipeDropdown,
};
