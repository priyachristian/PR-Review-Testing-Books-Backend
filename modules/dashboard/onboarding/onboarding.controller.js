const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const onboardingService = require('./onboarding.service');
const dataSetupService = require('./dataSetup.service');
const { successResponse } = require('../../../services/response.service');
const { ONBOARDING_MESSAGES } = require('../../../utils/messages');

const getOnboardingStatus = catchAsync(
  async (req, res) => {
    const result = await onboardingService.getOnboardingStatus({ companyId: req.query.companyId });
    return successResponse(res, result, ONBOARDING_MESSAGES.FETCH_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getOnboardingStatus',
    controller: 'onboarding',
    failureMessage: ONBOARDING_MESSAGES.FETCH_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDataSetupStatus = catchAsync(
  async (req, res) => {
    const result = await dataSetupService.getDataSetupStatus({ companyId: req.query.companyId });
    return successResponse(res, result, ONBOARDING_MESSAGES.FETCH_DATA_SETUP_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getDataSetupStatus',
    controller: 'onboarding',
    failureMessage: ONBOARDING_MESSAGES.FETCH_DATA_SETUP_STATUS_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getDataSetupPreview = catchAsync(
  async (req, res) => {
    const result = await dataSetupService.getDataSetupPreview({
      companyId: req.query.companyId,
      key: req.query.key,
    });
    return successResponse(res, result, ONBOARDING_MESSAGES.FETCH_DATA_SETUP_PREVIEW_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getDataSetupPreview',
    controller: 'onboarding',
    failureMessage: ONBOARDING_MESSAGES.FETCH_DATA_SETUP_PREVIEW_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const runDataSetup = catchAsync(
  async (req, res) => {
    const result = await dataSetupService.runDataSetup({
      companyId: req.query.companyId,
      key: req.body.key,
      params: req.body.params,
    });
    return successResponse(res, result, ONBOARDING_MESSAGES.RUN_DATA_SETUP_SUCCESS, httpStatus.OK);
  },
  {
    service: 'runDataSetup',
    controller: 'onboarding',
    failureMessage: ONBOARDING_MESSAGES.RUN_DATA_SETUP_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  getOnboardingStatus,
  getDataSetupStatus,
  getDataSetupPreview,
  runDataSetup,
};
