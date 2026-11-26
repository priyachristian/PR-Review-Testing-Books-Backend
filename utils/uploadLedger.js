const crypto = require('crypto');
const redis = require('../config/redis-client');
const logger = require('../config/logger');
const { UPLOAD_LEDGER } = require('./enum');

const ledgerKey = contextId => `${UPLOAD_LEDGER.KEY_PREFIX}${contextId}`;

/**
 * Stable per-file key inside one request: same bytes, name, user and company give the same key,
 * so a retried create finds the url of the first attempt instead of uploading again.
 */
const buildFileKey = (file, userId, companyId) => {
  const digest = crypto
    .createHash('sha1')
    .update(file.buffer || '')
    .digest('hex');
  return `${companyId}:${userId}:${digest}:${file.originalname}`;
};

// Redis is best effort: when it is unavailable uploads behave as before and creates are never blocked.
const getUploadedUrl = async (contextId, fileKey) => {
  try {
    return await redis.hget(ledgerKey(contextId), fileKey);
  } catch (error) {
    logger.warn(`Upload ledger read failed: ${error.message}`);
    return null;
  }
};

const saveUploadedUrl = async (contextId, fileKey, url) => {
  try {
    const key = ledgerKey(contextId);
    await redis.multi().hset(key, fileKey, url).expire(key, UPLOAD_LEDGER.TTL_SECONDS).exec();
  } catch (error) {
    logger.warn(`Upload ledger write failed: ${error.message}`);
  }
};

const listUploadedUrls = async contextId => {
  try {
    return await redis.hvals(ledgerKey(contextId));
  } catch (error) {
    logger.warn(`Upload ledger list failed: ${error.message}`);
    return [];
  }
};

const clearUploads = async contextId => {
  try {
    await redis.del(ledgerKey(contextId));
  } catch (error) {
    logger.warn(`Upload ledger clear failed: ${error.message}`);
  }
};

module.exports = { buildFileKey, getUploadedUrl, saveUploadedUrl, listUploadedUrls, clearUploads };
