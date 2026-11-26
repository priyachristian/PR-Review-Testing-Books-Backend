const crypto = require('crypto');
const config = require('../config/config');
const httpStatus = require('http-status');
const ApiError = require('./ApiError');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const getTransportKey = () => {
  const b64 = config.credentialsTransportKey;
  if (!b64) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'CREDENTIALS_TRANSPORT_KEY is not set');
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'CREDENTIALS_TRANSPORT_KEY must be 32 bytes (base64 of 32 bytes)');
  }
  return key;
};

const encryptForTransport = value => {
  const key = getTransportKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);

  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: payload.toString('base64') };
};

const decryptFromTransport = payload => {
  if (!payload || typeof payload !== 'object' || !payload.iv || !payload.ct) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid encrypted payload');
  }
  const key = getTransportKey();
  try {
    const iv = Buffer.from(payload.iv, 'base64');
    const combined = Buffer.from(payload.ct, 'base64');
    if (combined.length <= TAG_BYTES) {
      throw new Error('ciphertext too short');
    }
    const ciphertext = combined.subarray(0, combined.length - TAG_BYTES);
    const tag = combined.subarray(combined.length - TAG_BYTES);

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (err) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Could not decrypt payload');
  }
};

module.exports = {
  encryptForTransport,
  decryptFromTransport,
};
