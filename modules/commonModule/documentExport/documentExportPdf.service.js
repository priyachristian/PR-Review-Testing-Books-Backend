const React = require('react');
const dayjs = require('dayjs');
const QRCode = require('qrcode');
const { renderToBuffer } = require('@react-pdf/renderer');
const { PDFDocument } = require('pdf-lib');
const {
  MultiShowPDF,
  MultiPaymentPdf,
  ExpensePDF,
  setBaseCurrency,
  setPaymentPdfBaseCurrency,
  setExpensePdfBaseCurrency,
} = require('@smit9313/abss-pdf');
const logger = require('../../../config/logger');
const exportConfig = require('../../../config/documentPdfExport.config');
const { DOCUMENT_EXPORT_PDF_VARIANT } = require('../../../utils/enum');

const PDF_RENDER_FLAGS = {
  [DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT]: {
    showEInvoice: false,
    showEWayBill: false,
    showInvoice: true,
    isEinvoicingAvailable: false,
    isEwayBillingAvailable: false,
  },
  [DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE]: {
    showEInvoice: true,
    showEWayBill: false,
    showInvoice: true,
    isEinvoicingAvailable: true,
    isEwayBillingAvailable: false,
  },
  [DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL]: {
    showEInvoice: false,
    showEWayBill: true,
    showInvoice: false,
    isEinvoicingAvailable: false,
    isEwayBillingAvailable: true,
  },
  [DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE_AND_E_WAY_BILL]: {
    showEInvoice: true,
    showEWayBill: true,
    showInvoice: true,
    isEinvoicingAvailable: true,
    isEwayBillingAvailable: true,
  },
};

const buildEWayBillQrText = doc => {
  const eWayBill = doc?.eWayBill;
  if (!eWayBill?.eWayBillNo) return null;
  const dateStr = eWayBill.eWayBillDate ? dayjs(eWayBill.eWayBillDate).format('DD/MM/YYYY HH:mm:ss') : '-';
  return `EWB No: ${eWayBill.eWayBillNo} | Date: ${dateStr} | TransporterId: ${eWayBill.transporterId || '-'}`;
};

const toQrDataUrl = async text => {
  if (!text) return null;
  try {
    return await QRCode.toDataURL(text, { width: 200, margin: 1, errorCorrectionLevel: 'L' });
  } catch (err) {
    logger.warn(`[DocumentPdfExport] QR code skipped: ${err.message}`);
    return null;
  }
};

const mapDocumentForPdf = async (doc, moduleConfig, pdfVariant = DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT) => {
  if (!doc) return null;
  if (moduleConfig.pdfRenderer === 'payment') {
    return { data: doc, variant: moduleConfig.paymentVariant || 'received' };
  }
  if (moduleConfig.pdfRenderer === 'expense') {
    return { data: doc };
  }

  const flags = PDF_RENDER_FLAGS[pdfVariant] || PDF_RENDER_FLAGS[DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT];
  if (flags.showEInvoice && doc?.eInvoice?.status !== 'ACT') return null;
  if (flags.showEWayBill && doc?.eWayBill?.status !== 'ACT') return null;

  let billingAddress;
  if (moduleConfig.pageType === 'debitNote') {
    billingAddress = doc?.vendorId?.address?.billing;
  } else if (['purchaseOrder', 'grpo', 'bills'].includes(moduleConfig.pageType)) {
    billingAddress = doc?.vendor?.address?.billing;
  } else {
    billingAddress = doc?.customerId?.address?.billing;
  }

  let qrCodeUrl = null;
  let eWayBillQrCodeUrl = null;
  if (flags.showEInvoice) {
    qrCodeUrl = await toQrDataUrl(doc?.eInvoice?.signedQrCode);
  }
  if (flags.showEWayBill) {
    eWayBillQrCodeUrl = await toQrDataUrl(buildEWayBillQrText(doc));
  }

  return {
    data: doc,
    billingAddress,
    shippingAddress: doc?.shippingAddress,
    pageType: moduleConfig.pageType,
    qrCodeUrl,
    eWayBillQrCodeUrl,
    ...flags,
  };
};

const renderBatchToBuffer = async ({ mappedDocuments, profile, pdfRenderer }) => {
  if (profile?.baseCurrency) {
    setBaseCurrency(profile.baseCurrency);
    if (typeof setPaymentPdfBaseCurrency === 'function') {
      setPaymentPdfBaseCurrency(profile.baseCurrency);
    }
  }

  if (pdfRenderer === 'expense') {
    if (profile?.baseCurrency && typeof setExpensePdfBaseCurrency === 'function') {
      setExpensePdfBaseCurrency(profile.baseCurrency);
    }

    let combined = await PDFDocument.create();
    for (const item of mappedDocuments) {
      const buffer = await renderToBuffer(React.createElement(ExpensePDF, { data: item.data, profile }));
      combined = await appendPdfBuffer(combined, buffer);
    }
    return Buffer.from(await combined.save());
  }

  const PdfComponent = pdfRenderer === 'payment' ? MultiPaymentPdf : MultiShowPDF;
  const element = React.createElement(PdfComponent, {
    documents: mappedDocuments,
    profile,
  });
  return renderToBuffer(element);
};

const appendPdfBuffer = async (mergedPdf, batchPdfBuffer) => {
  const batchPdf = await PDFDocument.load(batchPdfBuffer);
  const pageIndices = batchPdf.getPageIndices();
  const copiedPages = await mergedPdf.copyPages(batchPdf, pageIndices);
  copiedPages.forEach(page => mergedPdf.addPage(page));
  return mergedPdf;
};

const abortDocumentExport = (documentId, reason) => {
  const error = new Error(
    documentId
      ? `Export aborted: document ${documentId} ${reason}. No PDF was created.`
      : `Export aborted: ${reason}. No PDF was created.`,
  );
  error.abortExport = true;
  if (documentId) error.documentId = String(documentId);
  return error;
};

const buildMergedPdfFromIds = async ({
  ids,
  companyId,
  moduleConfig,
  profile,
  getById,
  pdfVariant = DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT,
  onProgress,
  jobId,
}) => {
  const { BATCH_SIZE, BATCH_RETRY_ATTEMPTS } = exportConfig;
  let processed = 0;
  const total = ids.length;
  const totalBatches = Math.ceil(total / BATCH_SIZE) || 1;

  let mergedPdf = await PDFDocument.create();

  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const batchIds = ids.slice(offset, offset + BATCH_SIZE);
    const batchIndex = Math.floor(offset / BATCH_SIZE);
    let batchSucceeded = false;
    let lastError = null;

    for (let attempt = 0; attempt <= BATCH_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const docs = [];
        for (const id of batchIds) {
          try {
            const doc = await getById(id, companyId);
            if (!doc) {
              throw abortDocumentExport(id, 'was not found');
            }
            docs.push(doc);
          } catch (err) {
            if (err.abortExport) throw err;
            logger.warn(`[DocumentPdfExport] getById failed job=${jobId} id=${id}: ${err.message}`);
            throw abortDocumentExport(id, 'could not be loaded');
          }
        }

        const mapped = [];
        for (const doc of docs) {
          const documentId = doc?._id || doc?.id;
          const item = await mapDocumentForPdf(doc, moduleConfig, pdfVariant);
          if (!item?.data) {
            throw abortDocumentExport(documentId, 'could not be rendered');
          }
          mapped.push(item);
        }

        if (mapped.length) {
          const batchBuffer = await renderBatchToBuffer({
            mappedDocuments: mapped,
            profile,
            pdfRenderer: moduleConfig.pdfRenderer,
          });
          await appendPdfBuffer(mergedPdf, batchBuffer);
        }

        processed += batchIds.length;
        batchSucceeded = true;

        if (typeof onProgress === 'function') {
          await onProgress({ processed: Math.min(processed, total), total });
        }

        mapped.length = 0;
        docs.length = 0;
        break;
      } catch (err) {
        if (err.abortExport) throw err;
        lastError = err;
        logger.error(
          `[DocumentPdfExport] batch ${batchIndex + 1}/${totalBatches} attempt ${attempt + 1} failed job=${jobId}: ${err.message}`,
        );
      }
    }

    if (!batchSucceeded) {
      throw abortDocumentExport(null, lastError?.message || 'A document batch failed');
    }
  }

  if (mergedPdf.getPageCount() === 0) {
    const error = new Error(
      pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE
        ? 'No active e-invoices could be rendered for the selected filters.'
        : pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL
          ? 'No active e-way bills could be rendered for the selected filters.'
          : pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE_AND_E_WAY_BILL
            ? 'No documents with both an active e-invoice and an active e-way bill could be rendered.'
            : 'No documents could be rendered for the selected filters.',
    );
    throw error;
  }

  const mergedBytes = await mergedPdf.save();
  mergedPdf = null;

  return {
    buffer: Buffer.from(mergedBytes),
    processed: Math.min(processed, total),
    total,
  };
};

module.exports = {
  buildMergedPdfFromIds,
};
