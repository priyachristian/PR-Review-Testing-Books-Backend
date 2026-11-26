const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const { tokenService, onboardService } = require('../../../services');
const userService = require('./user.service');
const userTransformers = require('./user.transformer');
const { tokenTypes } = require('../../../config/tokens');
const { successResponse } = require('../../../services/response.service');
const { USER_MESSAGES } = require('../../../utils/messages');
const { getCommonModels, getBooksModels } = require('../../../services/model.service');

const createUser = catchAsync(
  async (req, res) => {
    const user = await userService.createUser(req.body);
    return successResponse(res, user, USER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createUser',
    controller: 'user',
    failureMessage: USER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getUsers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['name', 'role', 'companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await userService.queryUsers(filter, options);
    const { results, ...otherFields } = result;
    const transformedUsers = userTransformers.queryUsers(results);
    return successResponse(res, transformedUsers, USER_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryUsers',
    controller: 'user',
    failureMessage: USER_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getUser = catchAsync(
  async (req, res) => {
    const user = await userService.getUserById(req.params.userId);
    return successResponse(res, user, USER_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getUserById',
    controller: 'user',
    failureMessage: USER_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getUserRole = catchAsync(
  async (req, res) => {
    const userRole = await userService.getUserRole(req.params.userId, req.query.companyId);
    return successResponse(res, userRole, USER_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getUserRole',
    controller: 'user',
    failureMessage: USER_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getUserProfile = catchAsync(
  async (req, res) => {
    const profile = await userService.getUserProfile(req.params.userId, req.query.companyId);
    return successResponse(res, profile, USER_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getUserProfile',
    controller: 'user',
    failureMessage: USER_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateUser = catchAsync(
  async (req, res) => {
    const user = await userService.updateUserById(req.params.userId, req.body);
    return successResponse(res, user, USER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateUserById',
    controller: 'user',
    failureMessage: USER_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteUser = catchAsync(
  async (req, res) => {
    await userService.deleteUserById(req.params.userId);
    return successResponse(res, null, USER_MESSAGES.DELETE_SUCCESS, httpStatus.NO_CONTENT);
  },
  {
    service: 'deleteUserById',
    controller: 'user',
    failureMessage: USER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const inviteUser = catchAsync(
  async (req, res) => {
    const { email, roleId, type } = req.body;
    const companyId = req.query.companyId;
    await onboardService.inviteUser(email, companyId, roleId, type, req.user._id);
    return successResponse(res, {}, USER_MESSAGES.INVITE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'inviteUser',
    controller: 'user',
    failureMessage: USER_MESSAGES.INVITE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const verifyInvite = catchAsync(
  async (req, res) => {
    const { Company } = getCommonModels();
    const { UserRole } = getBooksModels();
    const { token } = req.body;
    const payload = await tokenService.verifyToken(token, tokenTypes.INVITE);
    const company = await Company.findById(payload.companyId);
    const activeUserRole = await UserRole.findOne({
      userId: payload._id,
      companyId: { $ne: payload.companyId },
      status: 'active',
    });

    const isUserActive = !!activeUserRole;

    return successResponse(
      res,
      {
        ...payload,
        companyName: company.name,
        isUserActive,
      },
      USER_MESSAGES.VERIFY_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'verifyToken',
    controller: 'user',
    failureMessage: USER_MESSAGES.VERIFY_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const changeUserStatus = catchAsync(
  async (req, res) => {
    const { userId, status } = req.body;
    const companyId = req.query.companyId;
    const updatedUserRole = await userService.changeUserStatus(userId, companyId, status);
    return successResponse(res, updatedUserRole, USER_MESSAGES.STATUS_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'changeUserStatus',
    controller: 'user',
    failureMessage: USER_MESSAGES.STATUS_UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const defaultconfiguration = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const companyId = req.query.companyId;
    const settings = await userService.defaultconfiguration(req.body, userId, companyId);
    return successResponse(res, settings, USER_MESSAGES.SET_DEFAULT_CONFIGURATION, httpStatus.OK);
  },
  {
    service: 'defaultconfiguration',
    controller: 'user',
    failureMessage: USER_MESSAGES.FAILE_DEFAULT_CONFIGURATION,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getUsersDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await userService.queryUsersDropdown(filter);
    return successResponse(res, result, USER_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'queryUsersDropdown',
    controller: 'user',
    failureMessage: USER_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateUserStatusAndRole = catchAsync(
  async (req, res) => {
    const userId = req.params.userId;
    const companyId = req.query.companyId;
    const user = await userService.updateUserStatusAndRole(userId, companyId, req.body);
    return successResponse(res, user, USER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateUserStatusAndRole',
    controller: 'user',
    failureMessage: USER_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteCompanyUser = catchAsync(
  async (req, res) => {
    const userId = req.params.userId;
    const companyId = req.query.companyId;
    await userService.deleteCompanyUser(userId, companyId);
    return successResponse(res, null, USER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteCompanyUser',
    controller: 'user',
    failureMessage: USER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createUser,
  getUsers,
  getUser,
  updateUser,
  deleteUser,
  inviteUser,
  verifyInvite,
  changeUserStatus,
  getUserRole,
  getUserProfile,
  defaultconfiguration,
  getUsersDropdown,
  updateUserStatusAndRole,
  deleteCompanyUser,
};
