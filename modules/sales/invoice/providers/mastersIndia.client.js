const axios = require('axios');
const { ProviderError } = require('./providerError');
const {
  classifyError,
  isAuthFailure,
  authFailure,
  isDuplicateIrnMessage,
  isDuplicateEWayBillMessage,
} = require('./errorClassifier');
const config = require('../../../../config/config');
const { PROVIDER_ERROR_CATEGORY, THIRD_PARTY_PROVIDERS, THIRD_PARTY_API_LOG_REFERENCE_TYPES } = require('../../../../utils/enum');
const { buildMastersIndiaUrl } = require('../../../../utils/mastersIndiaApiRoutes');
const {
  getMastersIndiaAuthToken,
  clearMastersIndiaAuthCache,
  getMastersIndiaCredentialsId,
  mastersIndiaErrorMessage,
} = require('../../../../utils/getMastersIndiaAuthToken');
const { logApiCall } = require('../eInvoice.service');

const isDuplicateIrnError = error =>
  error instanceof ProviderError &&
  error.category === PROVIDER_ERROR_CATEGORY.NIC_BUSINESS_ERROR &&
  isDuplicateIrnMessage(error.message);

const isDuplicateEWayBillError = error =>
  error instanceof ProviderError &&
  error.category === PROVIDER_ERROR_CATEGORY.NIC_BUSINESS_ERROR &&
  isDuplicateEWayBillMessage(error.message);

/** Maps a Masters India `results` envelope (status/code/errorMessage) to a ProviderError, or returns null on success. */
const classifyMastersIndiaResult = (results, httpStatusCode, body) => {
  if (!results) {
    // Top-level error bodies such as {"error":"invalid_client","error_description":"..."} carry no `results`.
    if (isAuthFailure(body)) {
      return authFailure(body?.error_description || body?.error || 'Masters India rejected the credentials', {
        httpStatus: httpStatusCode,
        providerRaw: body,
      });
    }
    return new ProviderError(PROVIDER_ERROR_CATEGORY.UNKNOWN_ERROR, 'Empty response from Masters India', {
      httpStatus: httpStatusCode,
    });
  }

  const isSuccess = String(results.status).toLowerCase() === 'success' && Number(results.code) === 200;
  if (isSuccess) return null;

  const errorMessage =
    results.errorMessage || (typeof results.message === 'string' ? results.message : null) || 'Masters India request failed';
  if (isAuthFailure(results, errorMessage)) {
    return authFailure(errorMessage, { httpStatus: httpStatusCode, providerRaw: results });
  }
  const nicCode = results.nic_code ? Number(results.nic_code) : Number(String(errorMessage).match(/^(\d+):/)?.[1]);

  // NIC business-validation errors are surfaced with a leading numeric code (e.g. "3038: Seller details ...").
  // Duplicate-IRN and "already generated" style errors are business/data conflicts, not infra failures.
  if (
    Number.isFinite(nicCode) ||
    /already/i.test(errorMessage) ||
    /does not exist/i.test(errorMessage) ||
    /invalid/i.test(errorMessage)
  ) {
    return new ProviderError(PROVIDER_ERROR_CATEGORY.NIC_BUSINESS_ERROR, errorMessage, {
      httpStatus: httpStatusCode,
      providerRaw: results,
      failoverEligible: false,
    });
  }

  return new ProviderError(PROVIDER_ERROR_CATEGORY.UNKNOWN_ERROR, errorMessage, {
    httpStatus: httpStatusCode,
    providerRaw: results,
  });
};

const toPlainHeaders = headers =>
  headers ? { ...(typeof headers.toJSON === 'function' ? headers.toJSON() : headers) } : undefined;

const isChargeable = (packageName, classified) =>
  Boolean(packageName) && (!classified || classified.category === PROVIDER_ERROR_CATEGORY.NIC_BUSINESS_ERROR);

const callMastersIndia = async ({
  method = 'post',
  route,
  companyId,
  userId,
  requestId,
  data,
  params,
  referenceId,
  referenceType,
  packageName,
}) => {
  const URL = buildMastersIndiaUrl(route);
  const logReferenceType = referenceType ?? (referenceId ? THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE : undefined);
  const credentialsId = await getMastersIndiaCredentialsId(companyId);
  let token = await getMastersIndiaAuthToken(companyId, { userId });

  let requestHeaders;
  const send = authToken => {
    requestHeaders = { Authorization: `JWT ${authToken}`, 'Content-Type': 'application/json' };
    return axios({ method, url: URL, data, params, headers: requestHeaders, timeout: config.mastersIndia.timeoutMs });
  };

  let response;
  let refreshedOnce = false;
  for (;;) {
    try {
      response = await send(token);
      break;
    } catch (error) {
      if (error?.response?.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        await clearMastersIndiaAuthCache();
        token = await getMastersIndiaAuthToken(companyId, { forceRefresh: true, userId });
        continue;
      }
      await logApiCall(
        credentialsId,
        userId,
        companyId,
        URL,
        { ...data, params, requestId },
        error?.response?.data,
        mastersIndiaErrorMessage(error, 'Masters India request failed'),
        error?.response?.status || 500,
        '0',
        {
          providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
          referenceId,
          referenceType: logReferenceType,
          packageName,
          chargeable: false,
          requestHeader: requestHeaders,
          responseHeader: toPlainHeaders(error?.response?.headers),
        },
      );
      throw classifyError(error, { providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA });
    }
  }

  const results = response?.data?.results;
  const classified = classifyMastersIndiaResult(results, response?.status, response?.data);

  await logApiCall(
    credentialsId,
    userId,
    companyId,
    URL,
    { ...data, params, requestId },
    response?.data,
    classified ? classified.message : 'Masters India request succeeded',
    response?.status,
    classified ? '0' : '1',
    {
      providerName: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
      referenceId,
      referenceType: logReferenceType,
      packageName,
      chargeable: isChargeable(packageName, classified),
      requestHeader: requestHeaders,
      responseHeader: toPlainHeaders(response?.headers),
    },
  );

  if (classified) throw classified;
  return results;
};

module.exports = { callMastersIndia, isDuplicateIrnError, isDuplicateEWayBillError };
