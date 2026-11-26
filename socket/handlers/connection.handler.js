const logger = require('../../config/logger');
const wsRegistry = require('../../utils/websocket');
const { authenticateSocketConnection } = require('../utils/socket.auth');

const connectionHandler = async (ws, req) => {
  try {
    const { user } = await authenticateSocketConnection(req);

    ws.userId = user._id.toString();
    ws.userType = user.userType;
    wsRegistry.addClient(ws.userId, ws);
    logger.info(`WebSocket client connected — userId: ${ws.userId}, userType: ${ws.userType}`);

    ws.on('close', () => {
      wsRegistry.removeClient(ws.userId, ws);
      logger.info(`WebSocket client disconnected — userId: ${ws.userId}, userType: ${ws.userType}`);
    });

    ws.on('error', err => {
      logger.error(`WebSocket error — userId: ${ws.userId}, userType: ${ws.userType}`, err.message);
      wsRegistry.removeClient(ws.userId, ws);
    });
  } catch (err) {
    logger.error('WebSocket connection error:', err.message);
    ws.close(err.closeCode || 1011, err.message || 'Internal server error');
  }
};

module.exports = connectionHandler;
