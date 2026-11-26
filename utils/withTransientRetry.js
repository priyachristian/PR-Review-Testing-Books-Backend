const logger = require('../config/logger');
const { TRANSACTION_RETRY } = require('./enum');
const { runWithUploadContext } = require('./uploadContext');
const { listUploadedUrls, clearUploads } = require('./uploadLedger');
const { deleteFilesFromS3 } = require('../modules/commonModule/fileUpload/fileUploadS3.service');

const TRANSIENT_LABEL = 'TransientTransactionError';

const isTransient = error => typeof error?.hasErrorLabel === 'function' && error.hasErrorLabel(TRANSIENT_LABEL);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Removes the S3 files uploaded during a failed call. Skipped when a transaction committed, because the saved
 * document may already reference those files. Never throws.
 */
const cleanupUploads = async context => {
  try {
    if (!context.committed) {
      const ledgerUrls = await listUploadedUrls(context.id);
      const urls = [...new Set([...ledgerUrls, ...context.uploaded])];
      if (urls.length > 0) {
        await deleteFilesFromS3(urls);
      }
    }
  } catch (error) {
    logger.error(`Upload cleanup failed: ${error.message}`);
  } finally {
    await clearUploads(context.id);
  }
};

/**
 * Wraps an async function that owns its own Mongo transaction and re-runs it when MongoDB reports a
 * TransientTransactionError (for example WriteConflict when two requests touch the same document).
 * The wrapped function must open, commit and abort its own session on every call.
 *
 * - Retries stop once a transaction committed, so a late transient error cannot create a duplicate document.
 * - Files uploaded by earlier attempts are reused through the Redis upload ledger instead of being uploaded again.
 * - When the call finally fails before any commit, the files it uploaded are deleted. The ledger key always expires
 *   after UPLOAD_LEDGER.TTL_SECONDS, even if the process dies mid call.
 */
function withTransientRetry(fn) {
  const wrapped = function (...args) {
    return runWithUploadContext(async context => {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await fn.apply(this, args);
          await clearUploads(context.id);
          return result;
        } catch (error) {
          const canRetry = isTransient(error) && !context.committed && attempt < TRANSACTION_RETRY.MAX_ATTEMPTS;
          if (!canRetry) {
            await cleanupUploads(context);
            throw error;
          }
          logger.warn(
            `Transient transaction error in ${fn.name || 'anonymous'}, retry ${attempt}/${TRANSACTION_RETRY.MAX_ATTEMPTS - 1}`,
          );
          await sleep(TRANSACTION_RETRY.BASE_DELAY_MS * attempt + Math.floor(Math.random() * TRANSACTION_RETRY.JITTER_MS));
        }
      }
    });
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  return wrapped;
}

module.exports = { withTransientRetry };
