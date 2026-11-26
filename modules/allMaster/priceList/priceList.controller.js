const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const priceListService = require('./priceList.service');
const { successResponse } = require('../../../services/response.service');
const { PRICE_LIST_MESSAGES } = require('../../../utils/messages');

const createPriceList = catchAsync(
  async (req, res) => {
    const priceList = await priceListService.createPriceList({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, priceList, PRICE_LIST_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createPriceList',
    controller: 'priceList',
    failureMessage: PRICE_LIST_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getPriceLists = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['priceListName', 'companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await priceListService.queryPriceLists(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, PRICE_LIST_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryPriceLists',
    controller: 'priceList',
    failureMessage: PRICE_LIST_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getPriceList = catchAsync(
  async (req, res) => {
    const priceList = await priceListService.getPriceListById(req.params.priceListId, req.query.companyId);
    return successResponse(res, priceList, PRICE_LIST_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPriceListById',
    controller: 'priceList',
    failureMessage: PRICE_LIST_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updatePriceList = catchAsync(
  async (req, res) => {
    const priceList = await priceListService.updatePriceListById(req.params.priceListId, req.body);
    return successResponse(res, priceList, PRICE_LIST_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updatePriceListById',
    controller: 'priceList',
    failureMessage: PRICE_LIST_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deletePriceList = catchAsync(
  async (req, res) => {
    await priceListService.deletePriceListById(req.params.priceListId, req.query.companyId);
    return successResponse(res, {}, PRICE_LIST_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deletePriceListById',
    controller: 'priceList',
    failureMessage: PRICE_LIST_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const dropdownPriceLists = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const result = await priceListService.dropdownPriceLists(filter);
    return successResponse(res, result, PRICE_LIST_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, {});
  },
  {
    service: 'dropdownPriceLists',
    controller: 'priceList',
    failureMessage: PRICE_LIST_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createPriceList,
  getPriceLists,
  getPriceList,
  updatePriceList,
  deletePriceList,
  dropdownPriceLists,
};
