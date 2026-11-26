const crypto = require('crypto');
const config = require('../config/config');
const httpStatus = require('http-status');
const ApiError = require('./ApiError');
const ENC_ALGO = 'aes-256-gcm';
const ENC_MARKER = '__enc';
const ENC_VERSION = 1;

function getKey() {
  const b64 = config.credentialsEncryptionKey;
  if (!b64) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'CREDENTIALS_ENCRYPTION_KEY is not set');
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64 of 32 bytes)');
  }
  return key;
}

function encryptBuffer(plaintextBuffer) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64'),
  };
}

function decryptBuffer(payload) {
  const key = getKey();
  const ivBuf = Buffer.from(payload.iv, 'base64');
  const tagBuf = Buffer.from(payload.tag, 'base64');
  const ctBuf = Buffer.from(payload.ct, 'base64');
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const plaintext = Buffer.concat([decipher.update(ctBuf), decipher.final()]);
  return plaintext;
}

function encryptLeaf(value) {
  let serialized;
  if (value instanceof Date) {
    serialized = JSON.stringify({ __type: 'Date', value: value.toISOString() });
  } else if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    serialized = JSON.stringify({ __type: 'Primitive', value: value });
  } else {
    serialized = JSON.stringify({ __type: 'JSON', value: value });
  }
  const buf = Buffer.from(serialized, 'utf8');
  const payload = encryptBuffer(buf);
  return {
    [ENC_MARKER]: true,
    v: ENC_VERSION,
    iv: payload.iv,
    tag: payload.tag,
    ct: payload.ct,
  };
}

function decryptLeaf(node) {
  const plaintext = decryptBuffer({ iv: node.iv, tag: node.tag, ct: node.ct }).toString('utf8');
  const parsed = JSON.parse(plaintext);
  if (parsed && parsed.__type === 'Date') return new Date(parsed.value);
  if (parsed && parsed.__type === 'Primitive') return parsed.value;
  if (parsed && parsed.__type === 'JSON') return parsed.value;
  return parsed;
}

function encryptDeep(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return encryptDeep(item);
    });
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    Object.keys(value).forEach(function (k) {
      const v = value[k];
      const isObjectLike = v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
      if (isObjectLike || Array.isArray(v)) {
        out[k] = encryptDeep(v);
      } else {
        out[k] = encryptLeaf(v);
      }
    });
    return out;
  }
  return encryptLeaf(value);
}

function decryptDeep(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return decryptDeep(item);
    });
  }
  if (typeof value === 'object') {
    if (value[ENC_MARKER] === true && value.v === ENC_VERSION && value.iv && value.tag && value.ct) {
      return decryptLeaf(value);
    }
    const out = {};
    Object.keys(value).forEach(function (k) {
      out[k] = decryptDeep(value[k]);
    });
    return out;
  }
  return value;
}

function looksEncrypted(node) {
  return !!(
    node &&
    typeof node === 'object' &&
    node[ENC_MARKER] === true &&
    node.v === ENC_VERSION &&
    node.iv &&
    node.tag &&
    node.ct
  );
}

module.exports = {
  encryptDeep,
  decryptDeep,
  looksEncrypted,
};

// Blob-level helpers to hide entire structure
function encryptBlob(value) {
  // Store whole object/array/primitive as a single encrypted payload,
  // with inner leaves deep-encrypted to avoid plaintext even before blob layer
  const deepEncrypted = encryptDeep(value);
  const serialized = JSON.stringify({ __type: 'Blob', value: deepEncrypted });
  const buf = Buffer.from(serialized, 'utf8');
  const payload = encryptBuffer(buf);
  return {
    [ENC_MARKER]: true,
    v: ENC_VERSION,
    iv: payload.iv,
    tag: payload.tag,
    ct: payload.ct,
  };
}

function decryptBlob(node) {
  if (!node || node[ENC_MARKER] !== true) return node;
  const plaintext = decryptBuffer({ iv: node.iv, tag: node.tag, ct: node.ct }).toString('utf8');
  const parsed = JSON.parse(plaintext);
  if (parsed && parsed.__type === 'Blob') return decryptDeep(parsed.value);
  return decryptDeep(parsed);
}

module.exports.encryptBlob = encryptBlob;
module.exports.decryptBlob = decryptBlob;

// Raw blob helpers (no deep encryption inside the blob) for benchmarking
function encryptBlobRaw(value) {
  const serialized = JSON.stringify({ __type: 'BlobRaw', value: value });
  const buf = Buffer.from(serialized, 'utf8');
  const payload = encryptBuffer(buf);
  return {
    [ENC_MARKER]: true,
    v: ENC_VERSION,
    iv: payload.iv,
    tag: payload.tag,
    ct: payload.ct,
  };
}

function decryptBlobRaw(node) {
  if (!node || node[ENC_MARKER] !== true) return node;
  const plaintext = decryptBuffer({ iv: node.iv, tag: node.tag, ct: node.ct }).toString('utf8');
  const parsed = JSON.parse(plaintext);
  if (parsed && parsed.__type === 'BlobRaw') return parsed.value;
  return parsed;
}

module.exports.encryptBlobRaw = encryptBlobRaw;
module.exports.decryptBlobRaw = decryptBlobRaw;
