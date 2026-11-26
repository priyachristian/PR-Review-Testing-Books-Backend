const cron = require('node-cron');
const moment = require('moment-timezone');
const { createQueue } = require('../config/queueConfig');
const logger = require('../config/logger');
const { getBooksModels } = require('../services/model.service');
const { isWhatsAppConfigured } = require('../utils/whatsapp');
const {
  TIMEZONE,
  getCurrentIstMoment,
  getDueSummaryRecipients,
  sendWpSummaryToCompany,
  claimSummarySend,
  releaseSummaryClaim,
  recordSummaryStatus,
} = require('../modules/whatsApp');

const runWpSummaryCron = async () => {
  if (!isWhatsAppConfigured()) {
    logger.warn('[WP Summary] WhatsApp is not configured — skipping cron run');
    return;
  }

  const { AdminSummarySetting } = getBooksModels();
  if (!AdminSummarySetting) {
    logger.warn('[WP Summary] AdminSummarySetting model is not available — skipping cron run');
    return;
  }

  const now = getCurrentIstMoment();
  const recipients = await getDueSummaryRecipients(now);

  if (!recipients.length) {
    logger.debug(`[WP Summary] No summaries due at ${now.format('YYYY-MM-DD HH:mm')} IST`);
    return;
  }

  logger.info(`[WP Summary] Sending ${recipients.length} summaries at ${now.format('YYYY-MM-DD HH:mm')} IST`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const {
    config,
    company,
    phones,
    templateKey,
    summaryType,
    periodStart,
    periodEnd,
    startDate,
    endDate,
    incremental,
  } of recipients) {
    // Claim the send atomically first: a retried or restarted job skips companies that
    // already received this period's summary, so no one is messaged twice.
    const claimed = await claimSummarySend(config.companyId, templateKey, summaryType, periodStart);
    if (!claimed) {
      skipped += 1;
      logger.debug(
        `[WP Summary] Already sent ${templateKey}/${summaryType} to company ${config.companyId} for this period — skipping`,
      );
      continue;
    }

    try {
      await sendWpSummaryToCompany({
        companyId: config.companyId,
        phones,
        templateKey,
        summaryType,
        startDate,
        endDate,
        periodStart,
        periodEnd,
        companyName: company.name,
        incremental,
      });

      sent += 1;
      await recordSummaryStatus(config.companyId, {
        status: 'sent',
        templateKey,
        summaryType,
        at: now.toISOString(),
      });
      logger.info(
        `[WP Summary] Sent ${templateKey}/${summaryType} summary to ${company.name} (${config.companyId}) at ${phones.join(', ')}`,
      );
    } catch (err) {
      failed += 1;
      // Release the claim so a genuine failure retries on the next tick instead of being
      // permanently suppressed for the period.
      await releaseSummaryClaim(config.companyId, templateKey, summaryType, periodStart);
      await recordSummaryStatus(config.companyId, {
        status: 'failed',
        templateKey,
        summaryType,
        at: now.toISOString(),
        error: err.message,
      });
      logger.error(`[WP Summary] Failed ${templateKey}/${summaryType} for company ${config.companyId}: ${err.message}`);
    }
  }

  logger.info(`[WP Summary] Completed — sent: ${sent}, failed: ${failed}, skipped: ${skipped}`);
};

const startCron = () => {
  logger.info('[WP Summary] Cron initialized (checks every minute for daily, weekly, and monthly schedules)');

  cron.schedule('* * * * *', async () => {
    try {
      const jobId = `wp-daily-summary-${moment.tz(TIMEZONE).format('YYYY-MM-DD-HH-mm')}`;
      const job = await createQueue('wp-daily-summary').add('process-wp-daily-summary', {}, { jobId });
      logger.debug(`[Cron] Enqueued wp-daily-summary job id=${job.id}`);
    } catch (err) {
      if (!err.message?.includes('Job already exists')) {
        logger.error(`[Cron] Failed to enqueue wp-daily-summary job: ${err.message}`);
      }
    }
  });
};

module.exports = startCron;
module.exports.runWpSummaryCron = runWpSummaryCron;
