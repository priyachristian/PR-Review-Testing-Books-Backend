const axios = require('axios');
const httpStatus = require('http-status');
const config = require('../../../../config/config');
const redis = require('../../../../config/redis-client');
const { ProviderError } = require('./providerError');
const { classifyError, authFailure } = require('./errorClassifier');
const { PROVIDER_ERROR_CATEGORY, THIRD_PARTY_PROVIDERS } = require('../../../../utils/enum');
const { MASTERS_INDIA_COMMON_ROUTES, buildMastersIndiaCommonUrl } = require('../../../../utils/mastersIndiaApiRoutes');
const { getMastersIndiaCredentialsId, mastersIndiaErrorMessage } = require('../../../../utils/getMastersIndiaAuthToken');
const { encryptBlob } = require('../../../../utils/cryptography');
const { logApiCall } = require('../eInvoice.service');

/**
 * Masters India common API (commonapi.mastersindia.co). It signs in with OAuth (the ABSS Masters India username and
 * password plus this API's client id and secret) and sends `Authorization: Bearer <token>` with a `client_id` header.
 * One account is shared by every company, so the token is cached once.
 */

const TOKEN_REDIS_KEY = 'mastersIndia:commonApiToken';
const TOKEN_TTL_BUFFER_SECONDS = 60;

let inflightToken = null;

const toPlainHeaders = headers =>
  headers ? { ...(typeof headers.toJSON === 'function' ? headers.toJSON() : headers) } : undefined;

const redactToken = body => (body?.access_token ? { ...body, access_token: encryptBlob(body.access_token) } : body);

const getCredentials = () => {
  const { username, password, commonApi } = config.mastersIndia;
  if (!username || !password || !commonApi.clientId || !commonApi.clientSecret) {
    throw authFailure(
      'Masters India GSTIN search is not configured (MASTERS_INDIA_USERNAME/PASSWORD, MASTERS_INDIA_COMMON_API_CLIENT_ID/CLIENT_SECRET)',
      { httpStatus: httpStatus.INTERNAL_SERVER_ERROR },
    );
  }
  return { username, password, clientId: commonApi.clientId, clientSecret: commonApi.clientSecret };
};

const requestToken = async ({ companyId, userId }) => {
  const { username, password, clientId, clientSecret } = getCredentials();
  const credentialsId = await getMastersIndiaCredentialsId(companyId);
  const URL = buildMastersIndiaCommonUrl(MASTERS_INDIA_COMMON_ROUTES.AUTHENTICATE);
  const requestHeader = { 'Content-Type': 'application/json' };
  // Logged without the password and client secret.
  const loggedRequest = { username, client_id: clientId, grant_type: 'password' };

  try {
    const response = await axios.post(
      URL,
      { username, password, client_id: clientId, client_secret: clientSecret, grant_type: 'password' },
      { headers: requestHeader, timeout: config.mastersIndia.timeoutMs },
    );
    const token = response?.data?.access_token;
    await logApiCall(
      credentialsId,
      userId,
      companyId,
      URL,
      loggedRequest,
      redactToken(response?.data),
      token ? 'Masters India common API authentication successful' : 'Masters India common API authentication failed',
      response?.status,
      token ? '1' : '0',
      { providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA, requestHeader, responseHeader: toPlainHeaders(response?.headers) },
    );
    if (!token) {
      throw authFailure(mastersIndiaErrorMessage({ response }, 'Masters India common API did not return a token'), {
        httpStatus: response?.status,
        providerRaw: redactToken(response?.data),
      });
    }

    const ttl = Number(response.data.expires_in) - TOKEN_TTL_BUFFER_SECONDS;
    if (ttl > 0) await redis.set(TOKEN_REDIS_KEY, token, 'EX', ttl);
    return token;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const message =
      error?.response?.data?.error_description ||
      mastersIndiaErrorMessage(error, 'Failed to sign in to the Masters India common API');
    await logApiCall(
      credentialsId,
      userId,
      companyId,
      URL,
      loggedRequest,
      error?.response?.data,
      message,
      error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
      '0',
      {
        providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
        requestHeader,
        responseHeader: toPlainHeaders(error?.response?.headers),
      },
    );
    const classified = classifyError(error);
    if (classified.failoverEligible && classified.category !== PROVIDER_ERROR_CATEGORY.AUTHENTICATION_ERROR) {
      classified.message = message;
      throw classified;
    }
    throw authFailure(message, { httpStatus: classified.httpStatus, providerRaw: error?.response?.data });
  }
};

const getToken = async ({ companyId, userId, forceRefresh = false }) => {
  if (!forceRefresh) {
    const cached = await redis.get(TOKEN_REDIS_KEY);
    if (cached) return cached;
  }
  if (!inflightToken) {
    inflightToken = requestToken({ companyId, userId }).finally(() => {
      inflightToken = null;
    });
  }
  return inflightToken;
};

/** `data` arrives as a JSON string; returns it parsed, or the value as is when it is not JSON. */
const parseData = data => {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch (parseError) {
    return data;
  }
};

/**
 * GET on the common API. Success bodies are `{ error: false, data: "<json>" }`; returns the parsed `data`.
 * `error: true` is a business error (e.g. an unknown GSTIN) and does not fail over.
 */
const callMastersIndiaCommonApi = async ({ route, params, companyId, userId, referenceId, referenceType, packageName }) => {
  const URL = buildMastersIndiaCommonUrl(route);
  const credentialsId = await getMastersIndiaCredentialsId(companyId);
  const { clientId } = getCredentials();
  let token = await getToken({ companyId, userId });

  let requestHeader;
  const send = authToken => {
    requestHeader = { Authorization: `Bearer ${authToken}`, client_id: clientId, 'Content-Type': 'application/json' };
    return axios.get(URL, { params, headers: requestHeader, timeout: config.mastersIndia.timeoutMs });
  };
  const log = (response, message, isSuccess, chargeable) =>
    logApiCall(
      credentialsId,
      userId,
      companyId,
      URL,
      { params },
      response?.data,
      message,
      response?.status || 500,
      isSuccess ? '1' : '0',
      {
        providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
        referenceId,
        referenceType,
        packageName,
        chargeable,
        requestHeader,
        responseHeader: toPlainHeaders(response?.headers),
      },
    );

  let response;
  try {
    response = await send(token);
  } catch (error) {
    if (error?.response?.status === 401) {
      await redis.del(TOKEN_REDIS_KEY);
      token = await getToken({ companyId, userId, forceRefresh: true });
      response = await send(token).catch(async retryError => {
        await log(retryError?.response, mastersIndiaErrorMessage(retryError, 'Masters India request failed'), false, false);
        throw classifyError(retryError, { providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA });
      });
    } else {
      await log(error?.response, mastersIndiaErrorMessage(error, 'Masters India request failed'), false, false);
      throw classifyError(error, { providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA });
    }
  }

  const body = response?.data;
  const data = parseData(body?.data);
  if (!body || body.error !== false) {
    const message =
      (typeof data === 'string' && data) ||
      data?.message ||
      data?.error?.message ||
      body?.message ||
      'Masters India GSTIN search failed';
    await log(response, message, false, Boolean(packageName) && Boolean(body));
    throw new ProviderError(body ? PROVIDER_ERROR_CATEGORY.NIC_BUSINESS_ERROR : PROVIDER_ERROR_CATEGORY.UNKNOWN_ERROR, message, {
      httpStatus: httpStatus.BAD_REQUEST,
      providerRaw: body,
      failoverEligible: !body,
    });
  }

  await log(response, 'Masters India request succeeded', true, Boolean(packageName));
  return data;
};

module.exports = { callMastersIndiaCommonApi };
