const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const thirdPartyCredentialsService = require('./thirdPartyCredentials.service');
const { successResponse } = require('../../../services/response.service');

const getCredentials = catchAsync(
  async (req, res) => {
    const credentials = await thirdPartyCredentialsService.getCredentials(req.query.companyId, req.query.platformName);
    return successResponse(res, credentials, 'Credentials fetched successfully', httpStatus.OK);
  },
  {
    service: 'getCredentials',
    controller: 'thirdPartyCredentials',
    failureMessage: 'Failed to fetch credentials',
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getAllCredentials = catchAsync(
  async (req, res) => {
    const credentials = await thirdPartyCredentialsService.getAllCredentials(req.query.companyId);
    return successResponse(res, credentials, 'Credentials fetched successfully', httpStatus.OK);
  },
  {
    service: 'getAllCredentials',
    controller: 'thirdPartyCredentials',
    failureMessage: 'Failed to fetch credentials',
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const createCredentials = catchAsync(
  async (req, res) => {
    const credentials = await thirdPartyCredentialsService.createCredentials(
      req.body,
      req.query.companyId,
      req.user._id,
      req.query.platformName,
    );
    return successResponse(res, credentials, 'Credentials saved successfully', httpStatus.CREATED);
  },
  {
    service: 'createCredentials',
    controller: 'thirdPartyCredentials',
    failureMessage: 'Failed to save credentials',
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateCredentials = catchAsync(
  async (req, res) => {
    const credentials = await thirdPartyCredentialsService.updateCredentials(
      req.body,
      req.query.companyId,
      req.user._id,
      req.query.platformName,
    );
    return successResponse(res, credentials, 'Credentials updated successfully', httpStatus.OK);
  },
  {
    service: 'updateCredentials',
    controller: 'thirdPartyCredentials',
    failureMessage: 'Failed to update credentials',
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteCredentials = catchAsync(
  async (req, res) => {
    const result = await thirdPartyCredentialsService.deleteCredentials(req.query.companyId, req.query.platformName);
    return successResponse(res, result, 'Credentials deleted successfully', httpStatus.OK);
  },
  {
    service: 'deleteCredentials',
    controller: 'thirdPartyCredentials',
    failureMessage: 'Failed to delete credentials',
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const revealCredentials = catchAsync(
  async (req, res) => {
    const result = await thirdPartyCredentialsService.revealCredentials(
      req.query.companyId,
      req.user._id,
      req.query.platformName,
    );
    return successResponse(res, result, 'Credentials revealed', httpStatus.OK);
  },
  {
    service: 'revealCredentials',
    controller: 'thirdPartyCredentials',
    failureMessage: 'Failed to reveal credentials',
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  getCredentials,
  getAllCredentials,
  createCredentials,
  updateCredentials,
  deleteCredentials,
  revealCredentials,
};
