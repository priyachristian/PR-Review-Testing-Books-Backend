const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { LEDGER_SOURCE_MODULES } = require('../../../utils/enum');

const getJournalBySource = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sourceModule: Joi.string()
      .valid(...Object.values(LEDGER_SOURCE_MODULES))
      .required()
      .label('Source Module'),
    sourceId: Joi.string().custom(objectId).required().label('Source ID'),
  }),
};

module.exports = {
  getJournalBySource,
};
