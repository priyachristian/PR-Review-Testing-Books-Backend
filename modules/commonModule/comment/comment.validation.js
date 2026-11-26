const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { COMMENT_SUPPORTED_MODULES } = require('../../../utils/moduleConfig');

const addComment = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),

  body: Joi.object().keys({
    moduleName: Joi.string()
      .trim()
      .uppercase()
      .valid(...COMMENT_SUPPORTED_MODULES)
      .required()
      .messages({
        'any.only': 'Module Name is not supported for comments',
        'any.required': 'Module Name is required',
      }),

    referenceId: Joi.string().required().custom(objectId).label('Reference ID'),

    message: Joi.string().trim().required().messages({
      'string.empty': 'Message cannot be empty',
      'any.required': 'Message is required',
    }),
  }),
};

module.exports = {
  addComment,
};
