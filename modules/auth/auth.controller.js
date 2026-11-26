const httpStatus = require('http-status');
const catchAsync = require('../../utils/catchAsync');
const authService = require('./auth.service');
const { successResponse } = require('../../services/response.service');
const { AUTH_MESSAGES } = require('../../utils/messages');
const config = require('../../config/config');

const logout = catchAsync(
  async (req, res) => {
    try {
      await authService.logout(req.cookies?.refreshToken, req.cookies?.accessToken, req.cookies?.browserSessionId, {
        userId: req.user?._id,
        deviceId: req.body?.deviceId,
      });
    } catch (error) {}
    if (config.env === 'development') {
      res.clearCookie('accessToken', {
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        domain: config.domain,
      });

      res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        domain: config.domain,
      });
    } else {
      res.clearCookie('accessToken', {
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        domain: config.domain,
      });

      res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        domain: config.domain,
      });
    }
    return successResponse(res, {}, AUTH_MESSAGES.LOGOUT_SUCCESS, httpStatus.NO_CONTENT);
  },
  {
    service: 'logout',
    controller: 'auth',
    failureMessage: AUTH_MESSAGES.LOGOUT_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const refreshTokens = catchAsync(
  async (req, res) => {
    const tokens = await authService.refreshAuth(req.body.refreshToken);
    return successResponse(res, { ...tokens }, AUTH_MESSAGES.TOKEN_REFRESH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'refreshAuth',
    controller: 'auth',
    failureMessage: AUTH_MESSAGES.TOKEN_REFRESH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const validateToken = catchAsync(
  async (req, res) => {
    const {
      company,
      subscription,
      payments,
      isMaintenanceModeActive = false,
      maintenanceModeMessage = '',
      isViewOnly,
      activateAt,
    } = await authService.validateTokenService(req.user, req.cookies?.companyId);
    successResponse(
      res,
      {
        user: req.user,
        company,
        subscription,
        payments,
        isMaintenanceModeActive,
        maintenanceModeMessage,
        isViewOnly,
        activateAt,
      },
      AUTH_MESSAGES.TOKEN_VALID,
      httpStatus.OK,
    );
  },
  {
    service: 'validateTokenService',
    controller: 'auth',
    failureMessage: AUTH_MESSAGES.TOKEN_VALIDATION_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  logout,
  refreshTokens,
  validateToken,
};
