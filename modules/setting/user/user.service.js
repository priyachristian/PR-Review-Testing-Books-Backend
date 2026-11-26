const httpStatus = require('http-status');
const { getCommonModels, getBooksModels, getClientConnection } = require('../../../services/model.service');
const { tokenTypes } = require('../../../config/tokens');
const ApiError = require('../../../utils/ApiError');
const { USER_MESSAGES } = require('../../../utils/messages');
const mongoose = require('mongoose');

/**
 * Create a user
 * @param {Object} userBody - User data
 * @returns {Promise<User>}
 */
const createUser = async userBody => {
  const { User } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    if (await User.isEmailTaken(userBody.email)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'This email address is already in use.');
    }

    const [user] = await User.create([userBody], { session });
    await session.commitTransaction();
    return user;
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
 * Query for users
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryUsers = async (filter, options) => {
  const { UserRole, Role } = getBooksModels();
  const { User } = getCommonModels();

  // Get paginated user roles without populate
  const userRoles = await UserRole.paginate(filter, options);

  // Manually populate user and role data
  const populatedResults = await Promise.all(
    userRoles.results.map(async userRole => {
      const user = await User.findById(userRole.userId).select('-passwordHash -access_token -refresh_token');
      const role = await Role.findById(userRole.roleId);

      return {
        ...userRole.toObject(),
        user: user ? user.toObject() : null,
        userId: user ? user.toObject() : null,
        role: role ? role.toObject() : null,
      };
    }),
  );

  return {
    ...userRoles,
    results: populatedResults,
  };
};

/**
 * Get user by id
 * @param {ObjectId} id - User ID
 * @returns {Promise<User>}
 */
const getUserById = async id => {
  const { User } = getCommonModels();
  const { UserRole, Role } = getBooksModels();

  const userrole = await UserRole.findOne({ userId: id });
  if (!userrole) {
    throw new ApiError(httpStatus.NOT_FOUND, USER_MESSAGES.NOT_FOUND);
  }

  const user = await User.findById(userrole.userId);
  const role = await Role.findById(userrole.roleId);

  return {
    ...userrole.toObject(),
    user: user ? user.toObject() : null,
    role: role ? role.toObject() : null,
  };
};

/**
 * Get user by email
 * @param {string} email - User email
 * @returns {Promise<User>}
 */
const getUserByEmail = async email => {
  const { User } = getCommonModels();
  const user = await User.findOne({ email });
  return user;
};

const getUserProfile = async (userId, companyId) => {
  const { User } = getCommonModels();
  const { UserRole, Role } = getBooksModels();

  const userRole = await UserRole.findOne({ userId, companyId }).select('roleId status').lean();
  if (!userRole) {
    throw new ApiError(httpStatus.NOT_FOUND, USER_MESSAGES.NOT_FOUND);
  }

  const [user, role] = await Promise.all([
    User.findById(userId).select('firstName lastName email phone').lean(),
    userRole.roleId ? Role.findById(userRole.roleId).select('role').lean() : null,
  ]);

  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, USER_MESSAGES.NOT_FOUND);
  }

  const firstName = user.firstName || '';
  const lastName = user.lastName || '';
  const name = `${firstName} ${lastName}`.trim() || user.email || '';

  return {
    id: userId.toString(),
    firstName,
    lastName,
    name,
    email: user.email || '',
    phone: user.phone || '',
    role: role?.role || '',
    roleId: userRole.roleId?.toString() || undefined,
    status: userRole.status,
  };
};

/**
 * Get user role and permissions
 * @param {ObjectId} userId - User ID
 * @param {ObjectId} companyId - Company ID
 * @returns {Promise<Object>} User role with transformed permissions
 */
const getUserRole = async (userId, companyId) => {
  const { UserRole } = getBooksModels();
  const userRole = await UserRole.findOne({ userId, companyId }).populate({
    path: 'roleId',
    model: 'Role',
    populate: {
      path: 'permissions.module',
      model: 'Module',
    },
  });

  if (!userRole) {
    throw new ApiError(httpStatus.NOT_FOUND, USER_MESSAGES.NOT_FOUND);
  }

  const transformedPermissions = userRole.roleId.permissions.reduce((acc, permission) => {
    acc[permission.module?.key] = {
      view: permission.view,
      create: permission.create,
      edit: permission.edit,
      delete: permission.delete,
    };
    return acc;
  }, {});

  return {
    ...userRole.toObject(),
    roleId: {
      ...userRole.roleId.toObject(),
      permissions: transformedPermissions,
    },
  };
};

/**
 * Update user by id
 * @param {ObjectId} userId - User ID
 * @param {ObjectId} userId
 * @param {Object} updateBody
 * @returns {Promise<User>}
 */
const updateUserById = async (userId, updateBody) => {
  const { User } = getCommonModels();
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (updateBody.email && (await User.isEmailTaken(updateBody.email, userId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This email address is already in use.');
  }
  Object.assign(user, updateBody);
  await user.save();
  return user;
};

/**
 * Delete user by id
 * @param {ObjectId} userId
 * @returns {Promise<User>}
 */
const deleteUserById = async userId => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  await user.remove();
  return user;
};

const changeUserStatus = async (userId, companyId, status) => {
  const { UserRole } = getBooksModels();
  const userRole = await UserRole.findOne({ userId: userId, companyId: companyId });
  if (!userRole) {
    throw new ApiError(httpStatus.NOT_FOUND, USER_MESSAGES.NOT_FOUND);
  }
  userRole.status = status;
  await userRole.save();
  return userRole;
};

const getUserDetailById = async id => {
  const { User } = getCommonModels();
  const user = await User.findById(id);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  return user;
};

const defaultconfiguration = async (defaultBody, userId, companyId) => {
  const { User, UserCompanySetting } = getCommonModels();
  const { branchId, warehouseId, divisionId } = defaultBody;

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const settings = await UserCompanySetting.findOneAndUpdate(
    { userId, companyId },
    {
      $set: {
        defaultConfiguration: {
          branchId,
          divisionId,
          warehouseId,
        },
      },
      $setOnInsert: {
        userId,
        companyId,
      },
    },
    { upsert: true, new: true },
  );

  return settings;
};

/**
 * Dropdown list for a company: minimal, safe fields only (no passwords/tokens/full role ACLs).
 * One row per distinct user (deduped), sorted by display name.
 */
const queryUsersDropdown = async filter => {
  const { UserRole, Role } = getBooksModels();
  const { User } = getCommonModels();

  const query = {
    ...filter,
    status: 'active',
    $or: [{ isActive: true }, { isActive: { $exists: false } }],
  };

  const userRoles = await UserRole.find(query).select('userId roleId').lean();
  if (!userRoles.length) {
    return [];
  }

  const userIds = [...new Set(userRoles.map(ur => ur.userId).filter(Boolean))];
  const roleIds = [...new Set(userRoles.map(ur => ur.roleId).filter(Boolean))];

  const [users, roles] = await Promise.all([
    User.find({ _id: { $in: userIds } })
      .select('firstName lastName email')
      .lean(),
    Role.find({ _id: { $in: roleIds } })
      .select('role')
      .lean(),
  ]);

  const userById = new Map(users.map(u => [u._id.toString(), u]));
  const roleById = new Map(roles.map(r => [r._id.toString(), r]));

  const rows = [];
  const seenUser = new Set();
  for (const ur of userRoles) {
    const uid = ur.userId?.toString();
    if (!uid || seenUser.has(uid)) continue;
    seenUser.add(uid);

    const u = userById.get(uid);
    if (!u) continue;

    const rid = ur.roleId?.toString();
    const r = rid ? roleById.get(rid) : null;

    const firstName = u.firstName || '';
    const lastName = u.lastName || '';
    const name = `${firstName} ${lastName}`.trim() || u.email || 'User';

    rows.push({
      id: uid,
      _id: uid,
      firstName,
      lastName,
      email: u.email,
      name,
      roleId: rid || undefined,
      roleName: r?.role,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return rows;
};

const updateUserStatusAndRole = async (userId, companyId, updateBody) => {
  const { User } = getCommonModels();
  const { UserRole } = getBooksModels();
  const { status, roleId, firstName, lastName } = updateBody;

  const [user, userRole] = await Promise.all([User.findById(userId), UserRole.findOne({ userId, companyId })]);

  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (!userRole) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User role not found');
  }
  if (firstName !== undefined) user.firstName = firstName;
  if (lastName !== undefined) user.lastName = lastName;
  if (roleId !== undefined) userRole.roleId = roleId;
  if (status !== undefined) {
    userRole.status = status;
    userRole.isActive = status === 'active';
  }

  const promises = [];

  if (firstName !== undefined || lastName !== undefined) {
    promises.push(user.save());
  }
  if (roleId !== undefined || status !== undefined) {
    promises.push(userRole.save());
  }
  await Promise.all(promises);

  return { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email };
};

const deleteCompanyUser = async (userId, companyId) => {
  const { UserRole, Role } = getBooksModels();
  const { Token } = getCommonModels();

  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const userRole = await UserRole.findOne({ userId, companyId }).populate('roleId');
  if (!userRole) {
    throw new ApiError(httpStatus.NOT_FOUND, USER_MESSAGES.NOT_FOUND);
  }

  if (userRole.isOwner) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This user is the company owner and cannot be removed.');
  }

  const isTargetAdmin = userRole.roleId && /^admin$/i.test(userRole.roleId.role || '');
  if (isTargetAdmin && userRole.isActive) {
    const adminRoleIds = await Role.find({ company: companyObjectId, role: { $regex: '^admin$', $options: 'i' } }).distinct(
      '_id',
    );
    const activeAdminCount = await UserRole.countDocuments({
      companyId: companyObjectId,
      isActive: true,
      roleId: { $in: adminRoleIds },
    });
    if (activeAdminCount <= 1) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot remove the last active admin of the company.');
    }
  }

  await UserRole.deleteOne({ _id: userRole._id });

  await Token.deleteMany({
    type: tokenTypes.INVITE,
    user: userId,
    appName: 'BOOKS',
  });
};

module.exports = {
  createUser,
  queryUsers,
  getUserById,
  getUserByEmail,
  updateUserById,
  deleteUserById,
  changeUserStatus,
  getUserRole,
  getUserProfile,
  getUserDetailById,
  defaultconfiguration,
  queryUsersDropdown,
  updateUserStatusAndRole,
  deleteCompanyUser,
};
