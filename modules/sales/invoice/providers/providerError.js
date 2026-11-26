const { PROVIDER_ERROR_CATEGORY } = require('../../../../utils/enum');

const FAILOVER_ELIGIBLE_CATEGORIES = new Set([
  PROVIDER_ERROR_CATEGORY.TIMEOUT,
  PROVIDER_ERROR_CATEGORY.NETWORK_ERROR,
  PROVIDER_ERROR_CATEGORY.PROVIDER_5XX,
  PROVIDER_ERROR_CATEGORY.PROVIDER_UNAVAILABLE,
]);

/** HTTP status the API returns for each category, so business errors are 4xx (not 5xx alerts) and provider outages are 5xx. */
const STATUS_BY_CATEGORY = {
  [PROVIDER_ERROR_CATEGORY.VALIDATION_ERROR]: 400,
  [PROVIDER_ERROR_CATEGORY.NIC_BUSINESS_ERROR]: 400,
  [PROVIDER_ERROR_CATEGORY.DUPLICATE_REQUEST]: 409,
  [PROVIDER_ERROR_CATEGORY.RATE_LIMIT]: 429,
  [PROVIDER_ERROR_CATEGORY.TIMEOUT]: 504,
  [PROVIDER_ERROR_CATEGORY.AUTHENTICATION_ERROR]: 502,
  [PROVIDER_ERROR_CATEGORY.AUTHORIZATION_ERROR]: 502,
  [PROVIDER_ERROR_CATEGORY.NETWORK_ERROR]: 502,
  [PROVIDER_ERROR_CATEGORY.PROVIDER_5XX]: 502,
  [PROVIDER_ERROR_CATEGORY.PROVIDER_UNAVAILABLE]: 503,
};

class ProviderError extends Error {
  constructor(category, message, { httpStatus, providerRaw, retryable, failoverEligible, data } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.category = category;
    this.statusCode = STATUS_BY_CATEGORY[category] ?? 500;
    this.httpStatus = httpStatus;
    this.providerRaw = providerRaw;
    this.retryable = retryable ?? FAILOVER_ELIGIBLE_CATEGORIES.has(category);
    this.failoverEligible = failoverEligible ?? FAILOVER_ELIGIBLE_CATEGORIES.has(category);
    if (data !== undefined) this.data = data;
  }
}

// Network failures that happen before the request is sent: the provider never saw it.
const NOT_SENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * True when the request may have reached the provider (and NIC) before failing: a timeout, a 5xx, or a dropped
 * connection. Replaying such a request on another provider can file the same document twice.
 */
const mayHaveReachedProvider = error => {
  if (!(error instanceof ProviderError)) return false;
  if (error.category === PROVIDER_ERROR_CATEGORY.TIMEOUT || error.category === PROVIDER_ERROR_CATEGORY.PROVIDER_5XX) return true;
  return error.category === PROVIDER_ERROR_CATEGORY.NETWORK_ERROR && !NOT_SENT_NETWORK_CODES.has(error.providerRaw?.code);
};

module.exports = {
  ProviderError,
  FAILOVER_ELIGIBLE_CATEGORIES,
  mayHaveReachedProvider,
};
