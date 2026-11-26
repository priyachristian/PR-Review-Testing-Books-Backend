const WebSocket = require('ws');
const Redis = require('ioredis');
const config = require('../config/config');
const logger = require('../config/logger');

const WS_CHANNEL = 'ws:messages';

const clients = new Map();

let publisher = null;
let subscriber = null;

const makeRedisClient = () =>
  new Redis({
    host: config.redis.host,
    port: config.redis.port,
    username: config.redis.username,
    password: config.redis.password,
    retryStrategy: times => Math.min(times * 200, 2000),
    enableOfflineQueue: false,
  });

const initPubSub = () => {
  publisher = makeRedisClient();
  subscriber = makeRedisClient();

  subscriber.on('ready', () => {
    subscriber.subscribe(WS_CHANNEL, err => {
      if (err) logger.error('[WS] Redis subscribe error:', err.message);
      else logger.info(`[WS] instance ${process.env.NODE_APP_INSTANCE ?? 'local'} subscribed to ${WS_CHANNEL}`);
    });
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== WS_CHANNEL) return;
    try {
      const { type, userId, data } = JSON.parse(raw);
      if (type === 'user') deliverLocal(userId, data);
      else if (type === 'broadcast') broadcastLocal(data);
    } catch (err) {
      logger.error('[WS] Bad pub/sub message:', err.message);
    }
  });
};

const deliverLocal = (userId, data) => {
  const connections = clients.get(userId.toString());
  if (!connections?.size) return;
  const payload = JSON.stringify(data);
  connections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
};

const broadcastLocal = data => {
  const payload = JSON.stringify(data);
  clients.forEach(connections => {
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  });
};

const addClient = (userId, ws) => {
  const key = userId.toString();
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(ws);
};

const removeClient = (userId, ws) => {
  const key = userId.toString();
  const connections = clients.get(key);
  if (!connections) return;
  connections.delete(ws);
  if (connections.size === 0) clients.delete(key);
};

const sendToUser = (userId, data) => {
  if (!publisher) return deliverLocal(userId, data);
  publisher.publish(WS_CHANNEL, JSON.stringify({ type: 'user', userId: userId.toString(), data })).catch(() => {});
};

const broadcast = data => {
  if (!publisher) return broadcastLocal(data);
  publisher.publish(WS_CHANNEL, JSON.stringify({ type: 'broadcast', data })).catch(() => {});
};

const getConnectedUserIds = () => [...clients.keys()];

const closePubSub = async () => {
  try {
    if (subscriber) await subscriber.quit().catch(() => {});
    if (publisher) await publisher.quit().catch(() => {});
  } catch (_) {}
};

module.exports = {
  initPubSub,
  closePubSub,
  addClient,
  removeClient,
  sendToUser,
  broadcast,
  getConnectedUserIds,
};
