const moment = require('moment-timezone');
const httpStatus = require('http-status');
const ApiError = require('../../../../../utils/ApiError');

const IST_TIMEZONE = 'Asia/Kolkata';
const formatIstDate = value => moment.tz(value, IST_TIMEZONE).format('DD/MM/YYYY');

const buildEWayBillByIrnPayload = (invoiceData, ewbDtlsValues) => {
  const irn = invoiceData?.eInvoice?.irn;
  if (!irn) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'IRN not found for this invoice. Please generate the e-invoice first.');
  }

  const payload = {
    irn,
    distance: Number(ewbDtlsValues?.Distance) || 0,
  };

  if (ewbDtlsValues?.TransMode) payload.transportation_mode = ewbDtlsValues.TransMode;
  if (ewbDtlsValues?.TransId) payload.transporter_id = ewbDtlsValues.TransId;
  if (ewbDtlsValues?.TransName) payload.transporter_name = ewbDtlsValues.TransName;

  if (ewbDtlsValues?.TransMode === '1') {
    payload.vehicle_number = ewbDtlsValues.VehNo;
    payload.vehicle_type = ewbDtlsValues.VehType;
  } else if (ewbDtlsValues?.TransMode === '2') {
    payload.transporter_document_number = ewbDtlsValues.RRNo;
    payload.transporter_document_date = formatIstDate(ewbDtlsValues.RRDate);
  } else if (ewbDtlsValues?.TransMode === '3') {
    payload.transporter_document_number = ewbDtlsValues.AWBNo;
    payload.transporter_document_date = formatIstDate(ewbDtlsValues.AWBDate);
  } else if (ewbDtlsValues?.TransMode === '4') {
    payload.transporter_document_number = ewbDtlsValues.BLNo;
    payload.transporter_document_date = formatIstDate(ewbDtlsValues.BLDate);
  }

  return payload;
};

module.exports = { buildEWayBillByIrnPayload };
