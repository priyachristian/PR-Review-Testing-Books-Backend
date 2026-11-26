const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { getBooksModels } = require('../services/model.service');

/**
 * Middleware to verify the company has a primary bank configured.
 * Must be applied on POST (create) routes for all financial documents.
 *
 * Usage in router:
 *   router.post('/', checkPrimaryBank, validate(...), controller.create);
 */
const checkPrimaryBank = async (req, res, next) => {
  try {
    const companyId = req.query?.companyId || req.body?.companyId;

    if (!companyId) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required'));
    }

    const { Account } = getBooksModels();
    const primaryBank = await Account.findOne({ companyId, 'bankDetails.isPrimary': true, isActive: true }).select('_id').lean();

    if (!primaryBank) {
      return next(
        new ApiError(
          httpStatus.BAD_REQUEST,
          'No primary bank configured. Please set up your primary bank before creating documents.',
        ),
      );
    }

    return next();
  } catch (error) {
    return next(new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to verify primary bank configuration'));
  }
};

module.exports = { checkPrimaryBank };
