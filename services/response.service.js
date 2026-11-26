const { logError } = require('../utils/errorLogger');
const newrelic = require('newrelic');
const logger = require('../config/logger');

module.exports = {
  successResponse(res, data, message, HttpStatusCode, extras = {}) {
    if (!res.headersSent) {
      const response = {
        data,
        code: 1,
        message,
        extras: {},
      };
      extras.hasCRMAccess = res.req?.hasCRMAccess || false;
      if (extras) {
        Object.keys(extras).forEach(key => {
          if ({}.hasOwnProperty.call(extras, key)) {
            response.extras[key] = extras[key];
          }
        });
      }
      return res.status(HttpStatusCode).send(response);
    }
  },

  errorResponse(errorLogDetails = {}, res, message, HttpStatusCode, code = 0, data = {}) {
    if (!res.headersSent) {
      const response = {
        code: code,
        data,
        message,
      };

      const { req, error, service, controller } = errorLogDetails;
      const isServerError = HttpStatusCode >= 500;

      const meta = {
        message: error?.message || message,
        statusCode: HttpStatusCode,
        url: req?.originalUrl,
        method: req?.method,
        ip: req?.ip,
        userId: req?.user?._id,
        service,
        controller,
        stack: error?.stack,
      };

      if (isServerError) {
        logger.error('API Error', meta);
      } else {
        logger.warn('API Client Error', meta);
      }

      if (error && isServerError) {
        try {
          newrelic.noticeError(error, meta);

          newrelic.recordCustomEvent('API_ERROR', {
            service: service || 'unknown',
            controller: controller || 'unknown',
            statusCode: HttpStatusCode,
            path: req?.originalUrl,
          });
        } catch (err) {
          console.error('New Relic reporting failed:', err);
        }
      }

      // Persist 500 errors to DB + send Teams alert (skipped in development)
      if (isServerError) {
        if (errorLogDetails?.req && errorLogDetails?.error) {
          logError(errorLogDetails).catch(err => {
            console.error('Error logging failed:', err);
          });
        }
      }

      return res.status(HttpStatusCode).send(response);
    }
  },

  validationErrorResponse(res, message) {
    if (!res.headersSent) {
      const response = {
        data: {},
        message,
      };
      return res.status(400).send(response);
    }
  },
};
