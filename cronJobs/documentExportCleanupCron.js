const cron = require('node-cron');
const logger = require('../config/logger');
const { cleanupExpiredExports } = require('../modules/commonModule/documentExport/documentExport.service');

const startDocumentExportCleanupCron = () => {
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await cleanupExpiredExports();
      if (result?.cleaned) {
        logger.info(`[DocumentExportCleanup] cleaned ${result.cleaned} file(s)`);
      }
    } catch (err) {
      logger.error(`[DocumentExportCleanup] failed: ${err.message}`);
    }
  });

  logger.info('[DocumentExportCleanup] cron scheduled (hourly)');
};

module.exports = startDocumentExportCleanupCron;
