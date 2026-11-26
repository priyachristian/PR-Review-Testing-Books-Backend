const { sendWhatsAppTemplate } = require('../utils/whatsapp');

const SALES_DOCUMENT_TEMPLATE = { name: 'sales_document_notification_1', languageCode: 'en' };
const PURCHASE_DOCUMENT_TEMPLATE = { name: 'purchase_document_notification_1', languageCode: 'en' };

const formatTemplateAmount = amount => Math.round(amount || 0).toLocaleString('en-IN');

// Once a template's header is re-approved by Meta as a Document header, pass MediaId (from
// utils/whatsapp.uploadWhatsAppMedia) to attach the actual PDF; falls back to the current
// text header ("{DocType} Details") when no media was uploaded.
const buildDocHeaderComponent = data =>
  data.MediaId
    ? {
        type: 'header',
        parameters: [{ type: 'document', document: { id: data.MediaId, filename: data.MediaFilename || 'document.pdf' } }],
      }
    : {
        type: 'header',
        parameters: [{ type: 'text', text: `${data.DocType} Details` }],
      };

const buildSalesDocSummaryTemplateComponents = data => [
  buildDocHeaderComponent(data),
  {
    type: 'body',
    parameters: [
      { type: 'text', text: data.DocType },
      { type: 'text', text: data.CompanyName },
      { type: 'text', text: data.DocumentNumber },
      { type: 'text', text: data.DocumentDate },
      { type: 'text', text: `${data.CurrencySymbol || '₹'}${formatTemplateAmount(data.Amount)}` },
    ],
  },
];

const sendSalesDocumentTemplate = async (phone, documentData) =>
  sendWhatsAppTemplate(phone, {
    name: SALES_DOCUMENT_TEMPLATE.name,
    languageCode: SALES_DOCUMENT_TEMPLATE.languageCode,
    components: buildSalesDocSummaryTemplateComponents(documentData),
  });

const buildPurchaseDocSummaryTemplateComponents = data => [
  buildDocHeaderComponent(data),
  {
    type: 'body',
    parameters: [
      { type: 'text', text: data.DocType },
      { type: 'text', text: data.CompanyName },
      { type: 'text', text: data.DocumentNumber },
      { type: 'text', text: data.DocumentDate },
      { type: 'text', text: `${data.CurrencySymbol || '₹'}${formatTemplateAmount(data.Amount)}` },
    ],
  },
];

const sendPurchaseDocumentTemplate = async (phone, documentData) =>
  sendWhatsAppTemplate(phone, {
    name: PURCHASE_DOCUMENT_TEMPLATE.name,
    languageCode: PURCHASE_DOCUMENT_TEMPLATE.languageCode,
    components: buildPurchaseDocSummaryTemplateComponents(documentData),
  });

module.exports = {
  SALES_DOCUMENT_TEMPLATE,
  PURCHASE_DOCUMENT_TEMPLATE,
  sendSalesDocumentTemplate,
  sendPurchaseDocumentTemplate,
};
