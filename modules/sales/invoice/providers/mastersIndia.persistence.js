const moment = require('moment-timezone');
const { getGstDocumentModel, getGstDocumentLabel } = require('../../gstDocument/gstDocument.service');
const { THIRD_PARTY_PROVIDERS, E_INVOICE_STATUS } = require('../../../../utils/enum');

const IST_TIMEZONE = 'Asia/Kolkata';
const parseMastersIndiaDate = value => (value ? moment.tz(value, 'YYYY-MM-DD HH:mm:ss', IST_TIMEZONE).toDate() : null);

const buildQrCode = signedQrCode => {
  const payloadPart = typeof signedQrCode === 'string' ? signedQrCode.split('.')[1] : null;
  if (payloadPart) {
    try {
      const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
      if (decoded?.iss && decoded?.data) return decoded;
    } catch (err) {
      // fall through to the raw token below
    }
  }
  return { iss: 'NIC', data: signedQrCode || '' };
};

const distanceFromProviderInfo = (...sources) => {
  for (const source of sources) {
    let text = source;
    if (typeof text === 'string' && text.trim().startsWith('[')) {
      try {
        text = JSON.parse(text)
          .map(item => item?.Desc)
          .filter(Boolean)
          .join(' ');
      } catch (err) {
        // keep the raw string
      }
    }
    if (typeof text !== 'string') continue;
    // Matches "26 KM" (e-invoice/by-IRN alert format) or "Distance between these two pincodes is 26" (standalone format).
    const match = text.match(/(\d+)\s*KM/i) || text.match(/distance\b.*?\bis\s+(\d+)/i);
    if (match) return Number(match[1]);
  }
  return null;
};

const buildTransporterFields = ewbDtlsValues => {
  const fields = {};
  if (ewbDtlsValues?.TransMode) fields.transportMode = ewbDtlsValues.TransMode;
  if (ewbDtlsValues?.TransId) fields.transporterId = ewbDtlsValues.TransId;
  if (ewbDtlsValues?.TransName) fields.transporterName = ewbDtlsValues.TransName;

  if (ewbDtlsValues?.TransMode === '1') {
    fields.vehicleNumber = ewbDtlsValues.VehNo;
    fields.vehicleType = ewbDtlsValues.VehType;
  } else if (ewbDtlsValues?.TransMode === '2') {
    fields.railwayReceiptNumber = ewbDtlsValues.RRNo;
    fields.railwayReceiptDate = ewbDtlsValues.RRDate;
  } else if (ewbDtlsValues?.TransMode === '3') {
    fields.airwayBillNumber = ewbDtlsValues.AWBNo;
    fields.airwayBillDate = ewbDtlsValues.AWBDate;
  } else if (ewbDtlsValues?.TransMode === '4') {
    fields.seawayBillNumber = ewbDtlsValues.BLNo;
    fields.seawayBillDate = ewbDtlsValues.BLDate;
  }
  return fields;
};

const persistEInvoiceResult = async ({ invoiceId, document, session, userId, data, info, ewbDtlsValues, recovered = false }) => {
  const invoice = await getGstDocumentModel(document).findById(invoiceId).session(session);
  if (!invoice) return;
  const docNo = document?.invoiceId ?? invoice.invoiceId;
  const documentLabel = getGstDocumentLabel(document);

  invoice.eInvoice = {
    status: data?.Status || E_INVOICE_STATUS.ACT.value,
    QRCode: buildQrCode(data?.SignedQRCode),
    irn: data?.Irn,
    remarks: data?.Remarks,
    signedQrCode: data?.SignedQRCode,
    signedInvoice: data?.SignedInvoice,
    ackNo: data?.AckNo,
    ackDate: parseMastersIndiaDate(data?.AckDt),
    docNo,
    provider: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
    qrCodeUrl: data?.QRCodeUrl,
    pdfUrl: data?.EinvoicePdf,
  };

  if (data?.EwbNo) {
    invoice.eWayBill = {
      eWayBillNo: Number(data.EwbNo || 0),
      eWayBillDate: parseMastersIndiaDate(data?.EwbDt),
      eWayBillExpiryDate: parseMastersIndiaDate(data?.EwbValidTill),
      linkedIrn: data?.Irn,
      provider: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
      pdfUrl: data?.EwaybillPdf,
      transDocNo: docNo,
      distance: distanceFromProviderInfo(data?.Remarks, info) ?? (Number(ewbDtlsValues?.Distance) || 0),
      ...buildTransporterFields(ewbDtlsValues),
    };
  }

  const recoveredNote = recovered ? ' (recovered from an earlier generation at Masters India)' : '';
  const generationMessage = data?.EwbNo
    ? `E-Invoice (IRN: ${invoice.eInvoice.irn}) and E-Way Bill (No: ${invoice.eWayBill.eWayBillNo}) generated successfully for ${documentLabel} No: ${invoice.eInvoice.docNo}${recoveredNote}.`
    : `E-Invoice (IRN: ${invoice.eInvoice.irn}) generated successfully for ${documentLabel} No: ${invoice.eInvoice.docNo}${recoveredNote}.`;
  invoice.commentHistory.push({ message: generationMessage, addedBy: userId, createdAt: new Date() });
  invoice.updatedBy = userId;
  await invoice.save({ session });
};

const persistEWayBillByIrnResult = async ({ invoiceId, document, session, userId, data, info, irn, ewbDtlsValues }) => {
  const invoice = await getGstDocumentModel(document).findById(invoiceId).session(session);
  if (!invoice) return;
  const docNo = document?.invoiceId ?? invoice.invoiceId;
  const documentLabel = getGstDocumentLabel(document);

  invoice.eWayBill = {
    eWayBillNo: Number(data?.EwbNo || 0),
    eWayBillDate: parseMastersIndiaDate(data?.EwbDt),
    eWayBillExpiryDate: parseMastersIndiaDate(data?.EwbValidTill),
    linkedIrn: irn,
    provider: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
    pdfUrl: data?.EwaybillPdf,
    transDocNo: docNo,
    distance: distanceFromProviderInfo(data?.Remarks, info) ?? (Number(ewbDtlsValues?.Distance) || 0),
    ...buildTransporterFields(ewbDtlsValues),
  };
  invoice.commentHistory.push({
    message: `E-Way Bill (No: ${invoice.eWayBill.eWayBillNo}) generated successfully for ${documentLabel} No: ${docNo}.`,
    addedBy: userId,
    createdAt: new Date(),
  });
  invoice.updatedBy = userId;
  await invoice.save({ session });
};

const parseMastersIndiaStandaloneDate = value =>
  value ? moment.tz(value, 'DD/MM/YYYY hh:mm:ss A', IST_TIMEZONE).toDate() : null;

const persistStandaloneEWayBillResult = async ({
  invoiceId,
  document,
  session,
  userId,
  data,
  ewbDtlsValues,
  recovered = false,
}) => {
  const invoice = await getGstDocumentModel(document).findById(invoiceId).session(session);
  if (!invoice) return;
  const docNo = document?.invoiceId ?? invoice.invoiceId;
  const documentLabel = getGstDocumentLabel(document);

  invoice.eWayBill = {
    eWayBillNo: Number(data?.ewayBillNo || 0),
    eWayBillDate: parseMastersIndiaStandaloneDate(data?.ewayBillDate),
    eWayBillExpiryDate: parseMastersIndiaStandaloneDate(data?.validUpto),
    provider: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
    pdfUrl: data?.url,
    transDocNo: docNo,
    distance: distanceFromProviderInfo(data?.alert) ?? (Number(ewbDtlsValues?.Distance) || 0),
    ...buildTransporterFields({
      TransMode: ewbDtlsValues?.transportMode,
      TransId: ewbDtlsValues?.transporterId,
      TransName: ewbDtlsValues?.transporterName,
      VehNo: ewbDtlsValues?.VehNo,
      VehType: ewbDtlsValues?.VehType,
      RRNo: ewbDtlsValues?.RRNo,
      RRDate: ewbDtlsValues?.RRDate,
      AWBNo: ewbDtlsValues?.AWBNo,
      AWBDate: ewbDtlsValues?.AWBDate,
      BLNo: ewbDtlsValues?.BLNo,
      BLDate: ewbDtlsValues?.BLDate,
    }),
  };
  const recoveredNote = recovered ? ' (recovered from an earlier generation at Masters India)' : '';
  invoice.commentHistory.push({
    message: `E-Way Bill (No: ${invoice.eWayBill.eWayBillNo}) generated successfully for ${documentLabel} No: ${docNo}${recoveredNote}.`,
    addedBy: userId,
    createdAt: new Date(),
  });
  invoice.updatedBy = userId;
  await invoice.save({ session });
};

const persistRefetchedEInvoiceResult = async ({ invoice, session, userId, data, info }) => {
  invoice.eInvoice = {
    status: data?.Status || E_INVOICE_STATUS.ACT.value,
    QRCode: buildQrCode(data?.SignedQRCode),
    irn: data?.Irn,
    remarks: data?.Remarks,
    signedQrCode: data?.SignedQRCode,
    signedInvoice: data?.SignedInvoice,
    ackNo: data?.AckNo,
    ackDate: parseMastersIndiaDate(data?.AckDt),
    docNo: invoice.invoiceId,
    provider: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
    qrCodeUrl: data?.QRCodeUrl,
    pdfUrl: data?.EinvoicePdf,
  };

  if (data?.EwbNo && Number(data.EwbNo) !== Number(invoice.eWayBill?.eWayBillNo)) {
    invoice.eWayBill = {
      eWayBillNo: Number(data.EwbNo),
      eWayBillDate: parseMastersIndiaDate(data?.EwbDt),
      eWayBillExpiryDate: parseMastersIndiaDate(data?.EwbValidTill),
      linkedIrn: data?.Irn,
      provider: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
      pdfUrl: data?.EwaybillPdf,
      transDocNo: invoice.invoiceId,
      distance: distanceFromProviderInfo(data?.Remarks, info) ?? 0,
    };
  }

  invoice.commentHistory.push({
    message: `E-Invoice (IRN: ${invoice.eInvoice.irn}) re-fetched for Invoice No: ${invoice.invoiceId}.`,
    addedBy: userId,
    createdAt: new Date(),
  });
  invoice.updatedBy = userId;
  await invoice.save({ session });
};

const formatDocumentDate = value => moment.tz(value || new Date(), IST_TIMEZONE).format('DD/MM/YYYY');

module.exports = {
  persistEInvoiceResult,
  persistEWayBillByIrnResult,
  persistStandaloneEWayBillResult,
  persistRefetchedEInvoiceResult,
  formatDocumentDate,
};
