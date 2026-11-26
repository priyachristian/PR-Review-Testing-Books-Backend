const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const divisionService = require('./division.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { DIVISION_MESSAGES } = require('../../../utils/messages');

const createDivision = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const division = await divisionService.createNewDivision({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { division }, DIVISION_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createNewDivision',
    controller: 'division',
    failureMessage: DIVISION_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDivisions = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'isActive', 'status']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await divisionService.getDivisionsByCompanyId(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, DIVISION_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getDivisionsByCompanyId',
    controller: 'division',
    failureMessage: DIVISION_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDivisionDropDown = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    const result = await divisionService.getDivisionIdsAndNamesByCompanyId(companyId);
    const { divisions, blockedApp } = result;
    return successResponse(res, { result: divisions }, DIVISION_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK, { blockedApp });
  },
  {
    service: 'getDivisionIdsAndNamesByCompanyId',
    controller: 'division',
    failureMessage: DIVISION_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateDivision = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const division = await divisionService.updateDivisionById(
      req.params.divisionId,
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, { division }, DIVISION_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateDivisionById',
    controller: 'division',
    failureMessage: DIVISION_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteDivision = catchAsync(
  async (req, res) => {
    await divisionService.deleteDivisionById(req.params.divisionId, req.query.companyId);
    return successResponse(res, {}, DIVISION_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteDivisionById',
    controller: 'division',
    failureMessage: DIVISION_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDivisonById = catchAsync(
  async (req, res) => {
    const division = await divisionService.getDivisonById(req.params.divisionId, req.query.companyId);
    return successResponse(res, division, DIVISION_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getDivisonById',
    controller: 'division',
    failureMessage: DIVISION_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const { divisionId } = req.params;
    const { isActive, companyId } = req.query;
    const division = await divisionService.updateStatus(divisionId, isActive, companyId);
    return successResponse(res, division, DIVISION_MESSAGES.UPDATE_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateStatus',
    controller: 'division',
    failureMessage: DIVISION_MESSAGES.UPDATE_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createDivision,
  getDivisions,
  updateDivision,
  deleteDivision,
  getDivisionDropDown,
  getDivisonById,
  updateStatus,
};
