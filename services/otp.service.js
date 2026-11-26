const moment = require('moment');
const config = require('../config/config');
const { getCommonModels, getClientConnection } = require('./model.service');
const { tokenTypes } = require('../config/tokens');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');

/**
 * Save a token
 * @param {string} otp
 * @param {ObjectId} userId
 * @param {Moment} expires
 * @param {string} type
 * @returns {Promise<Token>}
 */
const saveOTP = async (otp, userId, expires, type) => {
  const { Otp } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const tokenDoc = await Otp.create(
      [
        {
          otp,
          user: userId,
          expires: expires.toDate(),
          type,
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
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Generate verify email otp
 * @param {User} user
 * @returns {Promise<string>}
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const generateVerifyEmailToken = async user => {
  const expires = moment().add(config.jwt.verifyEmailExpirationMinutes, 'minutes');
  const verifyEmailToken = generateOTP();
  await saveOTP(verifyEmailToken, user._id, expires, tokenTypes.VERIFY_EMAIL);
  return verifyEmailToken;
};

module.exports = {
  generateVerifyEmailToken,
  saveOTP,
};
