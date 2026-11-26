const Redis = require('ioredis');
const config = require('./config');

console.log('[Redis] Initializing connection...');

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  username: config.redis.username,
  password: config.redis.password,
  reconnectOnError: err => {
    console.error('[Redis] Reconnect on error:', err.message);
    return true; // try reconnecting
  },
  retryStrategy: times => {
    const delay = Math.min(times * 200, 2000);
    console.log(`[Redis] Retry attempt ${times}, next in ${delay}ms`);
    return delay;
  },
});

redis.on('connect', () => {
  console.log('[Redis] ✅ Connected');
});

redis.on('ready', () => {
  console.log('[Redis] ⚙️  Ready to accept commands');
});

redis.on('reconnecting', time => {
  console.log(`[Redis] 🔄 Reconnecting after ${time}ms`);
});

redis.on('end', () => {
  console.log('[Redis] 🔚 Connection closed');
});

redis.on('close', () => {
  console.log('[Redis] 🚪 Socket closed');
});

redis.on('error', err => {
  console.error('[Redis] ❌ Error:', err);
});

const versionCheck = async () => {
  try {
    const info = await redis.info('server');
    const versionLine = info.split('\r\n').find(line => line.startsWith('redis_version'));
    console.log('[Redis] Version ->', versionLine);
  } catch (err) {
    console.error('[Redis] Could not fetch version:', err);
  }
};

versionCheck();

module.exports = redis;
