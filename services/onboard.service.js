const tokenService = require('./token.service');
const { getCommonModels, getBooksModels, getClientConnection } = require('./model.service');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');
const { tokenTypes } = require('../config/tokens');
const { sendBookInviteEmail } = require('./email.service');
const config = require('../config/config');
/**
 * Invite a user to join an organization
 * @param {string} name
 * @param {string} email
 * @param {string} companyId
 * @param {string} roleId
 * @param {string} invitedBy
 * @returns {Promise}
 */
const inviteUser = async (email, companyId, roleId, type, invitedByUserId) => {
  email = email.trim().toLowerCase();
  const { UserRole, Role } = getBooksModels();
  const { User, Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const role = await Role.findOne({ _id: roleId, company: companyId }).session(session);
    if (!role) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'The selected role does not belong to this company.');
    }
    const invitedBy = await User.findById(invitedByUserId).session(session);

    let user = null;
    let company = null;
    let fullName = '';
    let inviteToken = null;

    if (type === 'send') {
      user = await User.findOne({ email }).session(session);

      if (!user) {
        user = await User.create([{ email, isVerified: false }], { session });
        user = user[0];
      }

      if (user?.firstName && user?.lastName) {
        fullName = `${user?.firstName} ${user?.lastName}`;
      }

      const existingUserRole = await UserRole.findOne({
        userId: user._id,
        companyId,
      }).session(session);

      if (existingUserRole) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'User is already a part of this company');
      }

      await UserRole.create(
        [
          {
            userId: user._id,
            companyId,
            roleId,
            status: 'pending',
            isActive: false,
          },
        ],
        { session },
      );

      company = await Company.findById(companyId).session(session);
      const { token, expires } = await tokenService.generateInviteToken(user._id, companyId, email);
      inviteToken = token;

      await tokenService.revokeInviteTokens(user._id, companyId, 'BOOKS', session);

      await tokenService.saveToken(token, user._id, expires, tokenTypes.INVITE, false, 'BOOKS', session);
    }

    if (type === 'resend') {
      user = await User.findOne({ email }).session(session);

      if (!user) {
        throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
      }

      if (user?.firstName && user?.lastName) {
        fullName = `${user?.firstName} ${user?.lastName}`;
      }

      const existingUserRole = await UserRole.findOne({
        userId: user._id,
        companyId,
      }).session(session);

      if (!existingUserRole) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'User is not invited to this company');
      }

      company = await Company.findById(companyId).session(session);
      const { token, expires } = await tokenService.generateInviteToken(user._id, companyId, email);
      inviteToken = token;

      await tokenService.revokeInviteTokens(user._id, companyId, 'BOOKS', session);

      await tokenService.saveToken(token, user._id, expires, tokenTypes.INVITE, false, 'BOOKS', session);
    }

    await session.commitTransaction();

    // Send email only after transaction commit
    if (inviteToken && user && company) {
      await sendBookInviteEmail({
        email,
        customerName: fullName || 'Customer',
        companyName: company?.name || '',
        invitedByName:
          invitedBy?.firstName && invitedBy?.lastName
            ? `${invitedBy.firstName} ${invitedBy.lastName}`
            : invitedBy?.firstName || 'Admin',
        verifyEmailLink: `${config.frontendUrl}/invite?token=${inviteToken}`,
      });
    }

    return {
      success: true,
      message: type === 'resend' ? 'Invitation resent successfully' : 'Invitation sent successfully',
    };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getCompanyProfile = async (companyId, session) => {
  const { Company } = getCommonModels();

  const query = Company.findById(companyId).populate('baseCurrency');

  if (session) {
    query.session(session);
  }

  const company = await query;

  return company;
};

module.exports = {
  inviteUser,
  getCompanyProfile,
};
