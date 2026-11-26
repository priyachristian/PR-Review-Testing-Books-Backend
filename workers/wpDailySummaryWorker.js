const { Worker } = require('bullmq');
const connection = require('../config/bullmq-connection');
const logger = require('../config/logger');

let workerInstance = null;

const startWpDailySummaryWorker = () => {
  const { runWpSummaryCron } = require('../cronJobs/wpDailySummaryCronJob');

  workerInstance = new Worker(
    'wp-daily-summary',
    async job => {
      logger.info(`[BullMQ Worker] Processing wp-daily-summary job id=${job.id}`);
      await runWpSummaryCron();
      logger.info(`[BullMQ Worker] Finished wp-daily-summary job id=${job.id}`);
    },
    {
      connection,
      concurrency: 1,
    },
  );

  workerInstance.on('completed', job => {
    logger.info(`[BullMQ Worker] Completed wp-daily-summary job id=${job.id}`);
  });

  workerInstance.on('failed', (job, err) => {
    logger.error(`[BullMQ Worker] Failed wp-daily-summary job id=${job?.id}: ${err.message}`);
  });

  workerInstance.on('error', err => {
    logger.error(`[BullMQ Worker] wp-daily-summary worker error: ${err.message}`);
  });

  logger.info('[BullMQ Worker] wpDailySummaryWorker started');
  return workerInstance;
};

const stopWpDailySummaryWorker = async () => {
  if (workerInstance) {
    await workerInstance.close();
    logger.info('[BullMQ Worker] wpDailySummaryWorker closed');
  }
};

module.exports = { startWpDailySummaryWorker, stopWpDailySummaryWorker };
