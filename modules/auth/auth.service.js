const httpStatus = require('http-status');
const tokenService = require('../../services/token.service');
const ApiError = require('../../utils/ApiError');
const { tokenTypes } = require('../../config/tokens');
const { getBooksModels, getCommonModels, getAbssAdminModels } = require('../../services/model.service');
const { APP_NAME, PLATFORMS, SUBSCRIPTION_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const logger = require('../../config/logger');
const { buildEnvelope, publishRealtimeEvent } = require('../../services/realtimeEvent.publisher');

/**
 * Logout
 * @param {string} refreshToken
 * @param {string} [accessToken]
 * @param {string} [browserSessionId] - from the browserSessionId cookie; scopes the resulting
 *   AUTH_LOGOUT delivery to tabs/apps in this same browser context only
 * @param {Object} [device] - { userId, deviceId } of the logging-out browser; its push token is cleared
 * @returns {Promise}
 */
const logout = async (refreshToken, accessToken, browserSessionId, { userId, deviceId } = {}) => {
  // Runs before the refresh-token check so a missing refresh token can't skip it; failure must not stop token revocation.
  if (userId && deviceId) {
    try {
      const { Device } = getCommonModels();
      await Device.updateMany({ userId, deviceId }, { $set: { isActive: false, pushToken: null } });
    } catch (deviceError) {
      logger.error('[AUTH_LOGOUT] Failed to deactivate device:', deviceError.message);
    }
  }

  const { Token } = getCommonModels();
  const refreshTokenDoc = await Token.findOne({
    token: refreshToken,
    type: tokenTypes.REFRESH,
    blacklisted: false,
  });
  if (!refreshTokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, "We couldn't find your account. Please contact your administrator.");
  }
  await Token.deleteOne({ _id: refreshTokenDoc._id });

  if (accessToken) {
    await Token.deleteOne({ token: accessToken, user: refreshTokenDoc.user, type: tokenTypes.ACCESS });
  }

  try {
    const envelope = buildEnvelope({
      type: 'USER_LOGGED_OUT',
      version: 1,
      source: 'abss-books-backend',
      data: { userId: refreshTokenDoc.user.toString(), browserSessionId: browserSessionId || null },
    });
    await publishRealtimeEvent(envelope);
  } catch (notifyError) {
    logger.error('[AUTH_LOGOUT] Failed to publish USER_LOGGED_OUT event:', notifyError.message);
  }
};

/**
 * Refresh auth tokens
 * @param {string} refreshToken
 * @returns {Promise<Object>}
 */
const refreshAuth = async refreshToken => {
  try {
    const { Token } = getCommonModels();
    const { User } = getCommonModels();

    const refreshTokenDoc = await tokenService.verifyToken(refreshToken, tokenTypes.REFRESH);
    const user = await User.findById(refreshTokenDoc.user._id);

    if (!user) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }
    await Token.deleteOne({ _id: refreshTokenDoc._id });

    return tokenService.generateAuthTokens(user);
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Your session has expired. Please sign in again.');
  }
};

const validateTokenService = async (user, preferredCompanyId = null) => {
  const { UserRole } = getBooksModels();
  const { Company, CompanySubscription, CompanyPayment } = getCommonModels();
  const { Plan, MaintenanceMode } = getAbssAdminModels();

  const maintenance = await MaintenanceMode.findOne({
    app: APP_NAME.BOOKS,
    platform: PLATFORMS.WEB,
    isActive: true,
  });

  const userRoleQuery = { userId: user._id, isActive: true };
  if (preferredCompanyId) {
    userRoleQuery.companyId = preferredCompanyId;
  }
  const userRole = await UserRole.findOne(userRoleQuery);

  if (!userRole) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No active company found for this user');
  }

  const company = await Company.findById(userRole.companyId).select('-updatedBy').populate('baseCurrency');
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const plans = await Plan.find({ appName: APP_NAME.BOOKS });
  const planIds = plans.map(sub => sub._id);

  let subscription = await CompanySubscription.findOne({
    companyId: userRole?.companyId,
    planId: { $in: planIds },
    appName: 'BOOKS',
  });

  const plan = plans.find(plan => plan._id.toString() === subscription?.planId.toString());

  let payments = {};
  if (subscription?.paymentDate) {
    const paymentDate = new Date(subscription.paymentDate);

    const year = paymentDate.getUTCFullYear();
    const month = paymentDate.getUTCMonth();

    const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const endOfMonth = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

    payments = await CompanyPayment.findOne({
      companyId: userRole?.companyId,
      paymentDate: {
        $gte: startOfMonth,
        $lte: endOfMonth,
      },
    });
  }

  return {
    company,
    subscription: subscription ? { ...subscription?.toObject(), isCustomPlan: plan?.isCustomPlan } : {},
    payments: payments || {},
    isViewOnly:
      plan?.isViewOnly ||
      (subscription?.status !== SUBSCRIPTION_STATUS.ACTIVE && subscription?.status !== SUBSCRIPTION_STATUS.DUE),
    ...(maintenance?.isActive
      ? {
          isMaintenanceModeActive: true,
          maintenanceModeMessage: maintenance?.message,
          activateAt: maintenance.activateAt,
        }
      : {}),
  };
};

module.exports = {
  logout,
  refreshAuth,
  validateTokenService,
};
