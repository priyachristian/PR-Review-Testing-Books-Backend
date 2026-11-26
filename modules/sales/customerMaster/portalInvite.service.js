const crypto = require('crypto');
const moment = require('moment');
const httpStatus = require('http-status');
const { getBooksModels, getCommonModels, getClientConnection } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { sendPortalInviteEmail } = require('../../../services/email.service');
const config = require('../../../config/config');

const PORTAL_INVITE_TOKEN_TYPE = {
  SET_PASSWORD: 'SET_PASSWORD',
  ACCEPT_ACCESS: 'ACCEPT_ACCESS',
};

const generatePortalInviteToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const createOrGetPortalUser = async (customerId, companyId, email, session = null) => {
  const { CustomerPortalUser } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const dbSession = session || (await connection.startSession());

  try {
    if (!session) {
      await dbSession.startTransaction();
    }

    // Normalize email to lowercase
    const normalizedEmail = email.toLowerCase().trim();

    // Check if portal user already exists by email (email is unique)
    let portalUser = await CustomerPortalUser.findOne({
      email: normalizedEmail,
    }).session(dbSession);

    if (!portalUser) {
      // Create new portal user with link
      portalUser = await CustomerPortalUser.create(
        [
          {
            email: normalizedEmail,
            links: [
              {
                companyId,
                customerId,
                isActive: false,
                isAppEnabled: true,
              },
            ],
          },
        ],
        { session: dbSession },
      );
      portalUser = portalUser[0];
    } else {
      // User exists, check if link for this company/customer combination exists
      const linkExists = portalUser.links.some(
        link => link.companyId.toString() === companyId.toString() && link.customerId.toString() === customerId.toString(),
      );

      if (!linkExists) {
        // Add new link to existing user
        portalUser.links.push({
          companyId,
          customerId,
          isActive: false,
          isAppEnabled: true,
        });
        await portalUser.save({ session: dbSession });
      }
    }

    if (!session) {
      await dbSession.commitTransaction();
    }

    return portalUser;
  } catch (error) {
    if (!session && dbSession.inTransaction()) {
      await dbSession.abortTransaction();
    }
    throw error;
  } finally {
    if (!session) {
      await dbSession.endSession();
    }
  }
};

const createPortalInviteToken = async (
  portalUserId,
  companyId,
  customerId,
  type = PORTAL_INVITE_TOKEN_TYPE.SET_PASSWORD,
  expirationDays = 7,
  session = null,
) => {
  const { PortalInviteToken } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const dbSession = session || (await connection.startSession());

  try {
    if (!session) {
      await dbSession.startTransaction();
    }

    // Delete any existing unused tokens of the same type for this portal user
    await PortalInviteToken.deleteMany({
      portalUserId,
      type,
      usedAt: null,
    }).session(dbSession);

    // Generate new token
    const token = generatePortalInviteToken();
    const expiresAt = moment().add(expirationDays, 'days').toDate();

    // Create token document
    const tokenDoc = await PortalInviteToken.create(
      [
        {
          portalUserId,
          companyId,
          customerId,
          token,
          type,
          expiresAt,
        },
      ],
      { session: dbSession },
    );

    if (!session) {
      await dbSession.commitTransaction();
    }

    return tokenDoc[0];
  } catch (error) {
    if (!session && dbSession.inTransaction()) {
      await dbSession.abortTransaction();
    }
    throw error;
  } finally {
    if (!session) {
      await dbSession.endSession();
    }
  }
};

const sendPortalInvite = async (customerId, companyId, email, customerName, session = null) => {
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const dbSession = session || (await connection.startSession());

  try {
    if (!session) {
      await dbSession.startTransaction();
    }

    // Create or get portal user
    const portalUser = await createOrGetPortalUser(customerId, companyId, email, dbSession);

    // Create invite token
    const tokenDoc = await createPortalInviteToken(
      portalUser._id,
      companyId,
      customerId,
      PORTAL_INVITE_TOKEN_TYPE.SET_PASSWORD,
      7, // 7 days expiration
      dbSession,
    );

    if (!session) {
      await dbSession.commitTransaction();
    }

    // Resolve inviting company name for the email (outside transaction)
    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).select('name').lean();

    // Send email (outside transaction to avoid long-running transaction)
    const inviteLink = `${config.frontendUrl || 'http://localhost:3000'}/portal-invite?token=${tokenDoc.token}`;
    await sendPortalInviteEmail({ email, customerName, companyName: company?.name || '', inviteLink, expiryDays: 7 });

    return tokenDoc;
  } catch (error) {
    if (!session && dbSession.inTransaction()) {
      await dbSession.abortTransaction();
    }
    throw error;
  } finally {
    if (!session) {
      await dbSession.endSession();
    }
  }
};

const enablePortalAccess = async (customerId, companyId, email) => {
  const { CustomerPortalUser } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  if (!email) {
    // No email means no portal user to enable
    return false;
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    // Normalize email to lowercase
    const normalizedEmail = email.toLowerCase().trim();

    // Find portal user by email
    const portalUser = await CustomerPortalUser.findOne({
      email: normalizedEmail,
    }).session(session);

    if (!portalUser) {
      // No portal user found, no link exists
      await session.commitTransaction();
      return false;
    }

    // Find the link for this company/customer combination
    const linkIndex = portalUser.links.findIndex(
      link => link.companyId.toString() === companyId.toString() && link.customerId.toString() === customerId.toString(),
    );

    if (linkIndex !== -1) {
      // Link exists, enable app access
      portalUser.links[linkIndex].isAppEnabled = true;
      await portalUser.save({ session });
      await session.commitTransaction();
      return true;
    }

    // No link exists for this customer/company combination
    await session.commitTransaction();
    return false;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const disablePortalAccess = async (customerId, companyId, email) => {
  const { CustomerPortalUser } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  if (!email) {
    // No email means no portal user to disable
    return;
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    // Normalize email to lowercase
    const normalizedEmail = email.toLowerCase().trim();

    // Find portal user by email
    const portalUser = await CustomerPortalUser.findOne({
      email: normalizedEmail,
    }).session(session);

    if (!portalUser) {
      // No portal user found, nothing to disable
      await session.commitTransaction();
      return;
    }

    // Find the link for this company/customer combination
    const linkIndex = portalUser.links.findIndex(
      link => link.companyId.toString() === companyId.toString() && link.customerId.toString() === customerId.toString(),
    );

    if (linkIndex !== -1) {
      // Update link to disable app access
      portalUser.links[linkIndex].isAppEnabled = false;
      await portalUser.save({ session });
    }

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  sendPortalInvite,
  createOrGetPortalUser,
  createPortalInviteToken,
  generatePortalInviteToken,
  enablePortalAccess,
  disablePortalAccess,
  PORTAL_INVITE_TOKEN_TYPE,
};
