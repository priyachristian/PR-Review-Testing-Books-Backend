const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const helmet = require('helmet');
const config = require('./config');

const BULL_BOARD_PATH = '/admin/queues';

const setupBullBoard = (app, queues = []) => {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  createBullBoard({
    queues: queues.map(q => new BullMQAdapter(q)),
    serverAdapter,
  });

  const username = config.bullBoard.username || 'admin';
  const password = config.bullBoard.password || 'admin123';

  const basicAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const user = decoded.slice(0, colonIdx);
        const pass = decoded.slice(colonIdx + 1);
        if (user === username && pass === password) return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.status(401).send('Unauthorized – Bull Board');
  };

  app.use(BULL_BOARD_PATH, helmet({ contentSecurityPolicy: false }), basicAuth, serverAdapter.getRouter());

  console.log(`[BullBoard] 📊 Dashboard mounted at ${BULL_BOARD_PATH}`);
  return serverAdapter;
};

module.exports = { setupBullBoard, BULL_BOARD_PATH };
