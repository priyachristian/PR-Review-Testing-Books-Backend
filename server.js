require('newrelic');
const app = require('./app');
const config = require('./config/config');
const logger = require('./config/logger');
const { getModelsAndConnections } = require('@smit9313/abss-models-core');
const modelService = require('./services/model.service');
const setupSocket = require('./socket');
const wsRegistry = require('./utils/websocket');
const startInvoiceCron = require('./cronJobs/recurringInvoiceCronJob');
const startBillCron = require('./cronJobs/recurringBillCronJob');
const startExpenseCron = require('./cronJobs/recurringExpenseCronJob');
const invoiceAndBillDueCron = require('./cronJobs/invoiceAndBillCron');
const { startRecurringBillWorker, stopRecurringBillWorker } = require('./workers/recurringBillWorker');
const { startInvoiceAndBillWorker, stopInvoiceAndBillWorker } = require('./workers/invoiceAndBillWorker');
const { startRecurringExpenseWorker, stopRecurringExpenseWorker } = require('./workers/recurringExpenseWorker');
const { startRecurringInvoiceWorker, stopRecurringInvoiceWorker } = require('./workers/recurringInvoiceWorker');
const startQuoteExpiryCron = require('./cronJobs/quoteExpiryCronJob');
const { startQuoteExpiryWorker, stopQuoteExpiryWorker } = require('./workers/quoteExpiryWorker');
const startWpDailySummaryCron = require('./cronJobs/wpDailySummaryCronJob');
const { startWpDailySummaryWorker, stopWpDailySummaryWorker } = require('./workers/wpDailySummaryWorker');
const { startModuleEmailWorker, stopModuleEmailWorker } = require('./workers/moduleEmailWorker');
const { startDocumentPdfExportWorker, stopDocumentPdfExportWorker } = require('./workers/documentPdfExportWorker');
const startDocumentExportCleanupCron = require('./cronJobs/documentExportCleanupCron');

let server;

// In PM2 cluster mode NODE_APP_INSTANCE is set to "0", "1", "2"...
// Crons and BullMQ workers must only run in one process to avoid duplicate job processing.
// When not in PM2 (e.g. local dev) the env var is absent, so workers run normally.
const isWorkerInstance = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';

// Initialize database connections and models
const initializeDatabases = async () => {
  try {
    // Use useDb for each database
    const { models, connections } = await getModelsAndConnections(config.mongoose.db_names);
    const commonConn = connections.common;
    const booksCrmConn = connections['books-crm'];
    const booksConn = connections.books;
    const crmConn = connections.crm;
    const abssAdminConn = connections['abss-admin'];
    const connection = connections.rawConnection;
    // Initialize models for each database

    const commonModels = models['common'];
    const booksCrmModels = models['books-crm'];
    const booksModels = models['books'];
    const crmModels = models['crm'];

    const abssAdminModels = models['abss-admin'];
    logger.info(
      `Connected to MongoDB databases: common (${commonConn.name}), books-crm (${booksCrmConn.name}), books (${booksConn.name})`,
      `Connected to MongoDB databases: common (${commonConn.name}), books-crm (${booksCrmConn.name}), books (${booksConn.name})`,
    );

    return {
      commonConn,
      booksCrmConn,
      booksConn,
      crmConn,
      commonModels,
      booksCrmModels,
      booksModels,
      crmModels,
      connection,
      abssAdminConn,
      abssAdminModels,
    };
  } catch (error) {
    logger.error('Failed to initialize databases:', error);
    throw error;
  }
};

// Start the server
const startServer = async () => {
  try {
    // Initialize databases and models
    const {
      connection,
      commonConn,
      booksCrmConn,
      booksConn,
      crmConn,
      abssAdminConn,
      commonModels,
      booksCrmModels,
      booksModels,
      crmModels,
      abssAdminModels,
    } = await initializeDatabases();

    // Make models and connections available to routes
    app.locals.db = {
      connections: { common: commonConn, booksCrm: booksCrmConn, books: booksConn, crm: crmConn, abssAdmin: abssAdminConn },
      models: { common: commonModels, booksCrm: booksCrmModels, books: booksModels, crm: crmModels, abssAdmin: abssAdminModels },
      connection,
    };

    modelService.setApp(app);

    if (isWorkerInstance) {
      startInvoiceCron(booksModels, booksCrmModels, commonModels);
      startRecurringInvoiceWorker();
      startBillCron(booksModels, booksCrmModels, commonModels);
      startRecurringBillWorker();
      startExpenseCron(booksModels, booksCrmModels, commonModels);
      startRecurringExpenseWorker();
      invoiceAndBillDueCron(booksModels);
      startInvoiceAndBillWorker();
      startQuoteExpiryCron(booksCrmModels);
      startQuoteExpiryWorker();
      startWpDailySummaryCron();
      startWpDailySummaryWorker();
      startModuleEmailWorker();
      startDocumentPdfExportWorker();
      startDocumentExportCleanupCron();
      logger.info(`Workers and crons started on instance ${process.env.NODE_APP_INSTANCE ?? 'local'}`);
    } else {
      logger.info(`Instance ${process.env.NODE_APP_INSTANCE}: skipping workers/crons (handled by instance 0)`);
    }

    // Start Express server
    server = app.listen(config.port, () => {
      logger.info(`Listening to port ${config.port} in ${config.env} mode`);
      // Signal PM2 that this worker is ready to receive traffic.
      // PM2 only routes requests here after this signal (requires wait_ready: true
      // in ecosystem.config.js). Without it, PM2 may send traffic before DB is up.
      if (process.send) process.send('ready');
    });

    // Attach WebSocket server to the same HTTP server instance
    setupSocket(server, app);

    wsRegistry.initPubSub();
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle server shutdown (close Redis, HTTP server, DBs so process can exit)
const exitHandler = async () => {
  const closeRedis = async () => {
    try {
      if (isWorkerInstance) {
        await stopRecurringBillWorker();
        await stopRecurringInvoiceWorker();
        await stopRecurringExpenseWorker();
        await stopInvoiceAndBillWorker();
        await stopQuoteExpiryWorker();
        await stopWpDailySummaryWorker();
        await stopModuleEmailWorker();
        await stopDocumentPdfExportWorker();
      }
      await wsRegistry.closePubSub();
      const redis = require('./config/redis-client');
      await Promise.race([redis.quit(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
      logger.info('Redis connection closed');
    } catch (err) {
      if (err.message !== 'timeout') logger.error('Error closing Redis:', err?.message || err);
    }
  };

  const closeMongo = async () => {
    if (app.locals.db?.connections) {
      try {
        const { common, booksCrm, books, crm, abssAdmin } = app.locals.db.connections;
        const toClose = [common, booksCrm, books, crm].filter(Boolean);
        if (abssAdmin) toClose.push(abssAdmin);
        await Promise.all(toClose.map(c => c.close()));
        logger.info('All database connections closed');
      } catch (error) {
        logger.error('Error closing database connections:', error);
      }
    }
  };

  if (server) {
    server.close(async () => {
      logger.info('Server closed');
      await closeRedis();
      await closeMongo();
      process.exit(0);
    });
    // Force exit if server doesn't close within 5s (e.g. keep-alive connections)
    setTimeout(() => {
      logger.info('Forcing exit after timeout');
      process.exit(1);
    }, 5000);
  } else {
    await closeRedis();
    await closeMongo();
    process.exit(0);
  }
};

// Handle unexpected errors
const unexpectedErrorHandler = error => {
  logger.error('Unexpected error:', error);
  exitHandler();
};

// Start the server
startServer();

// Handle process events (SIGINT = Ctrl+C, SIGTERM = stop/kill)
process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);
process.on('SIGINT', () => {
  logger.info('SIGINT received');
  exitHandler();
});
process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  exitHandler();
});
