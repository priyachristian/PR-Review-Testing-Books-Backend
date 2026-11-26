'use strict';

const wsRegistry = require('../../utils/websocket');

const transformNotification = doc => {
  const obj = doc.toObject ? doc.toObject() : doc;
  return {
    id: obj._id?.toString() || '',
    type: obj.type || '',
    title: obj.title || '',
    body: obj.body || '',
    module: obj.module || null,
    actionId: obj.actionId?.toString() || null,
    data: obj.data ?? {},
    isRead: obj.isRead ?? false,
    readAt: obj.readAt ? obj.readAt.toISOString() : null,
    createdAt: obj.createdAt ? obj.createdAt.toISOString() : '',
  };
};

const emitNotificationToUser = (userId, notificationDoc) => {
  const uid = userId.toString();
  const notification = transformNotification(notificationDoc);

  wsRegistry.sendToUser(uid, { type: `NOTIFICATION_NEW-${uid}`, notification });
};

module.exports = { emitNotificationToUser };
