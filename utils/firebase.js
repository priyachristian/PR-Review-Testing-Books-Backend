'use strict';

const logger = require('../config/logger');
const { abssPortal, abssCustomerPortal } = require('../config/firebaseConfig');

const sendPushNotification = async ({ token, title, body, data = {}, portal = 'abss' }) => {
  const app = portal === 'customer' ? abssCustomerPortal : abssPortal;

  const message = {
    token,
    data: { title, body, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  try {
    const messageId = await app.messaging().send(message);
    logger.info(`Push notification sent [${portal}] to token ...${token.slice(-10)} — messageId: ${messageId}`);
    return messageId;
  } catch (error) {
    logger.error(`Failed to send push notification [${portal}]:`, error.message);
    throw error;
  }
};

const INVALID_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

const sendMulticastPushNotification = async ({ tokens, title, body, data = {}, portal = 'abss' }) => {
  if (!tokens || tokens.length === 0) {
    logger.warn('sendMulticastPushNotification called with no tokens');
    return { successCount: 0, failureCount: 0, failedTokens: [], invalidTokens: [] };
  }

  const app = portal === 'customer' ? abssCustomerPortal : abssPortal;

  const message = {
    tokens,
    data: { title, body, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  try {
    const response = await app.messaging().sendEachForMulticast(message);

    const failedTokens = [];
    const invalidTokens = [];
    response.responses.forEach((res, index) => {
      if (!res.success) {
        logger.warn(`Token failed [${portal}] ...${tokens[index].slice(-10)}: ${res.error?.message}`);
        failedTokens.push(tokens[index]);
        if (INVALID_TOKEN_CODES.has(res.error?.code)) {
          invalidTokens.push(tokens[index]);
        }
      }
    });

    logger.info(
      `Multicast push [${portal}] — success: ${response.successCount}, failed: ${response.failureCount}, invalid: ${invalidTokens.length}`,
    );

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      failedTokens,
      invalidTokens,
    };
  } catch (error) {
    logger.error(`Failed to send multicast push notification [${portal}]:`, error.message);
    throw error;
  }
};

const sendTopicPushNotification = async ({ topic, title, body, data = {}, portal = 'abss' }) => {
  const app = portal === 'customer' ? abssCustomerPortal : abssPortal;

  const message = {
    topic,
    data: { title, body, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  try {
    const messageId = await app.messaging().send(message);
    logger.info(`Topic push notification sent [${portal}] to topic "${topic}" — messageId: ${messageId}`);
    return messageId;
  } catch (error) {
    logger.error(`Failed to send topic push notification [${portal}]:`, error.message);
    throw error;
  }
};

const subscribeToTopic = async (tokens, topic, portal = 'abss') => {
  const app = portal === 'customer' ? abssCustomerPortal : abssPortal;
  try {
    const response = await app.messaging().subscribeToTopic(tokens, topic);
    logger.info(`Subscribed ${response.successCount} tokens to topic "${topic}" [${portal}]`);
    return response;
  } catch (error) {
    logger.error(`Failed to subscribe to topic [${portal}]:`, error.message);
    throw error;
  }
};

const unsubscribeFromTopic = async (tokens, topic, portal = 'abss') => {
  const app = portal === 'customer' ? abssCustomerPortal : abssPortal;
  try {
    const response = await app.messaging().unsubscribeFromTopic(tokens, topic);
    logger.info(`Unsubscribed ${response.successCount} tokens from topic "${topic}" [${portal}]`);
    return response;
  } catch (error) {
    logger.error(`Failed to unsubscribe from topic [${portal}]:`, error.message);
    throw error;
  }
};

module.exports = {
  sendPushNotification,
  sendMulticastPushNotification,
  sendTopicPushNotification,
  subscribeToTopic,
  unsubscribeFromTopic,
};
