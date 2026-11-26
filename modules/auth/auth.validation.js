const Joi = require('joi');

const refreshTokens = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required().label('Refresh Token').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

const logout = {
  body: Joi.object().keys({
    deviceId: Joi.string().trim().optional().label('Device ID'),
  }),
};

module.exports = {
  refreshTokens,
  logout,
};
