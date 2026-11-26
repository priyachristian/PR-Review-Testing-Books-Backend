const httpStatus = require('http-status');
const catchAsync = require('../../utils/catchAsync');
const { successResponse } = require('../../services/response.service');
const masterLocationService = require('./masterLocation.service');
const { LOCATION_MESSAGES } = require('../../utils/messages');

const getCountries = catchAsync(
  async (req, res) => {
    const data = await masterLocationService.getCountries();
    return successResponse(res, data, LOCATION_MESSAGES.COUNTRIES_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCountries',
    controller: 'masterLocation',
    failureMessage: LOCATION_MESSAGES.COUNTRIES_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getStates = catchAsync(
  async (req, res) => {
    const { countryId } = req.query;
    const data = await masterLocationService.getStates(countryId);
    return successResponse(res, data, LOCATION_MESSAGES.STATES_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getStates',
    controller: 'masterLocation',
    failureMessage: LOCATION_MESSAGES.STATES_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getCities = catchAsync(
  async (req, res) => {
    const { stateId } = req.query;
    const data = await masterLocationService.getCities(stateId);
    return successResponse(res, data, LOCATION_MESSAGES.CITIES_FETCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getCities',
    controller: 'masterLocation',
    failureMessage: LOCATION_MESSAGES.CITIES_FETCH_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getCountries,
  getStates,
  getCities,
};
