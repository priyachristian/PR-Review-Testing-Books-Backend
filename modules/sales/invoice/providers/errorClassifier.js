const httpStatus = require('http-status');
const { PROVIDER_ERROR_CATEGORY } = require('../../../../utils/enum');
const { ProviderError } = require('./providerError');

const AUTH_ERROR_CODES = new Set(['invalid_client', 'unauthorized_client', 'invalid_token', 'invalid_grant', 'access_denied']);
const AUTH_ERROR_PATTERN =
  /invalid[_\s-]?client|client credentials|unable to login|invalid (?:token|credential)|authentication failed|not authori[sz]ed|token (?:has )?expired|signature has expired/i;

const isAuthFailure = (body, message) => {
  const code = typeof body?.error === 'string' ? body.error.toLowerCase() : '';
  if (AUTH_ERROR_CODES.has(code)) return true;
  const text = [message, typeof body?.error === 'string' ? body.error : '', body?.error_description, body?.message]
    .filter(value => typeof value === 'string')
    .join(' ');
  return AUTH_ERROR_PATTERN.test(text);
};

const authFailure = (message, { httpStatus: status, providerRaw, data } = {}) =>
  new ProviderError(PROVIDER_ERROR_CATEGORY.AUTHENTICATION_ERROR, message, {
    httpStatus: status,
    providerRaw,
    failoverEligible: true,
    retryable: false,
    data,
  });

const classifyError = (error, { providerName } = {}) => {
  if (error instanceof ProviderError) return error;

  const axiosCode = error?.code;
  const httpStatusCode = error?.statusCode || error?.response?.status;
  const message = error?.message || 'Unknown provider error';
  const data = error?.data;

  if (axiosCode === 'ECONNABORTED' || axiosCode === 'ETIMEDOUT') {
    return new ProviderError(PROVIDER_ERROR_CATEGORY.TIMEOUT, message, { providerRaw: error, data });
  }

  if (!httpStatusCode && axiosCode) {
    return new ProviderError(PROVIDER_ERROR_CATEGORY.NETWORK_ERROR, message, { providerRaw: error, data });
  }

  const body = error?.response?.data;
  if (httpStatusCode === httpStatus.UNAUTHORIZED || httpStatusCode === httpStatus.FORBIDDEN || isAuthFailure(body, message)) {
    return authFailure(message, { httpStatus: httpStatusCode, providerRaw: error, data });
  }

  if (httpStatusCode === httpStatus.TOO_MANY_REQUESTS) {
    return new ProviderError(PROVIDER_ERROR_CATEGORY.RATE_LIMIT, message, {
      httpStatus: httpStatusCode,
      providerRaw: error,
      failoverEligible: false,
      data,
    });
  }

  if (httpStatusCode >= 500) {
    return new ProviderError(PROVIDER_ERROR_CATEGORY.PROVIDER_5XX, message, {
      httpStatus: httpStatusCode,
      providerRaw: error,
      data,
    });
  }

  if (httpStatusCode >= 400) {
    return new ProviderError(PROVIDER_ERROR_CATEGORY.VALIDATION_ERROR, message, {
      httpStatus: httpStatusCode,
      providerRaw: error,
      failoverEligible: false,
      data,
    });
  }

  return new ProviderError(PROVIDER_ERROR_CATEGORY.UNKNOWN_ERROR, message, { providerRaw: error, providerName, data });
};

const stripErrorCodes = message => {
  if (typeof message !== 'string') return message;
  const cleaned = message.replace(/(^|[,;]\s*)\d{3,5}\s*:\s*/g, '$1').trim();
  return cleaned || message;
};

const DUPLICATE_IRN_PATTERN = /2150|duplicate irn|irn already/i;

const isDuplicateIrnMessage = message => typeof message === 'string' && DUPLICATE_IRN_PATTERN.test(message);

// NIC 604: an e-way bill already exists for this document number.
const DUPLICATE_E_WAY_BILL_PATTERN = /\b604\b|already generated for the same document/i;

const isDuplicateEWayBillMessage = message => typeof message === 'string' && DUPLICATE_E_WAY_BILL_PATTERN.test(message);

module.exports = {
  classifyError,
  isAuthFailure,
  authFailure,
  stripErrorCodes,
  isDuplicateIrnMessage,
  isDuplicateEWayBillMessage,
};
