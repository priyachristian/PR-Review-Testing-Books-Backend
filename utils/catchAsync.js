const catchAsync = (fn, errorContext) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(err => {
    if (errorContext) {
      req._errorContext = errorContext;
    }
    return next(err);
  });
};

module.exports = catchAsync;
