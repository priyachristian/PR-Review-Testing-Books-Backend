const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getCommonModels } = require('../../../services/model.service');
const { encryptBlob, decryptBlob } = require('../../../utils/cryptography');
const { decryptFromTransport, encryptForTransport } = require('../../../utils/transportCrypto');
const logger = require('../../../config/logger');
const { THIRD_PARTY_PROVIDERS } = require('../../../utils/enum');
const { clearFynamicsAuthCache } = require('../../../utils/getFynamicsAuthToken');
const { clearMastersIndiaAuthCache } = require('../../../utils/getMastersIndiaAuthToken');

const CREDENTIAL_FIELDS = ['username', 'password'];

const DEFAULT_PLATFORM = THIRD_PARTY_PROVIDERS.FYNAMICS;

const clearAuthCacheForPlatform = async (companyId, platformName) => {
  if (platformName === THIRD_PARTY_PROVIDERS.MASTERS_INDIA) {
    await clearMastersIndiaAuthCache();
  } else {
    await clearFynamicsAuthCache(companyId);
  }
};

const rejectMastersIndia = platformName => {
  if (platformName === THIRD_PARTY_PROVIDERS.MASTERS_INDIA) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Masters India credentials are managed by ABSS and cannot be edited here.');
  }
};

const toPublicShape = credentials => {
  if (!credentials) return null;
  const decrypted = decryptBlob(credentials.credentialsJson) || {};
  return {
    id: credentials._id,
    companyId: credentials.companyId,
    platformName: credentials.platformName,
    isActive: credentials.isActive,
    username: decrypted.username || '',
    hasPassword: Boolean(decrypted.password),
    createdAt: credentials.createdAt,
    updatedAt: credentials.updatedAt,
  };
};

const readCredentialPayload = body => {
  const raw = body?.payload ? decryptFromTransport(body.payload) : body;
  const picked = {};
  CREDENTIAL_FIELDS.forEach(field => {
    if (raw?.[field] !== undefined && raw?.[field] !== null) {
      picked[field] = String(raw[field]).trim();
    }
  });
  return picked;
};

const getCredentials = async (companyId, platformName = DEFAULT_PLATFORM) => {
  rejectMastersIndia(platformName);
  const { ThirdPartyCredentials } = getCommonModels();
  const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName });
  return toPublicShape(credentials);
};

const getAllCredentials = async companyId => {
  const { ThirdPartyCredentials } = getCommonModels();
  const credentials = await ThirdPartyCredentials.find({
    companyId,
    platformName: { $ne: THIRD_PARTY_PROVIDERS.MASTERS_INDIA },
  }).sort({ createdAt: 1 });
  return credentials.map(toPublicShape);
};

const createCredentials = async (body, companyId, userId, platformName = DEFAULT_PLATFORM) => {
  rejectMastersIndia(platformName);
  const { ThirdPartyCredentials } = getCommonModels();

  const existing = await ThirdPartyCredentials.findOne({ companyId, platformName });
  if (existing) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Credentials already exist for this company. Use update instead.');
  }

  const payload = readCredentialPayload(body);
  if (!payload.username || !payload.password) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Username and password are required');
  }

  const created = await ThirdPartyCredentials.create({
    companyId,
    platformName,
    credentialsJson: encryptBlob(payload),
    createdBy: userId,
  });

  return toPublicShape(created);
};

const updateCredentials = async (body, companyId, userId, platformName = DEFAULT_PLATFORM) => {
  rejectMastersIndia(platformName);
  const { ThirdPartyCredentials } = getCommonModels();

  const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName });
  if (!credentials) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Credentials not found');
  }

  const existing = decryptBlob(credentials.credentialsJson) || {};
  const incoming = readCredentialPayload(body);

  const merged = {
    ...existing,
    ...(incoming.username !== undefined && { username: incoming.username }),
    ...(incoming.password ? { password: incoming.password } : {}),
  };

  if (!merged.username || !merged.password) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Username and password are required');
  }

  credentials.credentialsJson = encryptBlob(merged);
  if (body?.isActive !== undefined) credentials.isActive = body.isActive;
  credentials.updatedBy = userId;
  await credentials.save();

  await clearAuthCacheForPlatform(companyId, platformName);

  return toPublicShape(credentials);
};

const deleteCredentials = async (companyId, platformName = DEFAULT_PLATFORM) => {
  rejectMastersIndia(platformName);
  const { ThirdPartyCredentials } = getCommonModels();
  const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName });
  if (!credentials) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Credentials not found');
  }
  await ThirdPartyCredentials.deleteOne({ _id: credentials._id });
  await clearAuthCacheForPlatform(companyId, platformName);
  return { id: credentials._id };
};

const revealCredentials = async (companyId, userId, platformName = DEFAULT_PLATFORM) => {
  rejectMastersIndia(platformName);
  const { ThirdPartyCredentials } = getCommonModels();
  const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName });
  if (!credentials) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Credentials not found');
  }

  const decrypted = decryptBlob(credentials.credentialsJson) || {};
  if (!decrypted.password) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No password is stored for this company');
  }

  logger.info(
    `${platformName} portal credentials revealed | companyId=${companyId} | userId=${userId} | credentialsId=${credentials._id}`,
  );

  return {
    payload: encryptForTransport({
      username: decrypted.username || '',
      password: decrypted.password,
    }),
  };
};

const getPortalCredentials = async (companyId, platformName = DEFAULT_PLATFORM) => {
  const { ThirdPartyCredentials } = getCommonModels();
  const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName });
  if (!credentials) return null;
  const decrypted = decryptBlob(credentials.credentialsJson) || {};
  return { username: decrypted.username, password: decrypted.password };
};

module.exports = {
  getCredentials,
  getAllCredentials,
  createCredentials,
  updateCredentials,
  deleteCredentials,
  revealCredentials,
  getPortalCredentials,
};
