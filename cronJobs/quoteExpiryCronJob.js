const cron = require('node-cron');
const { QUOTE_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const { createQueue } = require('../config/queueConfig');
const logger = require('../config/logger');

// Only a sent quote has a validity period that can lapse; the history message below names this same status.
const EXPIRES_FROM = QUOTE_STATUS.SENT;

let Quote = null;

const runQuoteExpiryCron = async () => {
  const todayDate = new Date();
  todayDate.setUTCHours(0, 0, 0, 0);

  // Single idempotent update; each document write is atomic, so no transaction is needed. The history entry
  // matches what quote.service updateStatus records, so an expired quote still explains itself on its detail page.
  const result = await Quote.updateMany(
    {
      expiryDate: { $lt: todayDate },
      status: { $in: [EXPIRES_FROM] },
    },
    {
      $set: { status: QUOTE_STATUS.EXPIRED },
      $push: {
        commentHistory: {
          message: `Quote status changed from ${EXPIRES_FROM} to ${QUOTE_STATUS.EXPIRED}`,
          createdAt: new Date(),
        },
      },
    },
  );

  logger.info(`[Quote Expiry] Expired ${result.modifiedCount} quotes`);
};

const startCron = booksCrmModels => {
  Quote = booksCrmModels.Quote;

  if (!Quote) {
    logger.warn('[Quote Expiry] Quote model is not available — skipping cron');
    return;
  }

  logger.info('[Quote Expiry] Cron initialized (daily at midnight)');

  cron.schedule('0 0 * * *', async () => {
    try {
      const jobId = `quote-expiry-${new Date().toISOString().split('T')[0]}`;
      const job = await createQueue('quote-expiry').add('process-quote-expiry', {}, { jobId });
      logger.debug(`[Cron] Enqueued quote-expiry job id=${job.id}`);
    } catch (err) {
      logger.error(`[Cron] Failed to enqueue quote-expiry job: ${err.message}`);
    }
  });
};

module.exports = startCron;
// Named export used by the BullMQ worker to run the actual logic
module.exports.runQuoteExpiryCron = runQuoteExpiryCron;
