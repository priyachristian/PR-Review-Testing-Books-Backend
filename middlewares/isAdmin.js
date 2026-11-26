const httpStatus = require('http-status');
const { getBooksModels } = require('../services/model.service');
const ApiError = require('../utils/ApiError');

const ADMIN_ONLY_MESSAGE =
  'You cannot update this configuration. Only admin users can modify system settings. Please contact your administrator for assistance.';

const isAdmin = async (req, res, next) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Company identifier is required.'));
    }

    const { UserRole } = getBooksModels();

    const userRole = await UserRole.findOne({ userId: req.user._id, companyId }).populate('roleId');

    const role = userRole?.roleId;

    if (!role || role.role !== 'Admin' || role.company?.toString() !== companyId.toString()) {
      return next(new ApiError(httpStatus.FORBIDDEN, ADMIN_ONLY_MESSAGE));
    }

    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { isAdmin };
