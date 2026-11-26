const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const branchService = require('./branch.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { BRANCH_MESSAGES } = require('../../../utils/messages');

const createBranch = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const branch = await branchService.createNewBranch({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { branch }, BRANCH_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createNewBranch',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllBranches = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isSplit', 'isActive', 'divisionId', 'status']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const branches = await branchService.getAllBranches(req.query, filter, options);
    const { results, ...otherFields } = branches;
    return successResponse(res, results, BRANCH_MESSAGES.FETCH_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllBranches',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateBranch = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const branchId = req.params.branchId;
    const updatedBranch = await branchService.updateBranch(branchId, { ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { branch: updatedBranch }, BRANCH_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateBranch',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteBranch = catchAsync(
  async (req, res) => {
    const branchId = req.params.branchId;
    await branchService.deleteBranch(branchId, req.query.companyId);
    return successResponse(res, {}, BRANCH_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteBranch',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBranchDropDown = catchAsync(
  async (req, res) => {
    const { divisionId, companyId, isSplit } = req.query;
    const result = await branchService.getBranchIdsAndNamesByDivisionId(divisionId, companyId, isSplit);
    return successResponse(res, result, BRANCH_MESSAGES.DROPDOWN_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBranchIdsAndNamesByDivisionId',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.DROPDOWN_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getBranchById = catchAsync(
  async (req, res) => {
    const branchId = req.params.branchId;
    const branch = await branchService.getBranchById(branchId, req.query.companyId);

    return successResponse(res, branch, BRANCH_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getBranchById',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllBranchesWithDivision = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const branches = await branchService.getAllBranchesWithDivision(companyId);
    return successResponse(res, branches, BRANCH_MESSAGES.FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAllBranchesWithDivision',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const branchId = req.params.branchId;
    const { isActive, companyId } = req.query;
    const updatedBranch = await branchService.updateStatus(branchId, isActive, companyId);
    return successResponse(res, updatedBranch, BRANCH_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateStatus',
    controller: 'branch',
    failureMessage: BRANCH_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createBranch,
  getAllBranches,
  updateBranch,
  deleteBranch,
  getBranchDropDown,
  getBranchById,
  getAllBranchesWithDivision,
  updateStatus,
};
