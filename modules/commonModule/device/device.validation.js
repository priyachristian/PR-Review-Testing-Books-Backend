const Joi = require('joi');
const { PLATFORMS } = require('@smit9313/abss-models-core/src/utils/enum');

const { commonSchemas } = require('../../../validations/common.validation');

const storeDeviceToken = {
  body: Joi.object().keys({
    pushToken: Joi.string().trim().required().label('Push Token'),
    platform: Joi.string()
      .valid(...Object.values(PLATFORMS))
      .required()
      .label('Platform'),
    deviceId: Joi.string().trim().required().label('Device ID'),
    deviceName: commonSchemas.string({ label: 'Device Name', isOptional: true }),
    deviceModel: commonSchemas.string({ label: 'Device Model', isOptional: true }),
    os: commonSchemas.string({ label: 'OS', isOptional: true }),
    osVersion: commonSchemas.string({ label: 'OS Version', isOptional: true }),
    appVersion: commonSchemas.string({ label: 'App Version', isOptional: true }),
  }),
};

module.exports = {
  storeDeviceToken,
};
