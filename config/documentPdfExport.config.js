module.exports = {
  ASYNC_HARD_MAX: 500,
  BATCH_SIZE: 10,
  BATCH_RETRY_ATTEMPTS: 1,
  EXPORT_TTL_HOURS: 24,
  DOWNLOAD_TOKEN_TTL_HOURS: 2,
  DOWNLOAD_WAIT_MS: 2 * 60 * 60 * 1000,
  // Redis lock TTL for the one active export per user. A crashed worker stops blocking
  // the next export when this expires. Finished BullMQ jobs are removed after EXPORT_TTL_HOURS.
  STALE_PROCESSING_MINUTES: 180,
  TEMP_DIR: process.env.DOCUMENT_EXPORT_TEMP_DIR || null,
  QUEUE_NAME: 'document-pdf-export',
  ERROR_CODES: {
    EXPORT_LIMIT_EXCEEDED: 'EXPORT_LIMIT_EXCEEDED',
    EXPORT_JOB_IN_PROGRESS: 'EXPORT_JOB_IN_PROGRESS',
    EXPORT_DOWNLOAD_INVALID: 'EXPORT_DOWNLOAD_INVALID',
  },
};
