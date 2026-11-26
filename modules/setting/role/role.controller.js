const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const roleService = require('./role.service');
const { successResponse } = require('../../../services/response.service');
const { ROLE_MESSAGES } = require('../../../utils/messages');

const createRole = catchAsync(
  async (req, res) => {
    const role = await roleService.createRole({ ...req.body, company: req.query.companyId }, req.user._id);
    return successResponse(res, role, ROLE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createRole',
    controller: 'role',
    failureMessage: ROLE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRoles = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['role', 'companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await roleService.queryRoles(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, ROLE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryRoles',
    controller: 'role',
    failureMessage: ROLE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRole = catchAsync(
  async (req, res) => {
    const role = await roleService.getRoleById(req.params.roleId, req.query.companyId);
    return successResponse(res, role, ROLE_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRoleById',
    controller: 'role',
    failureMessage: ROLE_MESSAGES.FETCH_NOT_FOUND,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRole = catchAsync(
  async (req, res) => {
    const role = await roleService.updateRoleById(req.params.roleId, req.body, req.query.companyId);
    return successResponse(res, role, ROLE_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRoleById',
    controller: 'role',
    failureMessage: ROLE_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteRole = catchAsync(
  async (req, res) => {
    const result = await roleService.deleteRoleById(req.params.roleId, req.query.companyId);
    return successResponse(res, {}, ROLE_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteRoleById',
    controller: 'role',
    failureMessage: ROLE_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRolesDropdown = catchAsync(
  async (req, res) => {
    const roles = await roleService.getRolesDropdown(req.query.companyId);
    return successResponse(res, roles, ROLE_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRolesDropdown',
    controller: 'role',
    failureMessage: ROLE_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createRole,
  getRoles,
  getRole,
  updateRole,
  deleteRole,
  getRolesDropdown,
};
