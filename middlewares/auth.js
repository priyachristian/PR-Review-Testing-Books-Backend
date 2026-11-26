const httpStatus = require('http-status');
const jwt = require('jwt-simple');
const { DateTime } = require('luxon');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');
const { getCommonModels, getBooksModels, getAbssAdminModels } = require('../services/model.service');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { hasCRMSubscription } = require('../services/checkSubscription.service');

const authorize = async (req, res, next) => {
  try {
    const { User, Company, CompanySubscription } = getCommonModels();
    const { UserRole } = getBooksModels();
    const { Plan } = getAbssAdminModels();

    const token = req.cookies.accessToken;

    if (!token) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Token not found'));
    }
    try {
      const { Token } = getCommonModels();
      const tokenResult = jwt.decode(token, config.jwt.secret);
      if (!tokenResult || !tokenResult.exp || !tokenResult._id) {
        await User.findOneAndUpdate({ 'sessions.access_token': token }, { $pull: { sessions: { access_token: token } } });

        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Malformed Token'));
      }

      if (tokenResult.exp - DateTime.local().toSeconds() < 0) {
        await User.findOneAndUpdate({ 'sessions.access_token': token }, { $pull: { sessions: { access_token: token } } });

        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Your session has expired. Please sign in again.'));
      }

      // Check the token hasn't been revoked (e.g. via logout from Account app)
      const tokenDoc = await Token.findOne({ token, user: tokenResult._id, blacklisted: false });
      if (!tokenDoc) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'Your session has expired. Please sign in again.'));
      }

      const user = await User.findById(tokenResult._id).select('-passwordHash').lean();

      if (!user) {
        return next(new ApiError(httpStatus.UNAUTHORIZED, 'User not found'));
      }

      if (user.status === 'blocked') {
        return next(
          new ApiError(
            httpStatus.UNAVAILABLE_FOR_LEGAL_REASONS,
            'Your account has been suspended by admin. Please contact us for more information.',
          ),
        );
      }

      if (user.status === 'deleted') {
        return next(
          new ApiError(httpStatus.UNAVAILABLE_FOR_LEGAL_REASONS, 'You have deleted you account. Please signup again to continue'),
        );
      }

      // Prefer the companyId from the cookie, but fall back to any active role
      // if the cookie is stale (e.g. user switched orgs in another app).
      let userRole = null;
      if (req.cookies?.companyId) {
        userRole = await UserRole.findOne({ userId: user._id, isActive: true, companyId: req.cookies.companyId }).lean();
      }
      if (!userRole) {
        userRole = await UserRole.findOne({ userId: user._id, isActive: true }).lean();
      }
      const company = await Company.findById(userRole?.companyId);
      const plan = await Plan.find({ appName: APP_NAME.BOOKS });
      const planIds = plan?.map(p => p?._id.toString()) || [];
      const companySubscription = await CompanySubscription.findOne({
        planId: { $in: planIds },
        companyId: company?._id,
        appName: 'BOOKS',
      });

      if (!companySubscription?.canLoggedIn) {
        return next(
          new ApiError(
            httpStatus.FORBIDDEN,
            'Payment for your subscription has not been completed. You cannot log in until payment is done.',
          ),
        );
      }

      req.user = { ...user, isAdmin: company?.addedBy?.toString() === user?._id?.toString() };
      req.tokenData = tokenResult._id;

      req.hasCRMAccess = company?._id ? await hasCRMSubscription(company._id) : false;

      // Cross-company access check:
      // If the request includes a companyId (body / query / params),
      // make sure it belongs to the authenticated user's company.
      const requestedCompanyId = req.params?.companyId || req.body?.companyId || req.query?.companyId;

      if (requestedCompanyId && requestedCompanyId.toString() !== userRole?.companyId?.toString()) {
        return next(
          new ApiError(httpStatus.FORBIDDEN, "Access denied: you do not have permission to access this company's data"),
        );
      }

      return next();
    } catch (e) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Your session has expired. Please sign in again.'));
    }
  } catch (e) {
    return next(
      new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't verify your permissions right now. Please try again."),
    );
  }
};

module.exports.authorize = authorize;
