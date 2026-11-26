const crypto = require('crypto');
const redis = require('../../../config/redis-client');
const exportConfig = require('../../../config/documentPdfExport.config');

const TOKEN_PREFIX = 'document-export:download:';
const JOB_TOKEN_PREFIX = 'document-export:job-token:';

const ttlSeconds = () => Math.max(60, (exportConfig.DOWNLOAD_TOKEN_TTL_HOURS || 2) * 3600);

const createDownloadToken = async ({ jobId, companyId, fileName }) => {
  const token = crypto.randomBytes(32).toString('hex');
  const payload = JSON.stringify({
    jobId: String(jobId),
    companyId: String(companyId),
    fileName: fileName?.endsWith('.pdf') ? fileName : `${fileName || 'Documents_Export'}.pdf`,
  });

  const ttl = ttlSeconds();
  const prev = await redis.get(`${JOB_TOKEN_PREFIX}${jobId}`);
  if (prev) {
    await redis.del(`${TOKEN_PREFIX}${prev}`);
  }

  await redis.setex(`${TOKEN_PREFIX}${token}`, ttl, payload);
  await redis.setex(`${JOB_TOKEN_PREFIX}${jobId}`, ttl, token);
  return token;
};

const peekDownloadToken = async token => {
  if (!token) return null;
  const raw = await redis.get(`${TOKEN_PREFIX}${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const consumeDownloadToken = async token => {
  if (!token) return null;

  let raw;
  if (typeof redis.getdel === 'function') {
    raw = await redis.getdel(`${TOKEN_PREFIX}${token}`);
  } else {
    raw = await redis.get(`${TOKEN_PREFIX}${token}`);
    if (raw) await redis.del(`${TOKEN_PREFIX}${token}`);
  }

  if (!raw) return null;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  if (payload?.jobId) {
    const mapped = await redis.get(`${JOB_TOKEN_PREFIX}${payload.jobId}`);
    if (mapped === token) {
      await redis.del(`${JOB_TOKEN_PREFIX}${payload.jobId}`);
    }
  }

  return payload;
};

const revokeJobDownloadToken = async jobId => {
  const token = await redis.get(`${JOB_TOKEN_PREFIX}${jobId}`);
  if (token) {
    await redis.del(`${TOKEN_PREFIX}${token}`);
  }
  await redis.del(`${JOB_TOKEN_PREFIX}${jobId}`);
};

module.exports = {
  createDownloadToken,
  peekDownloadToken,
  consumeDownloadToken,
  revokeJobDownloadToken,
};
