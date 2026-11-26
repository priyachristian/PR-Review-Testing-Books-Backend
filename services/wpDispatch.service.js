const axios = require('axios');
const moment = require('moment');
const logger = require('../config/logger');
const { MODULE_NAMES } = require('../utils/enum');
const { getBooksModels, getBooksCrmModels } = require('./model.service');
const { isWhatsAppConfigured, sendWhatsAppTemplate, uploadWhatsAppMedia } = require('../utils/whatsapp');
const { createQueue } = require('../config/queueConfig');
const { isModuleWhatsAppEnabled, buildNotificationJobId, MODULE_WHATSAPP_QUEUE } = require('./moduleEmailNotification.service');

const DISPATCH_TEMPLATES = {
  TRANSPORT_COURIER: { name: 'invoice_dispatch_details', languageCode: 'en' },
  FULL_TRUCK_LOAD: { name: 'full_truck_load_dispatch', languageCode: 'en' },
  DELIVERY_PICKUP: { name: 'delivery_pickup_update', languageCode: 'en' },
};

const formatDate = date => {
  if (!date) return '-';
  const m = moment(date);
  return m.isValid() ? m.format('DD-MMM-YYYY') : '-';
};

const sanitizeText = val => {
  if (val === null || val === undefined) return '-';
  const str = String(val).trim();
  return str.length > 0 ? str : '-';
};

const getAttachmentUrl = files => {
  const fileUrl = Array.isArray(files)
    ? files.find(file => typeof file === 'string' && file.trim())
    : typeof files === 'string' && files.trim()
      ? files.trim()
      : null;
  return fileUrl || null;
};

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const filenameFromUrl = url => {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return base.trim() || 'attachment';
  } catch {
    return 'attachment';
  }
};

// WhatsApp rejects media filenames that contain spaces.
const safeMediaFilename = name => {
  const withoutPrefix = String(name || 'attachment').replace(/^\d+_/, '');
  const cleaned = withoutPrefix
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
  return cleaned || 'attachment';
};

const downloadDispatchAttachment = async attachmentUrl => {
  const response = await axios.get(attachmentUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 16 * 1024 * 1024,
  });
  const filename = safeMediaFilename(filenameFromUrl(attachmentUrl));
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  const headerType = String(response.headers['content-type'] || '')
    .split(';')[0]
    .trim();
  const mimeType =
    headerType && headerType !== 'application/octet-stream' ? headerType : MIME_BY_EXT[ext] || 'application/octet-stream';

  return { buffer: Buffer.from(response.data), filename, mimeType };
};

const uploadDispatchAttachment = async attachmentUrl => {
  const file = await downloadDispatchAttachment(attachmentUrl);
  const mediaId = await uploadWhatsAppMedia({
    buffer: file.buffer,
    filename: file.filename,
    mimeType: file.mimeType,
  });

  return { mediaId, filename: file.filename };
};

const getDispatchFileUrl = link => (link && link !== '-' ? link : null);

const withFileLink = fileUrl => ({
  attachmentName: '',
  attachmentLink: fileUrl || '-',
});

const toWhatsAppBody = values => [
  {
    type: 'body',
    parameters: values.map(text => ({ type: 'text', text: sanitizeText(text) })),
  },
];

const buildInvoiceDispatchTemplateData = ({ dispatch, invoice, customer, transportCourierName, recipientName }) => {
  const primaryContactName = [customer?.bpPrimaryContactName?.firstName, customer?.bpPrimaryContactName?.lastName]
    .filter(Boolean)
    .join(' ');
  const common = {
    recipientName: sanitizeText(
      recipientName ||
        customer?.recipientName ||
        primaryContactName ||
        customer?.customerDisplayName ||
        customer?.companyName ||
        'Customer',
    ),
    dispatchDate: formatDate(dispatch?.createdAt),
    documentNumber: sanitizeText(invoice?.invoiceId),
    customerName: sanitizeText(customer?.customerDisplayName || customer?.companyName || 'Customer'),
    invoiceDate: formatDate(invoice?.invoiceDate),
  };

  if (dispatch?.dispatchMode === 'Transport & Courier Service') {
    return {
      ...common,
      dispatchMode: 'Transport',
      transportType: sanitizeText(dispatch.transportCourier?.transportType),
      transporterName: sanitizeText(transportCourierName),
      trackingNumber: sanitizeText(dispatch.transportCourier?.trackingNumber),
      trackingLink: sanitizeText(dispatch.transportCourier?.trackingLink),
      bookingDate: formatDate(dispatch.goodsBookingDate),
      expectedDeliveryDate: formatDate(dispatch.approxDeliveryDate),
      ...withFileLink(getAttachmentUrl(dispatch.transportCourier?.bookingCopyImage)),
    };
  }

  if (dispatch?.dispatchMode === 'Full Truck Load') {
    return {
      ...common,
      vehicleNumber: sanitizeText(dispatch.truckLoad?.truckNumber),
      truckType: sanitizeText(dispatch.dispatchMode),
      driverName: sanitizeText(dispatch.truckLoad?.driverName),
      driverContact: sanitizeText(dispatch.truckLoad?.driverContact),
      dispatchStatus: sanitizeText(dispatch.dispatchStatus || 'Dispatched'),
      bookingDate: formatDate(dispatch.goodsBookingDate),
      expectedDeliveryDate: formatDate(dispatch.approxDeliveryDate),
      ...withFileLink(getAttachmentUrl(dispatch.truckLoad?.truck_goodsImage)),
    };
  }

  if (dispatch?.dispatchMode === 'OurSelf Delivery' || dispatch?.dispatchMode === 'Pickup By Customer') {
    return {
      ...common,
      dispatchMode: dispatch.dispatchMode === 'Pickup By Customer' ? 'Customer Pickup' : 'Self Delivery',
      deliveryPickupPerson: sanitizeText(dispatch.selfDelivery?.deliveryBoyName || dispatch.selfDelivery?.driverName),
      vehicleNumber: sanitizeText(dispatch.selfDelivery?.vehicleNumber),
      contactNumber: sanitizeText(dispatch.selfDelivery?.driverContact),
      dispatchPickupDate: formatDate(dispatch.goodsBookingDate || dispatch.createdAt),
      expectedDeliveryDate: formatDate(dispatch.approxDeliveryDate),
      ...withFileLink(getAttachmentUrl(dispatch.selfDelivery?.vehicle_goodsImage)),
    };
  }

  return null;
};

const buildDocumentHeader = media => ({
  type: 'header',
  parameters: [
    {
      type: 'document',
      document: {
        id: media.mediaId,
        filename: media.filename,
      },
    },
  ],
});

const bodyFromFields = (data, fields) => (data ? toWhatsAppBody(fields.map(field => data[field])) : []);

const COMMON_BODY_FIELDS = ['dispatchDate', 'documentNumber', 'customerName', 'invoiceDate'];

const TRANSPORT_BODY_FIELDS = [
  ...COMMON_BODY_FIELDS,
  'dispatchMode',
  'transportType',
  'transporterName',
  'trackingNumber',
  'trackingLink',
  'bookingDate',
  'expectedDeliveryDate',
];

const TRUCK_BODY_FIELDS = [
  ...COMMON_BODY_FIELDS,
  'vehicleNumber',
  'truckType',
  'driverName',
  'driverContact',
  'dispatchStatus',
  'bookingDate',
  'expectedDeliveryDate',
];

const DELIVERY_BODY_FIELDS = [
  ...COMMON_BODY_FIELDS,
  'dispatchMode',
  'deliveryPickupPerson',
  'vehicleNumber',
  'contactNumber',
  'dispatchPickupDate',
  'expectedDeliveryDate',
];

const buildInvoiceDispatchDetailsComponents = data => bodyFromFields(data, TRANSPORT_BODY_FIELDS);
const buildFullTruckLoadDispatchComponents = data => bodyFromFields(data, TRUCK_BODY_FIELDS);
const buildDeliveryPickupUpdateComponents = data => bodyFromFields(data, DELIVERY_BODY_FIELDS);

const TEMPLATE_BY_MODE = {
  'Transport & Courier Service': {
    template: DISPATCH_TEMPLATES.TRANSPORT_COURIER,
    build: buildInvoiceDispatchDetailsComponents,
  },
  'Full Truck Load': {
    template: DISPATCH_TEMPLATES.FULL_TRUCK_LOAD,
    build: buildFullTruckLoadDispatchComponents,
  },
  'OurSelf Delivery': {
    template: DISPATCH_TEMPLATES.DELIVERY_PICKUP,
    build: buildDeliveryPickupUpdateComponents,
  },
  'Pickup By Customer': {
    template: DISPATCH_TEMPLATES.DELIVERY_PICKUP,
    build: buildDeliveryPickupUpdateComponents,
  },
};

const resolveTransportCourierName = async dispatch => {
  const transportId = dispatch?.transportCourier?.transportId;
  if (!transportId) return '-';
  if (typeof transportId === 'object' && transportId.name) return transportId.name;

  const { TransportCourier } = getBooksModels();
  const transportCourier = await TransportCourier.findById(transportId).select('name').lean();
  return transportCourier?.name || '-';
};

const resolveDispatchTemplateAndComponents = ({ dispatch, invoice, customer, transportCourierName, templateData }) => {
  const match = TEMPLATE_BY_MODE[dispatch?.dispatchMode];
  const resolvedTemplateData =
    templateData || buildInvoiceDispatchTemplateData({ dispatch, invoice, customer, transportCourierName });
  if (!match || !resolvedTemplateData) return null;

  return {
    template: match.template,
    components: match.build(resolvedTemplateData),
  };
};

const processInvoiceDispatchWhatsApp = async ({ companyId, dispatch, invoiceId }) => {
  if (!companyId || (!dispatch && !invoiceId)) {
    logger.warn('processInvoiceDispatchWhatsApp: missing companyId or dispatch data');
    return false;
  }

  if (!isWhatsAppConfigured()) {
    logger.debug('processInvoiceDispatchWhatsApp: WhatsApp is not configured');
    return false;
  }

  const isEnabled = await isModuleWhatsAppEnabled(companyId, MODULE_NAMES.DISPATCH);
  if (!isEnabled) {
    logger.debug(`processInvoiceDispatchWhatsApp: WhatsApp disabled for dispatch for company ${companyId}`);
    return false;
  }

  const { Invoice, InvoiceDispatch } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  let dispatchDoc = dispatch;
  if (!dispatchDoc || !dispatchDoc.dispatchMode) {
    const query = dispatch?._id ? { _id: dispatch._id } : { invoiceId };
    dispatchDoc = await InvoiceDispatch.findOne({ ...query, companyId }).lean();
  }

  if (!dispatchDoc) {
    logger.warn(`processInvoiceDispatchWhatsApp: dispatch record not found for company ${companyId}`);
    return false;
  }

  const resolvedInvoiceId = invoiceId || dispatchDoc.invoiceId?._id || dispatchDoc.invoiceId;
  const invoice = await Invoice.findOne({ _id: resolvedInvoiceId, companyId }).select('invoiceId invoiceDate customerId').lean();

  if (!invoice) {
    logger.warn(`processInvoiceDispatchWhatsApp: invoice ${resolvedInvoiceId} not found`);
    return false;
  }

  const partyId = invoice.customerId?._id || invoice.customerId;
  if (!partyId) {
    logger.warn(`processInvoiceDispatchWhatsApp: customer not found on invoice ${invoice.invoiceId}`);
    return false;
  }

  const customer = await Customer.findById(partyId)
    .select('customerPhoneNumber customerDisplayName companyName bpPrimaryContactName')
    .lean();

  const phone = customer?.customerPhoneNumber;
  if (!phone) {
    logger.warn(`processInvoiceDispatchWhatsApp: no phone for customer on invoice ${invoice.invoiceId}`);
    return false;
  }

  const transportCourierName = await resolveTransportCourierName(dispatchDoc);

  const templateData = buildInvoiceDispatchTemplateData({
    dispatch: dispatchDoc,
    invoice,
    customer,
    transportCourierName,
  });
  const resolved = templateData
    ? resolveDispatchTemplateAndComponents({
        dispatch: dispatchDoc,
        templateData,
      })
    : null;

  if (!resolved) {
    logger.warn(`processInvoiceDispatchWhatsApp: unsupported dispatch mode "${dispatchDoc.dispatchMode}"`);
    return false;
  }

  const attachmentUrl = getDispatchFileUrl(templateData.attachmentLink);
  const uploadedMedia = attachmentUrl ? await uploadDispatchAttachment(attachmentUrl) : null;

  if (!uploadedMedia) {
    logger.warn(
      `processInvoiceDispatchWhatsApp: dispatch document is required for ${resolved.template.name} on invoice ${invoice.invoiceId}`,
    );
    return false;
  }

  await sendWhatsAppTemplate(phone, {
    name: resolved.template.name,
    languageCode: resolved.template.languageCode,
    components: [buildDocumentHeader(uploadedMedia), ...resolved.components],
  });

  logger.info(
    `processInvoiceDispatchWhatsApp: sent ${resolved.template.name} for invoice ${invoice.invoiceId} to ${phone} with attachment ${uploadedMedia.filename}`,
  );
  return true;
};

const sendInvoiceDispatchWhatsApp = async ({ companyId, dispatch, invoiceId }) => {
  try {
    if (!companyId || (!dispatch && !invoiceId)) {
      logger.warn('sendInvoiceDispatchWhatsApp: missing companyId or dispatch data');
      return false;
    }

    const plainDispatch = typeof dispatch?.toObject === 'function' ? dispatch.toObject() : dispatch;
    const mongoId = plainDispatch?._id?.toString?.() || plainDispatch?._id || invoiceId;
    const jobId = buildNotificationJobId('module-whatsapp', companyId, MODULE_NAMES.DISPATCH, mongoId, 'dispatch');

    await createQueue(MODULE_WHATSAPP_QUEUE).add(
      'send-module-whatsapp',
      {
        companyId: companyId.toString(),
        moduleName: MODULE_NAMES.DISPATCH,
        document: plainDispatch ? JSON.parse(JSON.stringify(plainDispatch)) : null,
        invoiceId: invoiceId ? invoiceId.toString() : plainDispatch?.invoiceId?.toString(),
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      },
    );

    logger.info(`sendInvoiceDispatchWhatsApp: enqueued dispatch ${mongoId} (jobId=${jobId})`);
    return true;
  } catch (error) {
    logger.error('sendInvoiceDispatchWhatsApp enqueue failed, falling back to inline:', error);
    try {
      return await processInvoiceDispatchWhatsApp({ companyId, dispatch, invoiceId });
    } catch (inlineError) {
      logger.error('sendInvoiceDispatchWhatsApp inline fallback failed:', inlineError);
      return false;
    }
  }
};

module.exports = {
  DISPATCH_TEMPLATES,
  buildInvoiceDispatchDetailsComponents,
  buildFullTruckLoadDispatchComponents,
  buildDeliveryPickupUpdateComponents,
  buildInvoiceDispatchTemplateData,
  downloadDispatchAttachment,
  getDispatchFileUrl,
  resolveTransportCourierName,
  resolveDispatchTemplateAndComponents,
  processInvoiceDispatchWhatsApp,
  sendInvoiceDispatchWhatsApp,
};
