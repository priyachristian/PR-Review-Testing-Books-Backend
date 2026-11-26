const config = require('./config');

const bullmqConnection = {
  host: config.redis.host,
  port: config.redis.port,
  username: config.redis.username,
  password: config.redis.password,
};

module.exports = bullmqConnection;
