const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const getGstDetails = {
  params: Joi.object().keys({
    gstin: Joi.string().required(),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

module.exports = {
  getGstDetails,
};
