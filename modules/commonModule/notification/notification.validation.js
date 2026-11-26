const Joi = require('joi');

const { commonSchemas } = require('../../../validations/common.validation');

const getNotificationCount = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
};

const getNotifications = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    isRead: Joi.boolean().optional(),
    page: Joi.number().integer().min(1).optional().default(1),
    limit: Joi.number().integer().min(1).max(100).optional().default(10),
  }),
};

const getNotificationPreference = {
  query: Joi.object().keys({
    deviceId: commonSchemas.string({ label: 'Device ID', isRequired: true }),
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: false }),
  }),
};

const updateNotificationPreference = {
  body: Joi.object().keys({
    isNotificationEnabled: Joi.boolean().required(),
    deviceId: commonSchemas.string({ label: 'Device ID', isRequired: true }),
  }),
};

module.exports = {
  getNotificationCount,
  getNotifications,
  getNotificationPreference,
  updateNotificationPreference,
};
