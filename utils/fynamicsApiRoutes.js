const config = require('../config/config');

const FYNAMICS_ROUTES = {
  AUTHENTICATE: '/authenticate',

  EINVOICE_AUTH: '/einvoice/enhanced/authentication',

  EINVOICE_GENERATE_IRN: '/einvoice/enhanced/generate-irn',

  EINVOICE_CANCEL_IRN: '/einvoice/enhanced/cancel-irn',

  EINVOICE_GET_IRN_BY_DOC: '/einvoice/enhanced/get-irn-by-doc',

  EWAYBILL_AUTH: '/eway/enhanced/authentication',

  EWAYBILL_GENERATE_BY_IRN: '/eway/enhanced/generate-by-irn',

  EWAYBILL_GENERATE: '/eway/enhanced/generate',

  EWAYBILL_CANCEL: '/eway/enhanced/cancel',

  GST_SEARCH_TAXPAYER: '/gst/search-taxpayer',
};

const buildFynamicsUrl = (route, overrideBaseUrl) => {
  const baseUrl = overrideBaseUrl || config.fynamics.baseUrl;
  if (!baseUrl) {
    throw new Error('FYNAMICS_BASE_URL is not configured');
  }
  return `${String(baseUrl).replace(/\/+$/, '')}${route}`;
};

module.exports = {
  FYNAMICS_ROUTES,
  buildFynamicsUrl,
};
