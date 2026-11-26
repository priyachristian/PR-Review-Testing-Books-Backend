class ApiError extends Error {
  constructor(statusCode, message, code = 0, data = {}, isOperational = true, stack = '') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.data = data;
    this.isOperational = isOperational;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

module.exports = ApiError;
