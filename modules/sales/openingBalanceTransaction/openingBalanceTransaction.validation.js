const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { CONTACT_TYPE } = require('../../..//utils/enum');

const getOpeningBalanceTransactionHistory = {
  params: Joi.object().keys({
    contactId: commonSchemas.objectId({ label: 'Contact ID', isRequired: true }),
  }),
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    contactType: Joi.string()
      .valid(...Object.values(CONTACT_TYPE))
      .required()
      .label('Contact Type'),
  }),
};

module.exports = {
  getOpeningBalanceTransactionHistory,
};
