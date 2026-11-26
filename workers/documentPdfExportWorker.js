const { Worker } = require('bullmq');
const connection = require('../config/bullmq-connection');
const logger = require('../config/logger');
const exportConfig = require('../config/documentPdfExport.config');
const { processExportJob, handleExportJobFailed } = require('../modules/commonModule/documentExport/documentExport.service');

let workerInstance = null;

const startDocumentPdfExportWorker = () => {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker(
    exportConfig.QUEUE_NAME,
    async job => {
      logger.info(`[BullMQ Worker] Processing ${exportConfig.QUEUE_NAME} job id=${job.id}`);
      return processExportJob(job);
    },
    {
      connection,
      concurrency: 1,
    },
  );

  workerInstance.on('completed', job => {
    logger.info(`[BullMQ Worker] Completed ${exportConfig.QUEUE_NAME} job id=${job.id}`);
  });

  workerInstance.on('failed', async (job, err) => {
    logger.error(`[BullMQ Worker] Failed ${exportConfig.QUEUE_NAME} job id=${job?.id}: ${err.message}`);
    try {
      await handleExportJobFailed(job, err?.message);
    } catch (markErr) {
      logger.error(`[BullMQ Worker] Failed to mark export job failed: ${markErr.message}`);
    }
  });

  workerInstance.on('error', err => {
    logger.error(`[BullMQ Worker] ${exportConfig.QUEUE_NAME} worker error: ${err.message}`);
  });

  logger.info(`[BullMQ Worker] ${exportConfig.QUEUE_NAME} worker started (concurrency=1)`);
  return workerInstance;
};

const stopDocumentPdfExportWorker = async () => {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
    logger.info(`[BullMQ Worker] ${exportConfig.QUEUE_NAME} worker closed`);
  }
};

module.exports = {
  startDocumentPdfExportWorker,
  stopDocumentPdfExportWorker,
};
