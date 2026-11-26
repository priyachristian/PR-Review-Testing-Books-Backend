const { EInvoiceProvider } = require('./base.provider');
const { ProviderError } = require('./providerError');
const { isDuplicateIrnMessage } = require('./errorClassifier');
const { getBooksModels } = require('../../../../services/model.service');
const { THIRD_PARTY_PROVIDERS, PROVIDER_ERROR_CATEGORY } = require('../../../../utils/enum');
const {
  generateFynamicsEInvoice,
  cancelFynamicsEInvoice,
  generateFynamicsEWayBill,
  cancelFynamicsEWayBill,
  generateFynamicsOnlyEWayBill,
  getFynamicsEInvoiceByDocDetails,
} = require('../fynamicsEInvoice.service');
const { getFynamicsGstDetails } = require('../../../report/gst/fynamicsGst.service');

const fynamicsErrorReason = normalized => {
  const reason = Array.isArray(normalized?.error)
    ? normalized.error
        .map(err => err?.errorMsg)
        .filter(Boolean)
        .join(', ')
    : normalized?.error;
  return typeof reason === 'string' ? reason : '';
};

const assertFynamicsSuccess = (normalized, fallbackMessage) => {
  if (normalized?.status == 1) return;
  throw new ProviderError(PROVIDER_ERROR_CATEGORY.NIC_BUSINESS_ERROR, fynamicsErrorReason(normalized) || fallbackMessage, {
    providerRaw: normalized,
    failoverEligible: false,
  });
};

class FynamicsProvider extends EInvoiceProvider {
  get providerName() {
    return THIRD_PARTY_PROVIDERS.FYNAMICS;
  }

  async doGenerateEInvoice(payload, context) {
    const { invoiceData, ewbDtlsValues, items, session } = payload;
    const { companyId, userId } = context;
    let normalized;
    try {
      normalized = await generateFynamicsEInvoice(invoiceData, ewbDtlsValues, companyId, userId, items, session);
    } catch (error) {
      // The IRN already exists at NIC (for example an earlier attempt, here or at the other provider, succeeded
      // unseen). Link the existing IRN to the invoice instead of failing.
      if (!isDuplicateIrnMessage(error?.message)) throw error;
      const { Invoice } = getBooksModels();
      const invoice = await Invoice.findById(invoiceData._id).session(session);
      normalized = invoice ? await getFynamicsEInvoiceByDocDetails(invoice, companyId, userId, session) : null;
      if (normalized?.status != 1) throw error;
    }
    assertFynamicsSuccess(normalized, 'Failed to generate E-Invoice');
    return { data: normalized?.data, providerRaw: normalized };
  }

  async doCancelEInvoice(payload, context) {
    const { cancellationDetails } = payload;
    const { companyId, userId, referenceId } = context;
    const normalized = await cancelFynamicsEInvoice(cancellationDetails, companyId, userId, referenceId);
    assertFynamicsSuccess(normalized, 'Failed to cancel E-Invoice');
    return { data: normalized?.data, providerRaw: normalized };
  }

  async doGenerateEWayBill(payload, context) {
    const { invoiceData, ewbDtlsValues, onlyEWayBill, session } = payload;
    const { companyId, userId } = context;
    const generate = onlyEWayBill ? generateFynamicsOnlyEWayBill : generateFynamicsEWayBill;
    const normalized = await generate(invoiceData, ewbDtlsValues, companyId, userId, session);
    assertFynamicsSuccess(normalized, 'Failed to generate E-Way Bill');
    return { data: normalized?.data, providerRaw: normalized };
  }

  async doCancelEWayBill(payload, context) {
    const { cancellationDetails } = payload;
    const { companyId, userId, referenceId } = context;
    const normalized = await cancelFynamicsEWayBill(cancellationDetails, companyId, userId, referenceId);
    assertFynamicsSuccess(normalized, 'Failed to cancel E-Way Bill');
    return { data: normalized?.data, providerRaw: normalized };
  }

  async doRefetchEInvoice(payload, context) {
    const { invoice, session } = payload;
    const { companyId, userId } = context;
    const normalized = await getFynamicsEInvoiceByDocDetails(invoice, companyId, userId, session);
    assertFynamicsSuccess(normalized, 'Failed to fetch E-Invoice details');
    return { data: normalized?.data, providerRaw: normalized };
  }

  async doVerifyGSTIN(payload, context) {
    const { gstin } = payload;
    const { companyId, userId } = context;
    const result = await getFynamicsGstDetails(gstin, companyId, userId);
    return { data: result?.data, providerRaw: result };
  }
}

module.exports = { FynamicsProvider };
