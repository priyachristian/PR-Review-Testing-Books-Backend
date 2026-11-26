const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const listDevelopmentUpdate = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).optional(),
  }),
};

module.exports = {
  listDevelopmentUpdate,
};
