const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const currencyService = require('./currency.service');
const { successResponse } = require('../../../services/response.service');
const { CURRENCY_MESSAGES } = require('../../../utils/messages');

const createCurrency = catchAsync(
  async (req, res) => {
    const currency = await currencyService.createCurrency({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, { currency }, CURRENCY_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createCurrency',
    controller: 'currency',
    failureMessage: CURRENCY_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getCurrencies = catchAsync(
  async (req, res) => {
    const result = await currencyService.queryCurrencies(req.query);
    const { results, ...otherFields } = result;
    return successResponse(res, results, CURRENCY_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryCurrencies',
    controller: 'currency',
    failureMessage: CURRENCY_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateCurrency = catchAsync(
  async (req, res) => {
    const currency = await currencyService.updateCurrencyById(req.params.currencyId, {
      ...req.body,
      companyId: req.query.companyId,
    });
    return successResponse(res, { currency }, CURRENCY_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateCurrencyById',
    controller: 'currency',
    failureMessage: CURRENCY_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteCurrency = catchAsync(
  async (req, res) => {
    await currencyService.deleteCurrencyById(req.params.currencyId, req.query.companyId);
    return successResponse(res, {}, CURRENCY_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteCurrencyById',
    controller: 'currency',
    failureMessage: CURRENCY_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createCurrency,
  getCurrencies,
  updateCurrency,
  deleteCurrency,
};
