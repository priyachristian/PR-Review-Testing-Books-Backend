const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const {
  DEFAULT_ADDITIONAL_CHARGE_HSN,
  E_WAY_BILL_DOCUMENT_TYPES,
  E_WAY_BILL_DOCUMENT_TYPE_RULES,
  GST_DOCUMENT_TYPES,
} = require('../../../utils/enum');

/** Document type config for a provider document; documents built before types existed are invoices. */
const getGstDocumentType = document => document?.gstDocument || GST_DOCUMENT_TYPES.INVOICE;

/** Model the generated e-invoice / e-way bill is saved on. */
const getGstDocumentModel = document => getBooksModels()[getGstDocumentType(document).modelName];

const getGstDocumentLabel = document => getGstDocumentType(document).label;

/** True when the goods move from the customer back to the company, so sender and receiver are swapped. */
const isReturnMovement = document => Boolean(getGstDocumentType(document).partyIsSender);

const getEWayBillDefaults = (type, document) =>
  (document?.isStockTransfer && type.stockTransferEWayBillDefaults) || type.eWayBillDefaults;

/**
 * E-way bill document type to file: the one chosen, else the document type's default (the modal leaves an unchanged
 * default out). Rejects a combination NIC refuses for the supply type before any provider call is made.
 */
const resolveEWayBillDocumentType = (document, ewbDtls = {}) => {
  const documentType = ewbDtls.documentType || getEWayBillDefaults(getGstDocumentType(document), document).documentType;
  const allowed = E_WAY_BILL_DOCUMENT_TYPE_RULES[ewbDtls.supplyType]?.[ewbDtls.subSupplyType] || [];
  if (!allowed.includes(documentType)) {
    const allowedLabels = allowed.map(value => E_WAY_BILL_DOCUMENT_TYPES[value].label).join(' or ');
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      allowed.length
        ? `${E_WAY_BILL_DOCUMENT_TYPES[documentType]?.label || documentType} cannot be used for this supply type. Please choose ${allowedLabels}.`
        : 'This supply type and sub supply type combination is not allowed for an e-way bill.',
    );
  }
  return E_WAY_BILL_DOCUMENT_TYPES[documentType];
};

/** Swaps the sender and receiver fields of an e-way bill payload in place. `pairs` lists [fromKey, toKey]. */
const swapParties = (payload, pairs) => {
  pairs.forEach(([fromKey, toKey]) => {
    const fromValue = payload[fromKey];
    payload[fromKey] = payload[toKey];
    payload[toKey] = fromValue;
  });
  return payload;
};

/**
 * Shapes any supported document like the invoice the provider builders read: document number and date under the
 * invoice field names, the customer or vendor under `customer`, and the type config under `gstDocument`.
 */
const toProviderDocument = (type, document, party) => ({
  ...document,
  invoiceId: document[type.numberField],
  invoiceDate: document[type.dateField],
  addressId: type.partyBillingAddress ? party?.address?.billing?._id : document.addressId,
  customer: party,
  gstDocument: type,
});

const sameId = (left, right) => Boolean(left && right) && left.toString() === right.toString();

const hasAddressData = address => Boolean(address?.address?.street1 || address?.city || address?.pinCode || address?.state);

/**
 * The customer's or vendor's address chosen on the document (`addressId`), or null when it is not on the party.
 * It decides the place of supply, and so the tax, when the document is created, so the generated e-invoice and
 * e-way bill always follow it.
 */
const getDocumentAddress = document => {
  const { billing, shipping, additionalShippingAddresses = [] } = document?.customer?.address || {};
  return [billing, shipping, ...additionalShippingAddresses].find(address => sameId(address?._id, document?.addressId)) || null;
};

/** Ship-to for the e-invoice: the document's address; documents without one keep the old shipping-else-billing rule. */
const getEInvoiceShipToAddress = document => {
  const documentAddress = getDocumentAddress(document);
  if (documentAddress) return documentAddress;
  const { billing, shipping } = document?.customer?.address || {};
  return hasAddressData(shipping) ? shipping : billing;
};

const getAdditionalChargeHsn = (options, chargeIndex) => {
  const chosen = (options?.additionalChargeHsn || []).find(entry => entry.index === chargeIndex);
  return chosen?.hsn || DEFAULT_ADDITIONAL_CHARGE_HSN;
};

/**
 * Marks each document line `isService` from its item master category (`itemCategory.isService`), which the e-invoice
 * files per line as goods or service. One query for all lines; lines without an item master are goods.
 */
const attachItemServiceFlags = async ({ document, companyId }) => {
  const itemIds = [...new Set((document?.items || []).map(item => item.itemId?.toString()).filter(Boolean))];
  if (!itemIds.length) return document;

  const { Item } = getBooksCrmModels();
  const serviceItems = await Item.find({ _id: { $in: itemIds }, companyId, 'itemCategory.isService': true })
    .select('_id')
    .lean();
  const serviceItemIds = new Set(serviceItems.map(item => item._id.toString()));

  document.items = document.items.map(item => ({ ...item, isService: serviceItemIds.has(item.itemId?.toString()) }));
  return document;
};

const withoutEmpty = fields =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== ''));

/** `$set` fields recording what the user chose for the e-invoice, so the document shows what was filed. */
const buildEInvoiceOptionSnapshot = ({ options }) => {
  if (!options) return {};
  return withoutEmpty({
    'eInvoice.ecommerceGstin': options.ecommerceGstin,
    'eInvoice.sellerTradeName': options.sellerTradeName,
    'eInvoice.poNumber': options.poNumber,
    'eInvoice.poDate': options.poDate,
    'eInvoice.invoiceRemarks': options.remarks,
  });
};

/** `$set` fields recording what was filed on a standalone e-way bill. `document` is the provider document. */
const buildEWayBillOptionSnapshot = ({ options, document }) => {
  if (!options) return {};
  return withoutEmpty({
    'eWayBill.supplyType': options.supplyType,
    'eWayBill.subSupplyType': options.subSupplyType,
    'eWayBill.subSupplyDescription': options.subSupplyDesc,
    'eWayBill.documentType': options.documentType || getEWayBillDefaults(getGstDocumentType(document), document).documentType,
    'eWayBill.transDocNo': options.transDocNo,
    'eWayBill.transDocDate': options.transDocDate,
  });
};

const shortAddress = address => [address?.city, address?.state].filter(Boolean).join(', ') || '-';

/**
 * Choices, read-only movement and defaults the generate modal shows for a document.
 * `movement` is in the direction the goods travel: for a return the customer dispatches and the company receives.
 */
const buildGstDocumentOptions = ({ document, company, customer, type = GST_DOCUMENT_TYPES.INVOICE }) => {
  const providerDocument = toProviderDocument(type, document, customer);
  const companyPlace = shortAddress(company?.address);
  const partyPlace = shortAddress(getDocumentAddress(providerDocument));
  const isReturn = Boolean(type.partyIsSender);

  return {
    movement: {
      dispatchFrom: isReturn ? partyPlace : companyPlace,
      shipTo: isReturn ? companyPlace : partyPlace,
    },
    // The e-invoice reads seller to buyer, so a return shows no movement on it.
    eInvoiceShowsMovement: !isReturn,
    additionalCharges: (document?.additionalCharges || []).map((charge, index) => ({
      index,
      name: charge.name,
      hsn: DEFAULT_ADDITIONAL_CHARGE_HSN,
    })),
    // Credit Note (CNT) is left out: NIC accepts it for no supply type.
    documentTypes: Object.values(E_WAY_BILL_DOCUMENT_TYPES)
      .filter(({ value }) => value !== E_WAY_BILL_DOCUMENT_TYPES.CNT.value)
      .map(({ value, label }) => ({ value, label })),
    // Document types allowed per supply type and sub supply type, so the modal offers only valid ones.
    documentTypeRules: E_WAY_BILL_DOCUMENT_TYPE_RULES,
    defaults: {
      sellerTradeName: company?.name || '',
      ...getEWayBillDefaults(type, document),
    },
  };
};

module.exports = {
  getGstDocumentType,
  getGstDocumentModel,
  getGstDocumentLabel,
  isReturnMovement,
  swapParties,
  toProviderDocument,
  getEInvoiceShipToAddress,
  getAdditionalChargeHsn,
  resolveEWayBillDocumentType,
  attachItemServiceFlags,
  buildEInvoiceOptionSnapshot,
  buildEWayBillOptionSnapshot,
  buildGstDocumentOptions,
};
