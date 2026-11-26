const express = require('express');
const notificationValidation = require('./notification.validation');
const notificationController = require('./notification.controller');
const validate = require('../../../middlewares/validate');

const router = express.Router();

router.get('/count', validate(notificationValidation.getNotificationCount), notificationController.getNotificationCount);
router.get(
  '/preference',
  validate(notificationValidation.getNotificationPreference),
  notificationController.getNotificationPreference,
);
router.patch(
  '/preference',
  validate(notificationValidation.updateNotificationPreference),
  notificationController.updateNotificationPreference,
);
router.get('/', validate(notificationValidation.getNotifications), notificationController.getNotifications);
router.patch('/read-all', notificationController.markAllAsRead);

module.exports = router;
