const axios = require('axios');
const httpStatus = require('http-status');
const config = require('../config/config');
const redis = require('../config/redis-client');
const { ProviderError } = require('../modules/sales/invoice/providers/providerError');
const { classifyError, authFailure } = require('../modules/sales/invoice/providers/errorClassifier');
const { MASTERS_INDIA_ROUTES, buildMastersIndiaUrl } = require('./mastersIndiaApiRoutes');
const { getCommonModels } = require('../services/model.service');
const { encryptBlob } = require('./cryptography');
const { THIRD_PARTY_PROVIDERS } = require('./enum');

const redactAuthToken = body => (body?.token ? { ...body, token: encryptBlob(body.token) } : body);

const TOKEN_TTL_BUFFER_SECONDS = 60;
const AUTH_TOKEN_REDIS_KEY = 'mastersIndia:authToken';

const inflightTokenRequests = new Map();

const singleFlight = (key, fn) => {
  const existing = inflightTokenRequests.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => inflightTokenRequests.delete(key));
  inflightTokenRequests.set(key, promise);
  return promise;
};

const getOrCreateSystemCredentialsId = async companyId => {
  const { ThirdPartyCredentials } = getCommonModels();
  const existing = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA });
  if (existing) return existing._id;
  const created = await ThirdPartyCredentials.create({
    companyId,
    platformName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
    credentialsJson: encryptBlob({ managedBy: 'system' }),
    isActive: true,
  });
  return created._id;
};

const decodeJwtExpiry = token => {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded?.exp || null;
  } catch (err) {
    return null;
  }
};

const mastersIndiaErrorMessage = (error, fallback) => {
  const data = error?.response?.data;
  return data?.error || data?.errorMessage || data?.message || error?.message || fallback;
};

const toPlainHeaders = headers =>
  headers ? { ...(typeof headers.toJSON === 'function' ? headers.toJSON() : headers) } : undefined;

const logAuthApiCall = async ({
  credentialsId,
  userId,
  companyId,
  URL,
  requestPayload,
  responseBody,
  message,
  statusCode,
  responseStatus,
  requestHeader,
  responseHeader,
}) => {
  if (!credentialsId || !companyId) return;
  try {
    const { logApiCall } = require('../modules/sales/invoice/eInvoice.service');
    await logApiCall(
      credentialsId,
      userId,
      companyId,
      URL,
      { ...requestPayload, password: undefined },
      responseBody,
      message,
      statusCode,
      responseStatus,
      { providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA, requestHeader, responseHeader },
    );
  } catch (loggingError) {
    console.error('MASTERS_INDIA_AUTH_LOG_FAILED ==============================> ', loggingError?.message);
  }
};

const loadMastersIndiaAuthToken = async (companyId, { forceRefresh = false, userId } = {}) => {
  if (!forceRefresh) {
    const cached = await redis.get(AUTH_TOKEN_REDIS_KEY);
    if (cached) return cached;
  }

  const { username, password } = config.mastersIndia;
  if (!username || !password) {
    throw authFailure('Masters India credentials are not configured (MASTERS_INDIA_USERNAME/PASSWORD)', {
      httpStatus: httpStatus.INTERNAL_SERVER_ERROR,
    });
  }

  const credentialsId = await getOrCreateSystemCredentialsId(companyId);

  const URL = buildMastersIndiaUrl(MASTERS_INDIA_ROUTES.AUTHENTICATE);
  const requestPayload = { username, password };
  const requestHeader = { 'Content-Type': 'application/json' };

  try {
    const response = await axios.post(URL, requestPayload, { headers: requestHeader });
    const token = response?.data?.token;
    const isSuccess = Boolean(token);

    await logAuthApiCall({
      credentialsId,
      userId,
      companyId,
      URL,
      requestPayload,
      responseBody: redactAuthToken(response?.data),
      message: isSuccess ? 'Masters India authentication successful' : 'Masters India authentication failed',
      statusCode: response?.status,
      responseStatus: isSuccess ? '1' : '0',
      requestHeader,
      responseHeader: toPlainHeaders(response?.headers),
    });

    if (!isSuccess) {
      throw authFailure(mastersIndiaErrorMessage({ response }, 'Masters India authenticate API did not return a token'), {
        httpStatus: response?.status,
        providerRaw: redactAuthToken(response?.data),
      });
    }

    const exp = decodeJwtExpiry(token);
    const ttl = exp ? exp - Math.floor(Date.now() / 1000) - TOKEN_TTL_BUFFER_SECONDS : 0;
    if (ttl > 0) await redis.set(AUTH_TOKEN_REDIS_KEY, token, 'EX', ttl);
    return token;
  } catch (error) {
    if (error instanceof ProviderError) throw error;

    await logAuthApiCall({
      credentialsId,
      userId,
      companyId,
      URL,
      requestPayload,
      responseBody: redactAuthToken(error?.response?.data),
      message: mastersIndiaErrorMessage(error, 'Failed to obtain Masters India auth token'),
      statusCode: error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
      responseStatus: '0',
      requestHeader,
      responseHeader: toPlainHeaders(error?.response?.headers),
    });

    // The login endpoint has no business validation: anything other than an infrastructure
    // failure (network, timeout, 5xx) means our account was rejected. Every one of these
    // fails over to the backup provider for the current request.
    const message = mastersIndiaErrorMessage(error, 'Failed to obtain Masters India auth token');
    const classified = classifyError(error);
    if (classified.failoverEligible) {
      classified.message = message;
      throw classified;
    }
    throw authFailure(message, { httpStatus: classified.httpStatus, providerRaw: redactAuthToken(error?.response?.data) });
  }
};

// The token is one account shared by every company, so it is fetched and cached once, not per company.
const getMastersIndiaAuthToken = (companyId, options = {}) =>
  singleFlight(`mastersIndiaAuthToken:${Boolean(options.forceRefresh)}`, () => loadMastersIndiaAuthToken(companyId, options));

const clearMastersIndiaAuthCache = async () => {
  await redis.del(AUTH_TOKEN_REDIS_KEY);
};

const getMastersIndiaCredentialsId = companyId => getOrCreateSystemCredentialsId(companyId);

const hasMastersIndiaCredentials = () => Boolean(config.mastersIndia.username && config.mastersIndia.password);

module.exports = {
  getMastersIndiaAuthToken,
  clearMastersIndiaAuthCache,
  getMastersIndiaCredentialsId,
  hasMastersIndiaCredentials,
  mastersIndiaErrorMessage,
};
