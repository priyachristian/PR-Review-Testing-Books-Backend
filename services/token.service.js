const jwt = require('jwt-simple');
const moment = require('moment');
const httpStatus = require('http-status');
const config = require('../config/config');
const userService = require('../modules/setting/user/user.service');
const { getCommonModels, getClientConnection } = require('./model.service');
const ApiError = require('../utils/ApiError');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { tokenTypes } = require('../config/tokens');

/**
 * Generate token
 * @param {ObjectId} userId - User ID
 * @param {string} email - User email
 * @param {Moment} expires - Expiration time (moment object)
 * @param {string} type - Token type
 * @param {string} [secret] - JWT secret
 * @param {Object} [additionalPayload] - Additional payload data
 * @returns {string} Generated token
 */
const generateToken = (userId, email, expires, type, secret = config.jwt.secret, additionalPayload = {}) => {
  const payload = {
    _id: userId,
    email,
    iat: moment().unix(),
    exp: expires.unix(),
    type,
    ...additionalPayload,
  };
  return jwt.encode(payload, secret);
};

/**
 * Save a token
 * @param {string} token - Token to save
 * @param {ObjectId} userId - User ID
 * @param {Moment} expires - Expiration time
 * @param {string} type - Token type
 * @param {boolean} [blacklisted] - Whether token is blacklisted
 * @returns {Promise<Token>}
 */
const saveToken = async (token, userId, expires, type, blacklisted = false, appName = null, invitationSession = null) => {
  const { Token } = getCommonModels();
  if (invitationSession) {
    const [tokenDoc] = await Token.create([{ token, user: userId, expires, type, blacklisted, appName }], {
      session: invitationSession,
    });
    return tokenDoc;
  }
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const tokenDoc = await Token.create(
      [
        {
          token,
          user: userId,
          expires,
          type,
          blacklisted,
          appName,
        },
      ],
      { session },
    );
    await session.commitTransaction();
    return tokenDoc[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error saving token');
  } finally {
    await session.endSession();
  }
};

/**
 * Verify token and return token doc (or throw an error if it is not valid)
 * @param {string} token - Token to verify
 * @param {string} type - Token type
 * @returns {Promise<Token>}
 */
const verifyToken = async (token, type) => {
  let payload;
  try {
    payload = jwt.decode(token, config.jwt.secret);
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'This link is invalid or has expired. Please request a new one.');
  }
  // if (moment(payload.exp).isBefore(moment())) {
  //   throw new ApiError(httpStatus.UNAUTHORIZED, 'Token has expired');
  // }
  if (moment.unix(payload.exp).isBefore(moment())) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'This link is invalid or has expired. Please request a new one.');
  }

  if (type === tokenTypes.INVITE) {
    return { ...payload };
  }

  const { Token } = getCommonModels();
  const tokenDoc = await Token.findOne({ token, type, user: payload._id, blacklisted: false });
  if (!tokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'This link is invalid or has expired. Please request a new one.');
  }
  return tokenDoc;
};

/**
 * Generate auth tokens
 * @param {User} user
 * @returns {Promise<Object>}
 */
const generateAuthTokens = async user => {
  const accessTokenExpires = moment().add(config.jwt.accessExpirationMinutes, 'minutes');
  const accessToken = generateToken(user._id, user.email, accessTokenExpires, tokenTypes.ACCESS);

  const refreshTokenExpires = moment().add(config.jwt.refreshExpirationDays, 'days');
  const refreshToken = generateToken(user._id, user.email, refreshTokenExpires, tokenTypes.REFRESH);

  await saveToken(refreshToken, user._id, refreshTokenExpires, tokenTypes.REFRESH);

  await userService.updateUserById(user._id, {
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires.toDate(),
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires.toDate(),
    },
  };
};

/**
 * Generate reset password token
 * @param {string} email
 * @returns {Promise<string>}
 */
const generateResetPasswordToken = async email => {
  const user = await userService.getUserByEmail(email);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No users found with this email');
  }
  const expires = moment().add(config.jwt.resetPasswordExpirationMinutes, 'minutes');
  const resetPasswordToken = generateToken(user._id, user.email, expires, tokenTypes.RESET_PASSWORD);
  await saveToken(resetPasswordToken, user._id, expires, tokenTypes.RESET_PASSWORD);
  return resetPasswordToken;
};

/**
 * Generate invite token
 * @param {ObjectId} userId
 * @param {ObjectId} companyId
 * @param {string} email
 * @param {ObjectId} invitedBy
 * @param {number} expirationMinutes
 * @returns {Promise<Object>}
 */
const generateInviteToken = async (userId, companyId, email, expirationMinutes = 4320) => {
  const expires = moment().add(expirationMinutes, 'minutes');
  const inviteToken = generateToken(userId, email, expires, tokenTypes.INVITE, config.jwt.secret, {
    companyId,
    inviteId: require('crypto').randomUUID(),
    appName: APP_NAME.BOOKS,
  });

  return {
    token: inviteToken,
    expires: expires.toDate(),
  };
};

// Reissuing one company's invitation must not revoke invitations to other companies.
const revokeInviteTokens = async (userId, companyId, appName, session) => {
  const { Token } = getCommonModels();
  const invitations = await Token.find({ user: userId, type: tokenTypes.INVITE, appName })
    .select('_id token')
    .session(session)
    .lean();
  const ids = invitations
    .filter(invitation => {
      try {
        // Expired invitations must also be removed when resending.
        const payload = jwt.decode(invitation.token, config.jwt.secret, true);
        return String(payload.companyId) === String(companyId);
      } catch {
        return false;
      }
    })
    .map(invitation => invitation._id);
  if (ids.length) {
    await Token.deleteMany({ _id: { $in: ids } }, { session });
  }
};

module.exports = {
  revokeInviteTokens,
  generateToken,
  saveToken,
  verifyToken,
  generateAuthTokens,
  generateResetPasswordToken,
  generateInviteToken,
};
