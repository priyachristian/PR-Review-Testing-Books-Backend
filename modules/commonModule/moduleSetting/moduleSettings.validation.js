const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { MODULE_NAMES, NIC_DOC_NUMBER_MAX_LENGTH } = require('../../../utils/enum');

const NIC_DOC_NUMBER_MODULES = [MODULE_NAMES.INVOICE];

const enforceNicDocNumberLength = (value, helpers) => {
  const root = helpers.state.ancestors[helpers.state.ancestors.length - 1];
  const moduleName = value.moduleName || root?.params?.moduleName;
  if (!NIC_DOC_NUMBER_MODULES.includes(moduleName)) {
    return value;
  }

  const sequence = value.nextSequence ?? value.startingSequence;
  if (value.prefix === undefined || sequence === undefined) {
    return value;
  }

  const generatedLength = `${value.prefix}${sequence}`.length;
  if (generatedLength > NIC_DOC_NUMBER_MAX_LENGTH) {
    return helpers.message(
      `Prefix and number together generate a ${generatedLength}-character invoice number, but the GST portal accepts a maximum of ${NIC_DOC_NUMBER_MAX_LENGTH}. Please shorten the prefix or the number.`,
    );
  }
  return value;
};

const createModuleSettings = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      moduleName: Joi.string()
        .required()
        .valid(...Object.values(MODULE_NAMES)),
      prefix: Joi.string().trim(),
      useCustomPrefix: Joi.boolean().default(false),
      startingSequence: Joi.string()
        .pattern(/^[0]*[1-9][0-9]*$/)
        .messages({
          'string.pattern.base': 'Starting sequence must be digits with optional leading zeros',
        })
        .default('00001'),
      nextSequence: Joi.string()
        .pattern(/^[0]*[1-9][0-9]*$/)
        .messages({
          'string.pattern.base': 'Next sequence must be digits with optional leading zeros',
        })
        .default('00001'),
    })
    .custom(enforceNicDocNumberLength),
};

const getModuleSettings = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
    moduleName: Joi.string().valid(...Object.values(MODULE_NAMES)),
  }),
};

const getModuleSettingsByCompanyAndModule = {
  params: Joi.object().keys({
    moduleName: Joi.string()
      .required()
      .valid(...Object.values(MODULE_NAMES)),
  }),
  query: Joi.object().keys({
    customerId: Joi.string().optional().custom(objectId).allow(null),
    companyId: Joi.string().required().custom(objectId),
  }),
};

const updateModuleSettings = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    moduleName: Joi.string()
      .required()
      .valid(...Object.values(MODULE_NAMES)),
  }),
  body: Joi.object()
    .keys({
      prefix: Joi.string().trim(),
      useCustomPrefix: Joi.boolean(),
      startingSequence: Joi.string()
        .pattern(/^[0]*[1-9][0-9]*$/)
        .messages({
          'string.pattern.base': 'Starting sequence must be digits with optional leading zeros',
        }),
      nextSequence: Joi.string()
        .pattern(/^[0]*[1-9][0-9]*$/)
        .messages({
          'string.pattern.base': 'Next sequence must be digits with optional leading zeros',
        }),
      termsandConditions: Joi.string().trim().allow(null, '').optional(),
    })
    .min(1)
    .custom(enforceNicDocNumberLength),
};

const deleteModuleSettings = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    moduleName: Joi.string()
      .required()
      .valid(...Object.values(MODULE_NAMES)),
  }),
};

module.exports = {
  createModuleSettings,
  getModuleSettings,
  getModuleSettingsByCompanyAndModule,
  updateModuleSettings,
  deleteModuleSettings,
};
