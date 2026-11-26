const crypto = require('crypto');
const httpStatus = require('http-status');
const ApiError = require('../../../../utils/ApiError');
const { getProviderInstance } = require('./providerRegistry');
const { getOrderedProviders } = require('./providerConfig.service');
const { stripErrorCodes } = require('./errorClassifier');
const { mayHaveReachedProvider } = require('./providerError');
const { PROVIDER_ERROR_CATEGORY } = require('../../../../utils/enum');
const logger = require('../../../../config/logger');

const OPERATION_LABELS = {
  generateEInvoice: 'E-invoice generation',
  cancelEInvoice: 'E-invoice cancellation',
  generateEWayBill: 'E-way bill generation',
  cancelEWayBill: 'E-way bill cancellation',
  refetchEInvoice: 'E-invoice re-fetch',
  verifyGSTIN: 'GSTIN lookup',
};

const PROVIDER_LABELS = {
  MASTERS_INDIA: 'Masters India',
  FYNAMICS: 'Fynamics',
};

/** Plain-language reason for a provider failure, shown to the user. Raw transport messages are replaced. */
const describeFailure = error => {
  switch (error?.category) {
    case PROVIDER_ERROR_CATEGORY.TIMEOUT:
      return 'did not respond in time';
    case PROVIDER_ERROR_CATEGORY.NETWORK_ERROR:
    case PROVIDER_ERROR_CATEGORY.PROVIDER_UNAVAILABLE:
      return 'could not be reached';
    case PROVIDER_ERROR_CATEGORY.AUTHENTICATION_ERROR:
    case PROVIDER_ERROR_CATEGORY.AUTHORIZATION_ERROR:
      return 'rejected the saved credentials (check Settings > GST portal credentials)';
    case PROVIDER_ERROR_CATEGORY.RATE_LIMIT:
      return 'is limiting requests right now';
    default: {
      const message = stripErrorCodes(String(error?.message || '').trim());
      if (!message || /^Request failed with status code/i.test(message)) return 'returned an error';
      return message.replace(/[.\s]+$/, '');
    }
  }
};

const buildFailureMessage = (operation, failures) => {
  const label = OPERATION_LABELS[operation] || 'This request';
  const reasons = failures.map(({ provider, error }) => {
    const reason = describeFailure(error);
    const name = PROVIDER_LABELS[provider] || provider;
    return /^(did|could|rejected|is limiting|returned)/.test(reason) ? `${name} ${reason}.` : `${name}: ${reason}.`;
  });
  return `${label} failed. ${reasons.join(' ')}`;
};

const PRIMARY_RETRIES = Number(process.env.EINVOICE_PRIMARY_RETRIES ?? 2);

const RETRY_SAFE_OPERATIONS = new Set(['generateEInvoice', 'refetchEInvoice', 'verifyGSTIN']);

const OUTCOME_UNKNOWN_HINT = 'It may still have gone through at the GST portal, so check there before trying again.';

const generateRequestId = companyId => `EINV-${companyId}-${crypto.randomBytes(4).toString('hex')}`;

const execute = async (operation, payload, context = {}) => {
  const { companyId, preferredProvider } = context;
  const requestId = context.requestId || generateRequestId(companyId);

  const providers = preferredProvider ? [preferredProvider] : await getOrderedProviders(companyId, operation);

  if (providers.length === 0) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'No e-invoice/e-way bill provider is configured for this company');
  }

  const attempts = [];
  const failuresByProvider = new Map();

  const inOpenTransaction = payload?.session?.inTransaction?.() === true;
  let outcomeUnknown = false;

  for (const providerKey of providers) {
    const provider = getProviderInstance(providerKey);
    const maxAttempts =
      providerKey === providers[0] && RETRY_SAFE_OPERATIONS.has(operation) && !inOpenTransaction ? PRIMARY_RETRIES : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await provider[operation](payload, { ...context, requestId });
        attempts.push({ provider: providerKey, attempt, status: 'SUCCESS' });
        return { ...result, requestId, provider: providerKey, attempts };
      } catch (error) {
        const providerError = error;
        attempts.push({
          provider: providerKey,
          attempt,
          status: 'FAILED',
          errorCategory: providerError?.category || PROVIDER_ERROR_CATEGORY.UNKNOWN_ERROR,
        });
        failuresByProvider.set(providerKey, error);

        const failoverEligible = providerError?.failoverEligible ?? false;
        if (!failoverEligible) {
          // Surface categorised provider/NIC business errors (e.g. "TransportId ... is not active") with
          // their real message and status. Re-thrown as an ApiError (operational) so the error handler
          // does not sanitise the raw ProviderError into a generic 500 in production.
          const message = stripErrorCodes(error?.message);
          throw new ApiError(
            providerError?.statusCode || httpStatus.INTERNAL_SERVER_ERROR,
            message,
            0,
            providerError?.data ?? {},
          );
        }

        logger.warn(
          `[providerOrchestrator] ${providerKey} failed for ${operation} | requestId=${requestId} | companyId=${companyId} | category=${providerError?.category} | ${providerError?.message}`,
        );

        // The request may already be filed at NIC; sending it again through another provider could file it twice.
        if (!RETRY_SAFE_OPERATIONS.has(operation) && mayHaveReachedProvider(providerError)) {
          outcomeUnknown = true;
          break;
        }
        if (providerError?.retryable === false) break;
      }
    }
    if (outcomeUnknown) break;
  }

  const failures = [...failuresByProvider].map(([provider, error]) => ({ provider, error }));
  logger.error(
    `[providerOrchestrator] all providers failed for ${operation} | requestId=${requestId} | companyId=${companyId} | ${failures
      .map(({ provider, error }) => `${provider}: ${error?.message}`)
      .join(' || ')}`,
  );
  const failureMessage = buildFailureMessage(operation, failures);
  const finalError = new ApiError(
    httpStatus.SERVICE_UNAVAILABLE,
    outcomeUnknown ? `${failureMessage} ${OUTCOME_UNKNOWN_HINT}` : failureMessage,
  );
  finalError.attempts = attempts;
  finalError.requestId = requestId;
  throw finalError;
};

module.exports = { execute, generateRequestId };
