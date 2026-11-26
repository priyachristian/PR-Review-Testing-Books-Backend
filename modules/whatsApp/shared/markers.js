const logger = require('../../../config/logger');
const redis = require('../../../config/redis-client');
const { SEND_MARKER_TTL_SECONDS, SUMMARY_STATUS_TTL_SECONDS } = require('./constants');
const { getPeriodKey } = require('./schedule');

const getSendMarkerKey = (companyId, templateKey, summaryType, periodStart) =>
  `wp-summary-sent:${companyId}:${templateKey}:${summaryType}:${getPeriodKey(summaryType, periodStart)}`;

// Atomically claim the send for this company+template+period. Returns true only for the first
// caller (SET NX); every subsequent attempt for the same period returns false, so a
// retried or restarted job never re-sends a summary a company already received.
// Fails open: if Redis is unavailable we still send rather than silently drop summaries.
const claimSummarySend = async (companyId, templateKey, summaryType, periodStart) => {
  const key = getSendMarkerKey(companyId, templateKey, summaryType, periodStart);
  try {
    const claimed = await redis.set(key, Date.now().toString(), 'EX', SEND_MARKER_TTL_SECONDS, 'NX');
    return claimed === 'OK';
  } catch (err) {
    logger.error(`[WP Summary] Redis claim failed for ${key}, proceeding without idempotency guard: ${err.message}`);
    return true;
  }
};

// Release a claim so a genuinely failed send can be retried on the next cron tick.
const releaseSummaryClaim = async (companyId, templateKey, summaryType, periodStart) => {
  const key = getSendMarkerKey(companyId, templateKey, summaryType, periodStart);
  try {
    await redis.del(key);
  } catch (err) {
    logger.error(`[WP Summary] Redis release failed for ${key}: ${err.message}`);
  }
};

const getSummaryStatusKey = companyId => `wp-summary-status:${companyId}`;

const recordSummaryStatus = async (companyId, status) => {
  try {
    await redis.set(getSummaryStatusKey(companyId), JSON.stringify(status), 'EX', SUMMARY_STATUS_TTL_SECONDS);
  } catch (err) {
    logger.error(`[WP Summary] Failed to record status for company ${companyId}: ${err.message}`);
  }
};

const getSummaryStatus = async companyId => {
  try {
    const raw = await redis.get(getSummaryStatusKey(companyId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.error(`[WP Summary] Failed to read status for company ${companyId}: ${err.message}`);
    return null;
  }
};

module.exports = {
  claimSummarySend,
  releaseSummaryClaim,
  recordSummaryStatus,
  getSummaryStatus,
};
