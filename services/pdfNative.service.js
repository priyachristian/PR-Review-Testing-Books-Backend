const React = require('react');
const dayjs = require('dayjs');
const QRCode = require('qrcode');
const { renderToBuffer } = require('@react-pdf/renderer');
const {
  ShowPDF,
  ExpensePDF,
  ProductionOrderDetailPdf,
  setBaseCurrency,
  setExpensePdfBaseCurrency,
} = require('@smit9313/abss-pdf');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const logger = require('../config/logger');
const { MODULE_NAMES, E_INVOICE_STATUS, E_WAY_BILL_STATUS } = require('../utils/enum');
const { getPrimaryBank } = require('../modules/banking/bank/bank.service');

class PdfGenerationError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PdfGenerationError';
    this.retryable = true;
    this.meta = meta;
  }
}

const MODULE_TO_PAGE_TYPE = {
  [MODULE_NAMES.QUOTATION]: 'quote',
  [MODULE_NAMES.SALES_ORDER]: 'salesOrder',
  [MODULE_NAMES.DELIVERY_CHALLAN]: 'deliveryChallan',
  [MODULE_NAMES.INVOICE]: 'invoice',
  [MODULE_NAMES.CREDIT_NOTE]: 'creditNote',
  [MODULE_NAMES.PURCHASE_ORDER]: 'purchaseOrder',
  [MODULE_NAMES.GRPO]: 'grpo',
  [MODULE_NAMES.BILL]: 'bills',
  [MODULE_NAMES.DEBIT_NOTE]: 'debitNote',
};

const VENDOR_ADDRESS_FIELD = {
  [MODULE_NAMES.PURCHASE_ORDER]: 'vendor',
  [MODULE_NAMES.GRPO]: 'vendor',
  [MODULE_NAMES.BILL]: 'vendor',
  [MODULE_NAMES.DEBIT_NOTE]: 'vendorId',
};

const getBillingAddress = (moduleName, document) => {
  const vendorField = VENDOR_ADDRESS_FIELD[moduleName];
  if (vendorField) return document?.[vendorField]?.address?.billing;
  return document?.customerId?.address?.billing;
};

const renderShowPdfElement = ({ moduleName, document, profile }) => {
  const hasEInvoice = Boolean(document?.eInvoice?.irn || document?.eInvoice?.signedQrCode);

  return React.createElement(ShowPDF, {
    data: document,
    billingAddress: getBillingAddress(moduleName, document),
    shippingAddress: document?.shippingAddress,
    profile,
    pageType: MODULE_TO_PAGE_TYPE[moduleName],
    isEinvoicingAvailable: hasEInvoice,
    showEInvoice: hasEInvoice,
  });
};

const generateQrDataUrl = async text => {
  if (!text) return null;
  try {
    return await QRCode.toDataURL(text, { width: 200, margin: 1, errorCorrectionLevel: 'L' });
  } catch (error) {
    logger.error('generateQrDataUrl failed:', error);
    return null;
  }
};

const buildEWayBillQrText = eWayBill =>
  `EWB No: ${eWayBill?.eWayBillNo} | Date: ${
    eWayBill?.eWayBillDate ? dayjs(eWayBill.eWayBillDate).format('DD/MM/YYYY HH:mm:ss') : '-'
  } | TransporterId: ${eWayBill?.transporterId || '-'}`;

const renderInvoiceElement = async ({ document, profile }) => {
  const isEinvoicingAvailable = profile?.applicableFeature === PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL;
  const isEwayBillingAvailable = profile?.applicableFeature === PLAN_FEATURES.ONLY_E_WAY_BILL;

  const isEInvoiceActive = Boolean(document?.eInvoice) && document.eInvoice.status === E_INVOICE_STATUS.ACT.value;
  const isEWayBillActive = Boolean(document?.eWayBill) && document.eWayBill.status === E_WAY_BILL_STATUS.ACT.value;

  const showEInvoice = isEinvoicingAvailable && isEInvoiceActive;
  const showEWayBill = (isEinvoicingAvailable || isEwayBillingAvailable) && isEWayBillActive;

  const [qrCodeUrl, eWayBillQrCodeUrl] = await Promise.all([
    showEInvoice ? generateQrDataUrl(document?.eInvoice?.signedQrCode) : null,
    showEWayBill ? generateQrDataUrl(buildEWayBillQrText(document?.eWayBill)) : null,
  ]);

  return React.createElement(ShowPDF, {
    data: document,
    billingAddress: getBillingAddress(MODULE_NAMES.INVOICE, document),
    shippingAddress: document?.shippingAddress,
    profile,
    pageType: MODULE_TO_PAGE_TYPE[MODULE_NAMES.INVOICE],
    isEinvoicingAvailable,
    isEwayBillingAvailable,
    showEInvoice,
    showEWayBill,
    qrCodeUrl,
    eWayBillQrCodeUrl,
    includeDispatchDetails: true,
  });
};

const MODULE_RENDERERS = {
  [MODULE_NAMES.QUOTATION]: renderShowPdfElement,
  [MODULE_NAMES.SALES_ORDER]: renderShowPdfElement,
  [MODULE_NAMES.DELIVERY_CHALLAN]: renderShowPdfElement,
  [MODULE_NAMES.INVOICE]: renderInvoiceElement,
  [MODULE_NAMES.CREDIT_NOTE]: renderShowPdfElement,
  [MODULE_NAMES.PURCHASE_ORDER]: renderShowPdfElement,
  [MODULE_NAMES.GRPO]: renderShowPdfElement,
  [MODULE_NAMES.BILL]: renderShowPdfElement,
  [MODULE_NAMES.DEBIT_NOTE]: renderShowPdfElement,
  [MODULE_NAMES.EXPENSE]: async ({ companyId, document, profile }) => {
    const defaultBank = await getPrimaryBank(companyId);
    return React.createElement(ExpensePDF, { data: document, profile, defaultBank });
  },

  [MODULE_NAMES.PRODUCTION_ORDER]: ({ document, profile }) =>
    React.createElement(ProductionOrderDetailPdf, { data: document, profile }),
};

const isNativePdfModule = moduleName => Boolean(MODULE_RENDERERS[moduleName]);

const generateNativePdf = async ({ companyId, moduleName, document, profile, fileName }) => {
  const renderer = MODULE_RENDERERS[moduleName];
  if (!renderer) {
    logger.warn(`generateNativePdf: unsupported module ${moduleName}`);
    return null;
  }

  if (!document || !profile) {
    logger.warn('generateNativePdf: missing document or profile');
    return null;
  }

  try {
    if (profile?.baseCurrency) {
      setBaseCurrency(profile.baseCurrency);
      setExpensePdfBaseCurrency(profile.baseCurrency);
    }
    const element = await renderer({ companyId, moduleName, document, profile });
    const buffer = await renderToBuffer(element);

    return {
      content: buffer,
      filename: fileName,
      contentType: 'application/pdf',
    };
  } catch (error) {
    logger.error(`generateNativePdf failed for module ${moduleName}:`, error);
    throw new PdfGenerationError(error?.message || 'Native PDF rendering failed', { moduleName });
  }
};

module.exports = {
  generateNativePdf,
  isNativePdfModule,
  MODULE_TO_PAGE_TYPE,
  PdfGenerationError,
};
