const httpStatus = require('http-status');

const catchAsync = require('../../../utils/catchAsync');
const pick = require('../../../utils/pick');
const notificationService = require('./notification.service');
const { successResponse } = require('../../../services/response.service');
const { NOTIFICATION_MESSAGES } = require('../../../utils/messages');

const getNotificationCount = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const { companyId } = req.query;
    const result = await notificationService.getNotificationCount({ userId, companyId });
    return successResponse(res, result, NOTIFICATION_MESSAGES.FETCH_COUNT_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getNotificationCount',
    controller: 'notification',
    failureMessage: NOTIFICATION_MESSAGES.FETCH_COUNT_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getNotifications = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const { companyId } = req.query;
    const opts = pick(req.query, ['isRead', 'page', 'limit']);

    const result = await notificationService.getNotifications({ userId, companyId, ...opts });

    return successResponse(res, result.results, NOTIFICATION_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {
      pagination: {
        page: result.page,
        limit: result.limit,
        totalResults: result.totalResults,
        totalPages: result.totalPages,
      },
    });
  },
  {
    service: 'getNotifications',
    controller: 'notification',
    failureMessage: NOTIFICATION_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const markAllAsRead = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const { companyId } = req.query;
    await notificationService.markAllNotificationsAsRead({ userId, companyId });
    return successResponse(res, null, NOTIFICATION_MESSAGES.MARK_ALL_READ_SUCCESS, httpStatus.OK);
  },
  {
    service: 'markAllAsRead',
    controller: 'notification',
    failureMessage: NOTIFICATION_MESSAGES.MARK_ALL_READ_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getNotificationPreference = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const result = await notificationService.getNotificationPreference({ userId, deviceId: req.query.deviceId });
    return successResponse(res, result, NOTIFICATION_MESSAGES.GET_PREFERENCE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getNotificationPreference',
    controller: 'notification',
    failureMessage: NOTIFICATION_MESSAGES.GET_PREFERENCE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateNotificationPreference = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const { isNotificationEnabled, deviceId } = req.body;
    const result = await notificationService.updateNotificationPreference({ userId, deviceId, isNotificationEnabled });
    return successResponse(res, result, NOTIFICATION_MESSAGES.UPDATE_PREFERENCE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateNotificationPreference',
    controller: 'notification',
    failureMessage: NOTIFICATION_MESSAGES.UPDATE_PREFERENCE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  getNotificationCount,
  getNotifications,
  markAllAsRead,
  getNotificationPreference,
  updateNotificationPreference,
};
