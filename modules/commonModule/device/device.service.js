const mongoose = require('mongoose');

const { getCommonModels } = require('../../../services/model.service');

const USER_TYPE = 'User';

const storeDeviceToken = async (userId, deviceData) => {
  const { pushToken, platform, deviceId, deviceName, deviceModel, os, osVersion, appVersion } = deviceData;

  const { Device } = getCommonModels();

  const filter = {
    userId: new mongoose.Types.ObjectId(userId),
    deviceId,
  };

  const now = new Date();

  // A push token belongs to the browser, so detach it from any other user who used this browser before.
  await Device.updateMany(
    { pushToken, userId: { $ne: new mongoose.Types.ObjectId(userId) } },
    { $set: { isActive: false, pushToken: null } },
  );

  const setPayload = {
    pushToken,
    platform,
    isActive: true,
    lastActiveAt: now,
    ...(deviceName !== undefined && { deviceName }),
    ...(deviceModel !== undefined && { deviceModel }),
    ...(os !== undefined && { os }),
    ...(osVersion !== undefined && { osVersion }),
    ...(appVersion !== undefined && { appVersion }),
  };

  const device = await Device.findOneAndUpdate(
    filter,
    {
      $set: setPayload,
      $setOnInsert: {
        userId: new mongoose.Types.ObjectId(userId),
        deviceId,
        userType: USER_TYPE,
        isNotificationEnabled: true,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
    },
  );

  return device;
};

module.exports = {
  storeDeviceToken,
};
