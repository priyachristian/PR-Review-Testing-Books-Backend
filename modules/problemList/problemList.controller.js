const httpStatus = require('http-status');
const catchAsync = require('../../utils/catchAsync');
const pick = require('../../utils/pick');
const { successResponse } = require('../../services/response.service');
const { PROBLEM_LIST_MESSAGES } = require('../../utils/messages');
const problemListService = require('./problemList.service');

const createProblemList = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const problem = await problemListService.createProblemList({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { problem }, PROBLEM_LIST_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createProblemList',
    controller: 'problemList',
    failureMessage: PROBLEM_LIST_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProblemLists = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isActive', 'search']);
    const tree = await problemListService.getProblemListTree(filter);
    return successResponse(res, tree, PROBLEM_LIST_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProblemListTree',
    controller: 'problemList',
    failureMessage: PROBLEM_LIST_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getProblemListById = catchAsync(
  async (req, res) => {
    const problem = await problemListService.getProblemListById(req.params.problemListId, req.query.companyId);
    return successResponse(res, problem, PROBLEM_LIST_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProblemListById',
    controller: 'problemList',
    failureMessage: PROBLEM_LIST_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateProblemList = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const problem = await problemListService.updateProblemListById(
      req.params.problemListId,
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, { problem }, PROBLEM_LIST_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateProblemListById',
    controller: 'problemList',
    failureMessage: PROBLEM_LIST_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteProblemList = catchAsync(
  async (req, res) => {
    await problemListService.deleteProblemListById(req.params.problemListId, req.query.companyId);
    return successResponse(res, {}, PROBLEM_LIST_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteProblemListById',
    controller: 'problemList',
    failureMessage: PROBLEM_LIST_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createProblemList,
  getProblemLists,
  getProblemListById,
  updateProblemList,
  deleteProblemList,
};
