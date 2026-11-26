const mongoose = require('mongoose');
const httpStatus = require('http-status');

const { getBooksModels, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');

const getNotificationCount = async ({ userId, companyId }) => {
  const { Notification } = getBooksModels();

  const count = await Notification.countDocuments({
    userId: new mongoose.Types.ObjectId(userId),
    companyId: new mongoose.Types.ObjectId(companyId),
    isRead: false,
  });

  return { count };
};

const getNotifications = async ({ userId, companyId, page = 1, limit = 10, isRead }) => {
  const { Notification } = getBooksModels();

  const filter = {
    userId: new mongoose.Types.ObjectId(userId),
    companyId: new mongoose.Types.ObjectId(companyId),
  };

  if (isRead !== undefined && isRead !== null) {
    filter.isRead = isRead;
  }

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 10;
  const skip = (pageNum - 1) * limitNum;

  const [docs, totalResults] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
    Notification.countDocuments(filter),
  ]);

  const results = docs.map(({ _id, __v, ...doc }) => ({
    ...doc,
    id: _id.toString(),
  }));

  const totalPages = Math.ceil(totalResults / limitNum) || 1;

  return { results, totalResults, page: pageNum, limit: limitNum, totalPages };
};

const markAllNotificationsAsRead = async ({ userId, companyId }) => {
  const { Notification } = getBooksModels();

  await Notification.updateMany(
    {
      userId: new mongoose.Types.ObjectId(userId),
      companyId: new mongoose.Types.ObjectId(companyId),
      isRead: false,
    },
    {
      $set: {
        isRead: true,
        readAt: new Date(),
      },
    },
  );
};

const getNotificationPreference = async ({ userId, deviceId }) => {
  const { Device } = getCommonModels();
  const device = await Device.findOne({ userId: new mongoose.Types.ObjectId(userId), deviceId })
    .select('isNotificationEnabled')
    .lean();
  if (!device) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Device not found');
  }
  return { isNotificationEnabled: device?.isNotificationEnabled ?? false };
};

const updateNotificationPreference = async ({ userId, deviceId, isNotificationEnabled }) => {
  const { Device } = getCommonModels();
  const device = await Device.findOne({ userId: new mongoose.Types.ObjectId(userId), deviceId });
  if (!device) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Device not found');
  }
  device.isNotificationEnabled = isNotificationEnabled;
  await device.save();
  return { isNotificationEnabled: device.isNotificationEnabled };
};

module.exports = {
  getNotificationCount,
  getNotifications,
  markAllNotificationsAsRead,
  getNotificationPreference,
  updateNotificationPreference,
};
