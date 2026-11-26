const axios = require('axios');
const momentTz = require('moment-timezone');
const config = require('../config/config');
const redis = require('../config/redis-client');
const ApiError = require('./ApiError');
const httpStatus = require('http-status');
const { FYNAMICS_ROUTES, buildFynamicsUrl } = require('./fynamicsApiRoutes');
const { getCommonModels } = require('../services/model.service');
const { decryptBlob, encryptBlob } = require('./cryptography');
const { THIRD_PARTY_PROVIDERS } = require('./enum');

const redactFynamicsAuthTokens = body => {
  if (!body) return body;
  const containerKey = body.Data ? 'Data' : body.data ? 'data' : null;
  const container = containerKey ? body[containerKey] : body;
  if (!container?.AuthToken && !container?.Sek) return body;
  const redacted = {
    ...container,
    ...(container.AuthToken !== undefined && { AuthToken: encryptBlob(container.AuthToken) }),
    ...(container.Sek !== undefined && { Sek: encryptBlob(container.Sek) }),
  };
  return containerKey ? { ...body, [containerKey]: redacted } : redacted;
};

const resolveSandboxOverrides = decrypted => {
  if (!decrypted?.useIsSandbox) return null;
  const { sandboxBaseUrl, sandboxClientId, sandboxClientSecret } = decrypted;
  if (!sandboxBaseUrl || !sandboxClientId || !sandboxClientSecret) return null;
  return { baseUrl: sandboxBaseUrl, clientId: sandboxClientId, clientSecret: sandboxClientSecret };
};

const resolvePortalCredentials = async companyId => {
  const { ThirdPartyCredentials } = getCommonModels();
  const record = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
  if (!record) return {};
  const decrypted = decryptBlob(record.credentialsJson) || {};
  return {
    credentialsId: record._id,
    username: decrypted.username,
    password: decrypted.password,
    sandbox: resolveSandboxOverrides(decrypted),
  };
};

const REDACTED = '********';

const inflightTokenRequests = new Map();

const singleFlight = (key, fn) => {
  const existing = inflightTokenRequests.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => inflightTokenRequests.delete(key));
  inflightTokenRequests.set(key, promise);
  return promise;
};

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
  packageName,
  referenceId,
  referenceType,
  requestHeader,
  responseHeader,
}) => {
  if (!credentialsId || !userId || !companyId) return;
  try {
    const { logApiCall } = require('../modules/sales/invoice/eInvoice.service');
    await logApiCall(
      credentialsId,
      userId,
      companyId,
      URL,
      { ...requestPayload, Password: undefined, password: undefined, redacted: REDACTED },
      responseBody,
      message,
      statusCode,
      responseStatus,
      {
        packageName,
        referenceId,
        referenceType,
        chargeable: Boolean(packageName),
        providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
        requestHeader,
        responseHeader,
      },
    );
  } catch (loggingError) {
    console.error('FYNAMICS_AUTH_LOG_FAILED ==============================> ', loggingError?.message);
  }
};

const CLIENT_TOKEN_REDIS_KEY = 'fynamics:clientToken';
const clientTokenCacheKey = sandbox =>
  sandbox ? `${CLIENT_TOKEN_REDIS_KEY}:sandbox:${sandbox.clientId}` : CLIENT_TOKEN_REDIS_KEY;
const EINVOICE_AUTH_REDIS_KEY = companyId => `fynamics:einvoiceAuth:${companyId}`;
const EWAYBILL_AUTH_REDIS_KEY = companyId => `fynamics:ewaybillAuth:${companyId}`;

const TOKEN_TTL_BUFFER_SECONDS = 60;
const DEFAULT_CLIENT_TOKEN_TTL_SECONDS = 86400;
const IST_TIMEZONE = 'Asia/Kolkata';
const TOKEN_EXPIRY_FORMAT = 'YYYY-MM-DD HH:mm:ss';

const redisHsetObject = async (key, obj, ttlSeconds) => {
  const flat = Object.entries(obj)
    .filter(([, value]) => value !== null && value !== undefined)
    .flat();
  if (flat.length === 0) return;
  await redis.hset(key, ...flat);
  if (ttlSeconds > 0) await redis.expire(key, ttlSeconds);
};

const ttlFromTokenExpiry = tokenExpiry => {
  if (!tokenExpiry) return 0;
  const expiry = momentTz.tz(String(tokenExpiry).trim(), TOKEN_EXPIRY_FORMAT, IST_TIMEZONE);
  if (!expiry.isValid()) return 0;
  return Math.floor(expiry.diff(momentTz(), 'seconds')) - TOKEN_TTL_BUFFER_SECONDS;
};

const fynamicsErrorMessage = (error, fallback) => {
  const data = error?.response?.data;
  const errorDetails = data?.ErrorDetails;
  if (Array.isArray(errorDetails)) {
    const joined = errorDetails
      .map(err => err?.ErrorMessage || err?.errorMsg || err?.message)
      .filter(Boolean)
      .join(', ');
    if (joined) return joined;
  }
  if (typeof errorDetails === 'string' && errorDetails) return errorDetails;
  return data?.message || error?.message || fallback;
};

const loadFynamicsClientToken = async ({ forceRefresh = false, sandbox = null } = {}) => {
  const cacheKey = clientTokenCacheKey(sandbox);

  if (!forceRefresh) {
    const cachedToken = await redis.get(cacheKey);
    if (cachedToken) return cachedToken;
  }

  const clientId = sandbox?.clientId || config.fynamics.clientId;
  const clientSecret = sandbox?.clientSecret || config.fynamics.clientSecret;
  if (!clientId || !clientSecret) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Fynamics client credentials are not configured');
  }

  const URL = buildFynamicsUrl(FYNAMICS_ROUTES.AUTHENTICATE, sandbox?.baseUrl);
  const headers = {
    accept: 'application/json',
    clientId,
    clientSecret,
  };

  try {
    const response = await axios.post(URL, null, { headers });
    const accessToken = response?.data?.data?.accessToken;
    if (response?.data?.status != 1 || !accessToken) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Fynamics authenticate API did not return an access token');
    }

    const ttl = Number(response?.data?.data?.expiresIn || DEFAULT_CLIENT_TOKEN_TTL_SECONDS) - TOKEN_TTL_BUFFER_SECONDS;
    if (ttl > 0) await redis.set(cacheKey, accessToken, 'EX', ttl);
    return accessToken;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, fynamicsErrorMessage(error, 'Failed to obtain Fynamics client token'));
  }
};

const CLIENT_BEARER_INVALID_PATTERNS = [/authorization\s+bearer/i, /invalid\s+token/i, /token\s+.*expired/i];

const isClientBearerRejected = ({ responseData, httpStatusCode }) => {
  if (httpStatusCode === httpStatus.UNAUTHORIZED) return true;
  if (responseData?.Status == 1 || responseData?.status == 1) return false;
  const message = String(responseData?.errorMessage ?? responseData?.ErrorMessage ?? responseData?.message ?? '');
  return CLIENT_BEARER_INVALID_PATTERNS.some(pattern => pattern.test(message));
};

const postGstinAuthWithBearerRetry = async ({ url, requestPayload, gstNumber, forceRefresh, sandbox, headerTracker }) => {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    const clientToken = await getFynamicsClientToken({ forceRefresh: forceRefresh || attempt > 0, sandbox });
    const headers = {
      accept: 'application/json',
      gstin: gstNumber,
      Authorization: `Bearer ${clientToken}`,
      'Content-Type': 'application/json',
    };
    if (headerTracker) headerTracker.headers = headers;
    try {
      response = await axios.post(url, requestPayload, { headers });
    } catch (error) {
      const bearerRejected = isClientBearerRejected({
        responseData: error?.response?.data,
        httpStatusCode: error?.response?.status,
      });
      if (attempt === 0 && bearerRejected) {
        await redis.del(clientTokenCacheKey(sandbox));
        continue;
      }
      throw error;
    }
    if (attempt === 0 && isClientBearerRejected({ responseData: response?.data, httpStatusCode: response?.status })) {
      console.log('FYNAMICS_CLIENT_BEARER_INVALID — refreshing client token and retrying auth once');
      await redis.del(clientTokenCacheKey(sandbox));
      continue;
    }
    return response;
  }
  return response;
};

const loadFynamicsEInvoiceAuth = async (
  credentials,
  companyId,
  gstNumber,
  { forceRefresh = false, userId, packageName, referenceId, referenceType } = {},
) => {
  if (!gstNumber) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'GSTIN not found in company credentials');
  }

  const cacheKey = EINVOICE_AUTH_REDIS_KEY(companyId);
  if (!forceRefresh) {
    const cached = await redis.hgetall(cacheKey);
    if (cached?.AuthToken && cached?.Sek) return cached;
    if (cached && Object.keys(cached).length > 0) await redis.del(cacheKey);
  }

  const { credentialsId, username, password, sandbox } = await resolvePortalCredentials(companyId);
  if (!username || !password) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'GST portal credentials are not configured. Add them under Settings.');
  }

  const URL = buildFynamicsUrl(FYNAMICS_ROUTES.EINVOICE_AUTH, sandbox?.baseUrl);
  const requestPayload = {
    Username: username,
    Password: password,
    ForceRefreshAccessToken: forceRefresh,
  };

  const logContext = { credentialsId, userId, companyId, URL, requestPayload, packageName, referenceId, referenceType };
  const headerTracker = {};

  try {
    const response = await postGstinAuthWithBearerRetry({
      url: URL,
      requestPayload,
      gstNumber,
      forceRefresh,
      sandbox,
      headerTracker,
    });
    const data = response?.data?.Data;
    const isSuccess = response?.data?.Status == 1 && data?.AuthToken && data?.Sek;
    await logAuthApiCall({
      ...logContext,
      responseBody: redactFynamicsAuthTokens(response?.data),
      message: isSuccess
        ? 'E-Invoice authentication successful'
        : fynamicsErrorMessage({ response }, 'Fynamics e-invoice authentication failed'),
      statusCode: response?.status,
      responseStatus: isSuccess ? '1' : '0',
      requestHeader: headerTracker.headers,
      responseHeader: response?.headers,
    });

    if (!isSuccess) {
      throw new ApiError(
        httpStatus.INTERNAL_SERVER_ERROR,
        fynamicsErrorMessage({ response }, 'Fynamics e-invoice authentication failed'),
      );
    }

    const authDetails = {
      ClientId: data.ClientId,
      UserName: data.UserName,
      AuthToken: data.AuthToken,
      Sek: data.Sek,
      TokenExpiry: data.TokenExpiry,
    };
    const ttl = ttlFromTokenExpiry(data.TokenExpiry);
    if (ttl > 0) await redisHsetObject(cacheKey, authDetails, ttl);
    return authDetails;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    await logAuthApiCall({
      ...logContext,
      responseBody: redactFynamicsAuthTokens(error?.response?.data),
      message: fynamicsErrorMessage(error, 'Failed to obtain Fynamics e-invoice auth token'),
      statusCode: error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
      responseStatus: '0',
      requestHeader: headerTracker.headers,
      responseHeader: error?.response?.headers,
    });

    if (error?.response?.status === httpStatus.UNAUTHORIZED) await redis.del(clientTokenCacheKey(sandbox));
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      fynamicsErrorMessage(error, 'Failed to obtain Fynamics e-invoice auth token'),
    );
  }
};

const loadFynamicsEWayBillAuth = async (
  credentials,
  companyId,
  gstNumber,
  { forceRefresh = false, userId, packageName, referenceId, referenceType } = {},
) => {
  if (!gstNumber) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'GSTIN not found in company credentials');
  }

  const cacheKey = EWAYBILL_AUTH_REDIS_KEY(companyId);
  if (!forceRefresh) {
    const cached = await redis.hgetall(cacheKey);
    if (cached?.AuthToken && cached?.Sek) return cached;
    if (cached && Object.keys(cached).length > 0) await redis.del(cacheKey);
  }

  const { credentialsId, username, password, sandbox } = await resolvePortalCredentials(companyId);
  if (!username || !password) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'GST portal credentials are not configured. Add them under Settings.');
  }

  const URL = buildFynamicsUrl(FYNAMICS_ROUTES.EWAYBILL_AUTH, sandbox?.baseUrl);
  const requestPayload = {
    action: 'ACCESSTOKEN',
    username,
    password,
  };

  const logContext = { credentialsId, userId, companyId, URL, requestPayload, packageName, referenceId, referenceType };
  const headerTracker = {};

  try {
    const response = await postGstinAuthWithBearerRetry({
      url: URL,
      requestPayload,
      gstNumber,
      forceRefresh,
      sandbox,
      headerTracker,
    });
    const body = response?.data || {};
    const data = body.Data || body.data || body;
    const isSuccess = Boolean(data?.AuthToken && data?.Sek);
    console.log('FYNAMICS_EWAYBILL_AUTH_RESPONSE ==============================> ', redactFynamicsAuthTokens(response?.data));
    await logAuthApiCall({
      ...logContext,
      responseBody: redactFynamicsAuthTokens(response?.data),
      message: isSuccess
        ? 'E-Way Bill authentication successful'
        : fynamicsErrorMessage({ response }, 'Fynamics e-way bill authentication failed'),
      statusCode: response?.status,
      responseStatus: isSuccess ? '1' : '0',
      requestHeader: headerTracker.headers,
      responseHeader: response?.headers,
    });

    if (!isSuccess) {
      throw new ApiError(
        httpStatus.INTERNAL_SERVER_ERROR,
        fynamicsErrorMessage({ response }, 'Fynamics e-way bill authentication failed'),
      );
    }

    const authDetails = {
      ClientId: data.ClientId,
      UserName: data.UserName,
      AuthToken: data.AuthToken,
      Sek: data.Sek,
      TokenExpiry: data.TokenExpiry,
    };
    const ttl = ttlFromTokenExpiry(data.TokenExpiry);
    if (ttl > 0) await redisHsetObject(cacheKey, authDetails, ttl);
    return authDetails;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    await logAuthApiCall({
      ...logContext,
      responseBody: redactFynamicsAuthTokens(error?.response?.data),
      message: fynamicsErrorMessage(error, 'Failed to obtain Fynamics e-way bill auth token'),
      statusCode: error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
      responseStatus: '0',
      requestHeader: headerTracker.headers,
      responseHeader: error?.response?.headers,
    });

    if (error?.response?.status === httpStatus.UNAUTHORIZED) await redis.del(clientTokenCacheKey(sandbox));
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      fynamicsErrorMessage(error, 'Failed to obtain Fynamics e-way bill auth token'),
    );
  }
};

const getFynamicsClientToken = (options = {}) =>
  singleFlight(
    `clientToken:${options.sandbox ? `sandbox:${options.sandbox.clientId}` : 'prod'}:${Boolean(options.forceRefresh)}`,
    () => loadFynamicsClientToken(options),
  );

const getFynamicsEInvoiceAuth = (credentials, companyId, gstNumber, options = {}) =>
  singleFlight(`einvoiceAuth:${companyId}:${Boolean(options.forceRefresh)}`, () =>
    loadFynamicsEInvoiceAuth(credentials, companyId, gstNumber, options),
  );

const getFynamicsEWayBillAuth = (credentials, companyId, gstNumber, options = {}) =>
  singleFlight(`ewaybillAuth:${companyId}:${Boolean(options.forceRefresh)}`, () =>
    loadFynamicsEWayBillAuth(credentials, companyId, gstNumber, options),
  );

const clearFynamicsAuthCache = async companyId => {
  await redis.del(EINVOICE_AUTH_REDIS_KEY(companyId));
  await redis.del(EWAYBILL_AUTH_REDIS_KEY(companyId));
};

module.exports = {
  getFynamicsClientToken,
  getFynamicsEInvoiceAuth,
  getFynamicsEWayBillAuth,
  clearFynamicsAuthCache,
  resolveSandboxOverrides,
};
