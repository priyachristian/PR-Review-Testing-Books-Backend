const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const generateGstr1Report = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required().label('Company ID'),
    startDate: Joi.date().required().label('Start Date'),
    endDate: Joi.date().required().label('End Date').min(Joi.ref('startDate')),
  }),
};

module.exports = {
  generateGstr1Report,
};
