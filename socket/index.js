const WebSocket = require('ws');

const logger = require('../config/logger');
const connectionHandler = require('./handlers/connection.handler');

const setupSocket = (server, app) => {
  const wss = new WebSocket.Server({ server });

  app.locals.wss = wss;

  wss.on('connection', (ws, req) => connectionHandler(ws, req));

  logger.info('WebSocket server initialised');
};

module.exports = setupSocket;
