const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { EInvoiceProvider } = require('./base.provider');
const { ProviderError, FAILOVER_ELIGIBLE_CATEGORIES } = require('./providerError');
const { THIRD_PARTY_PROVIDERS } = require('../../../../utils/enum');
const {
  MASTERS_INDIA_ROUTES,
  MASTERS_INDIA_COMMON_ROUTES,
  MASTERS_INDIA_EWAYBILL_GET_ACTIONS,
} = require('../../../../utils/mastersIndiaApiRoutes');
const { callMastersIndia, isDuplicateIrnError, isDuplicateEWayBillError } = require('./mastersIndia.client');
const { callMastersIndiaCommonApi } = require('./mastersIndiaCommonApi.client');
const {
  persistEInvoiceResult,
  persistEWayBillByIrnResult,
  persistStandaloneEWayBillResult,
  persistRefetchedEInvoiceResult,
  formatDocumentDate,
} = require('./mastersIndia.persistence');
const { buildGenerateEInvoicePayload } = require('./mappers/mastersIndiaEInvoice.mapper');
const { buildEWayBillByIrnPayload } = require('./mappers/mastersIndiaEwayBillByIrn.mapper');
const { buildStandaloneEWayBillPayload } = require('./mappers/mastersIndiaStandaloneEwayBill.mapper');
const { buildCancelEInvoicePayload } = require('./mappers/mastersIndiaCancelEInvoice.mapper');
const { buildCancelEWayBillPayload } = require('./mappers/mastersIndiaCancelEwayBill.mapper');
const { getGstDocumentType } = require('../../gstDocument/gstDocument.service');

/** Billing packages, the same ones the Fynamics path charges (ThirdPartyApiPackage.packageName). */
const E_INVOICE_PACKAGE = PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL;
const ONLY_E_WAY_BILL_PACKAGE = PLAN_FEATURES.ONLY_E_WAY_BILL;

/** Transient failure (timeout, network, 5xx): the request may have reached NIC and succeeded, so the outcome is unknown. */
const isOutcomeUnknown = error => error instanceof ProviderError && FAILOVER_ELIGIBLE_CATEGORIES.has(error.category);

const documentLookupParams = (invoice, company) => ({
  user_gstin: company?.gstNumber,
  document_type: getGstDocumentType(invoice).nicDocType,
  document_number: invoice.invoiceId,
  document_date: formatDocumentDate(invoice.invoiceDate),
});

/**
 * Shapes a GSTIN taxpayer search result (GSTN fields: lgnm, tradeNam, sts, pradr.addr) like the Fynamics lookup, so
 * the frontend reads both the same way. Missing fields are ''; the state code is the GSTIN's first two digits.
 */
const toGstinDetails = (details, gstin) => {
  const address = details?.pradr?.addr || {};
  const resolvedGstin = details?.gstin || gstin;
  return {
    ...details,
    Gstin: resolvedGstin,
    TradeName: details?.tradeNam || details?.lgnm || '',
    LegalName: details?.lgnm || '',
    AddrBno: address.bno || '',
    AddrBnm: address.bnm || '',
    AddrFlno: address.flno || '',
    AddrSt: address.st || '',
    AddrLoc: address.loc || address.city || address.dst || '',
    AddrPncd: address.pncd || '',
    StateCode: String(resolvedGstin || '').slice(0, 2),
    Status: details?.sts || '',
  };
};

class MastersIndiaProvider extends EInvoiceProvider {
  get providerName() {
    return THIRD_PARTY_PROVIDERS.MASTERS_INDIA;
  }

  async doGenerateEInvoice(payload, context) {
    const { invoiceData, ewbDtlsValues, company, session } = payload;
    const { userId } = context;

    const mastersIndiaPayload = await buildGenerateEInvoicePayload(invoiceData, ewbDtlsValues, company);
    const userGstin = mastersIndiaPayload.seller_details.gstin || company?.gstNumber;

    let results;
    let recovered = false;
    try {
      results = await callMastersIndia({
        ...context,
        route: MASTERS_INDIA_ROUTES.EINVOICE_GENERATE,
        data: { ...mastersIndiaPayload, user_gstin: userGstin },
        packageName: E_INVOICE_PACKAGE,
      });
    } catch (error) {
      if (!isDuplicateIrnError(error) && !isOutcomeUnknown(error)) throw error;
      results = await this.findByDocument(invoiceData, company, context);
      if (!results) throw error;
      recovered = true;
    }

    await persistEInvoiceResult({
      invoiceId: invoiceData._id,
      document: invoiceData,
      session,
      userId,
      data: results.message,
      info: results.InfoDtls,
      ewbDtlsValues,
      recovered,
    });
    return { data: results.message, providerRaw: results };
  }

  async doCancelEInvoice(payload, context) {
    const { cancellationDetails, company } = payload;

    const mastersIndiaPayload = buildCancelEInvoicePayload(cancellationDetails);
    const results = await callMastersIndia({
      ...context,
      route: MASTERS_INDIA_ROUTES.EINVOICE_CANCEL,
      data: { ...mastersIndiaPayload, user_gstin: company?.gstNumber },
      packageName: E_INVOICE_PACKAGE,
    });
    return { data: results.message, providerRaw: results };
  }

  async doGenerateEWayBill(payload, context) {
    const { invoiceData, ewbDtlsValues, company, onlyEWayBill, session } = payload;
    const { userId } = context;
    const userGstin = company?.gstNumber;

    // `onlyEWayBill` is decided once by the caller (active IRN means by-IRN flow, otherwise standalone).
    if (onlyEWayBill) {
      const mastersIndiaPayload = await buildStandaloneEWayBillPayload(invoiceData, ewbDtlsValues, company);
      let results;
      let recovered = false;
      try {
        results = await callMastersIndia({
          ...context,
          route: MASTERS_INDIA_ROUTES.EWAYBILL_GENERATE,
          data: { ...mastersIndiaPayload, userGstin, data_source: 'erp' },
          packageName: ONLY_E_WAY_BILL_PACKAGE,
        });
      } catch (error) {
        // A timed-out call may have created the e-way bill at NIC, and NIC 604 means one exists for this document:
        // link the existing one instead of leaving it unrecorded (or generating a second one on a retry).
        if (!isOutcomeUnknown(error) && !isDuplicateEWayBillError(error)) throw error;
        results = await this.findEWayBillByDocument(invoiceData, mastersIndiaPayload, userGstin, context);
        if (!results) throw error;
        recovered = true;
      }
      await persistStandaloneEWayBillResult({
        invoiceId: invoiceData._id,
        document: invoiceData,
        session,
        userId,
        data: results.message,
        ewbDtlsValues,
        recovered,
      });
      return { data: results.message, providerRaw: results };
    }

    const mastersIndiaPayload = buildEWayBillByIrnPayload(invoiceData, ewbDtlsValues);
    let results;
    try {
      results = await callMastersIndia({
        ...context,
        route: MASTERS_INDIA_ROUTES.EINVOICE_GENERATE_EWAYBILL,
        data: { ...mastersIndiaPayload, user_gstin: userGstin, data_source: 'erp' },
        packageName: E_INVOICE_PACKAGE,
      });
    } catch (error) {
      // Unknown outcome: the e-way bill may already exist. NIC returns it with the IRN details, so link it if it does.
      if (!isOutcomeUnknown(error)) throw error;
      const existing = await this.findByDocument(invoiceData, company, context);
      if (!existing?.message?.EwbNo) throw error;
      results = existing;
    }
    await persistEWayBillByIrnResult({
      invoiceId: invoiceData._id,
      document: invoiceData,
      session,
      userId,
      data: results.message,
      info: results.InfoDtls,
      irn: invoiceData?.eInvoice?.irn,
      ewbDtlsValues,
    });
    return { data: results.message, providerRaw: results };
  }

  async doCancelEWayBill(payload, context) {
    const { cancellationDetails, company } = payload;

    const mastersIndiaPayload = buildCancelEWayBillPayload(cancellationDetails);
    const results = await callMastersIndia({
      ...context,
      route: MASTERS_INDIA_ROUTES.EWAYBILL_CANCEL,
      data: { ...mastersIndiaPayload, userGstin: company?.gstNumber },
      packageName: E_INVOICE_PACKAGE,
    });
    return { data: results.message, providerRaw: results };
  }

  /** NIC serves get-einvoice-bydoc only for recent documents; "IRN not found" (2154) is a business error and does not fail over. */
  async doRefetchEInvoice(payload, context) {
    const { invoice, company, session } = payload;
    const { userId } = context;

    const results = await callMastersIndia({
      ...context,
      method: 'get',
      route: MASTERS_INDIA_ROUTES.EINVOICE_GET_BY_DOC,
      params: documentLookupParams(invoice, company),
      packageName: E_INVOICE_PACKAGE,
    });

    await persistRefetchedEInvoiceResult({ invoice, session, userId, data: results.message, info: results.InfoDtls });
    return { data: results.message, providerRaw: results };
  }

  async findByDocument(invoice, company, context) {
    try {
      const results = await callMastersIndia({
        ...context,
        method: 'get',
        route: MASTERS_INDIA_ROUTES.EINVOICE_GET_BY_DOC,
        params: documentLookupParams(invoice, company),
      });
      return results?.message?.Irn ? results : null;
    } catch (lookupError) {
      return null;
    }
  }

  /**
   * The e-way bill this GSTIN generated for the document (same document type and number as the generate request), or
   * null. One the document already had and cancelled is not a match: NIC allows a new e-way bill after a cancellation.
   */
  async findEWayBillByDocument(invoice, generatePayload, userGstin, context) {
    try {
      const results = await callMastersIndia({
        ...context,
        method: 'get',
        route: MASTERS_INDIA_ROUTES.EWAYBILL_GET,
        params: {
          action: MASTERS_INDIA_EWAYBILL_GET_ACTIONS.BY_CONSIGNOR_DOCUMENT,
          gstin: userGstin,
          document_type: generatePayload.document_type,
          document_number: generatePayload.document_number,
        },
      });
      const eWayBillNo = Number(results?.message?.ewayBillNo);
      if (!eWayBillNo || eWayBillNo === Number(invoice?.eWayBill?.eWayBillNo)) return null;
      return results;
    } catch (lookupError) {
      return null;
    }
  }

  /** GSTIN taxpayer search on the common API, so it works for e-way-bill-only companies too (not the e-invoice API). */
  async doVerifyGSTIN(payload, context) {
    const { gstin, company } = payload;

    const details = await callMastersIndiaCommonApi({
      ...context,
      route: MASTERS_INDIA_COMMON_ROUTES.SEARCH_GSTIN,
      params: { gstin },
      packageName: company?.applicableFeature,
    });
    return { data: toGstinDetails(typeof details === 'object' && details ? details : {}, gstin), providerRaw: details };
  }
}

module.exports = { MastersIndiaProvider };
