const Joi = require('joi');

const updateMaintenanceMode = {
  body: Joi.object().keys({
    isActive: Joi.boolean().required(),
    message: Joi.string().max(500).optional(),
  }),
};

module.exports = {
  updateMaintenanceMode,
};
