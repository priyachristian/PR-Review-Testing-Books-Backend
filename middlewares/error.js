const mongoose = require('mongoose');
const httpStatus = require('http-status');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');
const { errorResponse } = require('../services/response.service');

const errorConverter = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    const statusCode =
      error.statusCode || (error instanceof mongoose.Error ? httpStatus.BAD_REQUEST : httpStatus.INTERNAL_SERVER_ERROR);

    const message = error.message || httpStatus[statusCode];

    error = new ApiError(statusCode, message, 0, {}, false, err.stack);
  }

  next(error);
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const isOperational = err.isOperational !== false;
  const shouldSanitize = config.env === 'production' && !isOperational;

  if (req._errorContext) {
    const { service, controller, failureMessage, failureStatus } = req._errorContext;
    const statusCode = shouldSanitize
      ? httpStatus.INTERNAL_SERVER_ERROR
      : err?.statusCode || failureStatus || httpStatus.INTERNAL_SERVER_ERROR;
    const message = shouldSanitize
      ? 'Something went wrong on our end. Please try again in a moment or contact support if this continues.'
      : err?.message || failureMessage;
    const code = shouldSanitize ? 0 : err?.code || 0;
    const data = shouldSanitize ? {} : err?.data || {};
    return errorResponse({ req, error: err, service, controller }, res, message, statusCode, code, data);
  }

  let { statusCode, message, data, code } = err;
  if (shouldSanitize) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = 'Something went wrong on our end. Please try again in a moment or contact support if this continues.';
    code = 0;
    data = {};
  }

  res.locals.errorMessage = err.message;

  const response = {
    code: code || 0,
    message,
    data: data,
    ...(config.env === 'development' && { stack: err.stack }),
  };

  res.status(statusCode).send(response);
};

module.exports = {
  errorConverter,
  errorHandler,
};
