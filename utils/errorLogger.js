const config = require('../config/config');
const { getBooksModels } = require('../services/model.service');
const { buildTeamsAlert, sendTeamsAlert } = require('./teamsNotifier');

const logError = async ({ req, error, service, controller }) => {
  try {
    const { ErrorLog } = getBooksModels();
    const eventType = 'API_ERROR';
    const eventDescription = `${service} :: ${controller}`;
    if (config.env == 'development') return;

    const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip;

    const errorDetails = {
      errorMessage: error.message,
      stackTrace: error.stack,
      requestUrl: req.originalUrl,
      requestMethod: req.method,
      encryptedBody: req.body,
      requestHeaders: req.headers,
      requestParams: req.params,
      requestQuery: req.query,
    };

    const errorLogDoc = await ErrorLog.create({
      userId: req?.tokenData,
      service,
      controller,
      eventType,
      eventDescription,
      ipAddress,
      errorMessage: errorDetails.errorMessage,
      stackTrace: errorDetails.stackTrace,
      requestUrl: errorDetails.requestUrl,
      requestMethod: errorDetails.requestMethod,
      requestBody: errorDetails.encryptedBody,
      requestHeaders: {
        'user-agent': errorDetails.requestHeaders['user-agent'],
        referer: errorDetails.requestHeaders.referer,
        'x-forwarded-for': errorDetails.requestHeaders['x-forwarded-for'],
        'content-type': errorDetails.requestHeaders['content-type'],
        'content-length': errorDetails.requestHeaders['content-length'],
      },
      requestParams: errorDetails.requestParams,
      requestQuery: errorDetails.requestQuery,
    });

    await sendTeamsAlert(
      buildTeamsAlert({
        title: '🚨 API ERROR ALERT',
        errorLogId: errorLogDoc?._id?.toString() || 'DB_LOG_FAILED',
        service,
        controller,
        method: req.method,
        url: req.originalUrl,
        message: error?.message,
        status: error?.status || 500,
      }),
    );
  } catch (err) {
    console.error('Error logging failed:', err);
  }
};

module.exports = { logError };
