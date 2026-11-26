const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const qcMasterService = require('./qualityMaster.service');
const { successResponse } = require('../../../services/response.service');
const { QC_MASTER_MESSAGES } = require('../../../utils/messages');

const createQCMaster = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const newQCMaster = await qcMasterService.createNewQCMaster({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, { newQCMaster }, QC_MASTER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createNewQCMaster',
    controller: 'qualityMaster',
    failureMessage: QC_MASTER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllQCMasters = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const qcMasters = await qcMasterService.getAllQCMasters(req.query, filter, options);
    const { results, ...otherFields } = qcMasters;
    return successResponse(res, results, QC_MASTER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllQCMasters',
    controller: 'qualityMaster',
    failureMessage: QC_MASTER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateQCMaster = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const qcMasterId = req.params.qcMasterId;
    const updatedQCMaster = await qcMasterService.updateQCMaster(
      qcMasterId,
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, { updatedQCMaster }, QC_MASTER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateQCMaster',
    controller: 'qualityMaster',
    failureMessage: QC_MASTER_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteQCMaster = catchAsync(
  async (req, res) => {
    const qcMasterId = req.params.qcMasterId;
    await qcMasterService.deleteQCMaster(qcMasterId, req.query.companyId);
    return successResponse(res, {}, QC_MASTER_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteQCMaster',
    controller: 'qualityMaster',
    failureMessage: QC_MASTER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getQCDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await qcMasterService.getQCDropdown(filter);
    return successResponse(res, result, QC_MASTER_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getQCDropdown',
    controller: 'qualityMaster',
    failureMessage: QC_MASTER_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getQCById = catchAsync(
  async (req, res) => {
    const result = await qcMasterService.getQCById(req.params.qcMasterId, req.query.companyId);
    return successResponse(res, result, QC_MASTER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getQCById',
    controller: 'qualityMaster',
    failureMessage: QC_MASTER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createQCMaster,
  getAllQCMasters,
  updateQCMaster,
  deleteQCMaster,
  getQCDropdown,
  getQCById,
};
