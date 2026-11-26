const axios = require('axios');
const config = require('../config/config');
const logger = require('../config/logger');

const normalizePhone = phone => {
  if (!phone) return null;
  const raw = String(phone).trim();
  // A leading '+' means the caller already supplied a country code — never re-prefix it.
  const hasCountryCode = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (hasCountryCode) return digits;
  // Otherwise a bare 10-digit number is assumed Indian (this is an India-first product).
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const isWhatsAppConfigured = () => !!(config.whatsapp?.phoneNumberId && config.whatsapp?.accessToken);

const postWhatsAppPayload = async (to, payload) => {
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    logger.info(`[WhatsApp] Message sent to ${to}${payload?.template?.name ? ` template=${payload.template.name}` : ''}`);
    return response.data;
  } catch (err) {
    const apiError = err.response?.data?.error;
    const detail = apiError?.message || err.message;
    const code = apiError?.code;
    logger.error(`[WhatsApp] Failed to send message to ${to}: ${detail}${code ? ` (code=${code})` : ''}`);
    if (apiError) {
      logger.error(`[WhatsApp] Error details: ${JSON.stringify(apiError)}`);
    }

    const wrapped = new Error(detail);
    wrapped.code = code || err.code || 'WHATSAPP_SEND_FAILED';
    wrapped.details = apiError || null;
    throw wrapped;
  }
};

const sendWhatsAppMessage = async (phone, message) => {
  if (!isWhatsAppConfigured()) {
    const err = new Error('WhatsApp is not configured (missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN)');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  if (!message || !String(message).trim()) {
    const err = new Error('WhatsApp message body is empty');
    err.code = 'WHATSAPP_MESSAGE_EMPTY';
    throw err;
  }

  const to = normalizePhone(phone);
  if (!to) {
    const err = new Error('Invalid WhatsApp phone number');
    err.code = 'WHATSAPP_INVALID_PHONE';
    throw err;
  }

  return postWhatsAppPayload(to, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      preview_url: false,
      body: String(message).trim(),
    },
  });
};

// Uploads a document to WhatsApp's Media endpoint and returns its media id, for use in a
// template's header `document` parameter (Meta requires an `id` or a public `link`, not raw bytes).
const uploadWhatsAppMedia = async ({ buffer, filename, mimeType = 'application/pdf' }) => {
  if (!isWhatsAppConfigured()) {
    const err = new Error('WhatsApp is not configured (missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN)');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/media`;

  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', new Blob([buffer], { type: mimeType }), filename);

  try {
    const response = await axios.post(url, formData, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    });

    return response.data.id;
  } catch (err) {
    const apiError = err.response?.data?.error;
    const detail = apiError?.message || err.message;
    logger.error(`[WhatsApp] Media upload failed: ${detail}`);

    const wrapped = new Error(detail);
    wrapped.code = apiError?.code || err.code || 'WHATSAPP_MEDIA_UPLOAD_FAILED';
    wrapped.details = apiError || null;
    throw wrapped;
  }
};

const sendWhatsAppTemplate = async (phone, template = {}) => {
  if (!isWhatsAppConfigured()) {
    const err = new Error('WhatsApp is not configured (missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN)');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  const to = normalizePhone(phone);
  if (!to) {
    const err = new Error('Invalid WhatsApp phone number');
    err.code = 'WHATSAPP_INVALID_PHONE';
    throw err;
  }

  const name = template.name;
  const languageCode = template.languageCode;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: {
        code: languageCode,
      },
    },
  };

  if (template.components?.length) {
    payload.template.components = template.components;
  }

  return postWhatsAppPayload(to, payload);
};

module.exports = {
  sendWhatsAppTemplate,
  uploadWhatsAppMedia,
  isWhatsAppConfigured,
};
