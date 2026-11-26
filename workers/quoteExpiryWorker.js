const { Worker } = require('bullmq');
const connection = require('../config/bullmq-connection');
const logger = require('../config/logger');

let workerInstance = null;

const startQuoteExpiryWorker = () => {
  const { runQuoteExpiryCron } = require('../cronJobs/quoteExpiryCronJob');

  workerInstance = new Worker(
    'quote-expiry',
    async job => {
      logger.info(`[BullMQ Worker] Processing quote-expiry job id=${job.id}`);
      await runQuoteExpiryCron();
      logger.info(`[BullMQ Worker] Finished quote-expiry job id=${job.id}`);
    },
    {
      connection,
      concurrency: 1,
    },
  );

  workerInstance.on('completed', job => {
    logger.info(`[BullMQ Worker] Completed quote-expiry job id=${job.id}`);
  });

  workerInstance.on('failed', (job, err) => {
    logger.error(`[BullMQ Worker] Failed quote-expiry job id=${job?.id}: ${err?.stack || err?.message || err}`);
  });

  workerInstance.on('error', err => {
    logger.error(`[BullMQ Worker] quote-expiry worker error: ${err.message}`);
  });

  logger.info('[BullMQ Worker] quoteExpiryWorker started');
  return workerInstance;
};

const stopQuoteExpiryWorker = async () => {
  if (workerInstance) {
    await workerInstance.close();
    logger.info('[BullMQ Worker] quoteExpiryWorker closed');
  }
};

module.exports = { startQuoteExpiryWorker, stopQuoteExpiryWorker };
