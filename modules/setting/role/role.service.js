const httpStatus = require('http-status');
const { getBooksModels, getClientConnection } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { ROLE_MESSAGES } = require('../../../utils/messages');
/**
 * Create a role
 * @param {Object} roleBody
 * @returns {Promise<Role>}
 */
const createRole = async (roleBody, tokenData) => {
  const { Role } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const { role, company } = roleBody;
    const isExist = await Role.findOne({ role: { $regex: new RegExp(`^${role}$`, 'i') }, company }).session(session);
    if (isExist) {
      throw new ApiError(httpStatus.CONFLICT, 'A role with this name already exists in your company');
    }

    const newRole = await Role.create([roleBody], { session });
    await session.commitTransaction();
    return newRole[0];
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
 * Query for roles
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryRoles = async (filter, options) => {
  const { Role, UserRole } = getBooksModels();
  if (filter.companyId) {
    filter.company = filter.companyId;
    delete filter.companyId;
  }

  options.populate = `permissions.module:name description`;
  const roles = await Role.paginate(filter, options);

  const roleIds = roles.results.map(role => role._id);
  const userRoles = await UserRole.find({ roleId: { $in: roleIds } });
  const roleIdToUserCount = userRoles.reduce((acc, userRole) => {
    const roleIdStr = userRole?.roleId?.toString();
    acc[roleIdStr] = (acc[roleIdStr] || 0) + 1;
    return acc;
  }, {});

  roles.results = roles.results.map(role => ({
    ...role.toObject(),
    isRoleInUse: roleIdToUserCount[role._id.toString()] > 0 || false,
  }));

  return roles;
};
/**
 * Get role by id
 * @param {ObjectId} id
 * @returns {Promise<Role>}
 */
const getRoleById = async (id, companyId) => {
  const { Role, Module } = getBooksModels();
  const role = await Role.findOne({ _id: id, company: companyId })
    .populate({
      path: 'permissions.module',
      select: 'name parentModule key',
    })
    .lean();

  if (!role) {
    throw new ApiError(httpStatus.NOT_FOUND, ROLE_MESSAGES.FETCH_NOT_FOUND);
  }

  let permissions = [];
  for (let i of role?.permissions) {
    if (i?.module?.key == 'users' || i?.module?.key == 'roles') {
      const rootModule = await Module.findById(i?.module?.parentModule);
      permissions.push({
        module: i?.module?._id,
        parentModule: rootModule?.parentModule,
        view: i?.view,
        create: i?.create,
        edit: i?.edit,
        delete: i?.delete,
        _id: i?._id,
      });
    } else {
      permissions.push({
        module: i?.module?._id,
        parentModule: i?.module?.parentModule,
        view: i?.view,
        create: i?.create,
        edit: i?.edit,
        delete: i?.delete,
        _id: i?._id,
      });
    }
  }
  role.permissions = permissions;
  role.id = role?._id;
  return role;
};
/**
 * Update role by id
 * @param {ObjectId} roleId
 * @param {Object} updateBody
 * @returns {Promise<Role>}
 */
const updateRoleById = async (roleId, updateBody, company) => {
  const { Role } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { role } = updateBody;

    const isFound = await Role.findOne({ _id: roleId, company }).session(session);
    if (!isFound) {
      throw new ApiError(httpStatus.NOT_FOUND, ROLE_MESSAGES.FETCH_NOT_FOUND);
    }

    if (/^admin$/i.test(isFound.role)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Admin role is system generated. You cannot edit this role.');
    }

    const isExist = await Role.find({
      role: { $regex: new RegExp(`^${role}$`, 'i') },
      company,
      _id: { $ne: roleId },
    }).session(session);
    if (isExist.length > 0) {
      throw new ApiError(httpStatus.CONFLICT, 'A role with this name already exists in your company');
    }

    Object.assign(isFound, updateBody);
    await isFound.save({ session });
    await session.commitTransaction();
    return isFound;
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
 * Delete role by id
 * @param {ObjectId} roleId
 * @returns {Promise<Role>}
 */
const deleteRoleById = async (roleId, companyId) => {
  const { Role, UserRole } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const inUseCount = await UserRole.countDocuments({ roleId, companyId }).session(session);
    if (inUseCount > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'This role is currently assigned to users. Please unassign it before deletion.');
    }
    const role = await Role.findOneAndDelete({ _id: roleId, company: companyId }).session(session);
    if (!role) {
      throw new ApiError(httpStatus.NOT_FOUND, ROLE_MESSAGES.FETCH_NOT_FOUND);
    }
    await session.commitTransaction();
    return role;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getRolesDropdown = async companyId => {
  const { Role } = getBooksModels();
  const roles = await Role.find({ company: companyId }).select('_id role').lean();
  return roles;
};

module.exports = {
  createRole,
  queryRoles,
  getRoleById,
  updateRoleById,
  deleteRoleById,
  getRolesDropdown,
};
