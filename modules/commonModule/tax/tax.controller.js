const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const taxService = require('./tax.service');
const { successResponse } = require('../../../services/response.service');
const { TAX_MESSAGES } = require('../../../utils/messages');

const getTaxes = catchAsync(
  async (req, res) => {
    const result = await taxService.queryTaxes(req.query);
    const { results, ...otherFields } = result;
    return successResponse(res, results, TAX_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryTaxes',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getTaxSections = catchAsync(
  async (req, res) => {
    const sections = await taxService.getTaxSections(req.query);
    return successResponse(res, sections, TAX_MESSAGES.SECTIONS_RETRIEVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTaxSections',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.SECTIONS_RETRIEVE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getTaxesDropdown = catchAsync(
  async (req, res) => {
    const taxes = await taxService.getTaxesDropdown(req.query);
    return successResponse(res, taxes, TAX_MESSAGES.DROPDOWN_RETRIEVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTaxesDropdown',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.DROPDOWN_RETRIEVE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const createTax = catchAsync(
  async (req, res) => {
    const tax = await taxService.createTax({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, { tax }, TAX_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createTax',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getTax = catchAsync(
  async (req, res) => {
    const tax = await taxService.getTaxById(req.params.taxId, req.query.companyId);
    return successResponse(res, tax, TAX_MESSAGES.SINGLE_RETRIEVE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTaxById',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.SINGLE_RETRIEVE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateTax = catchAsync(
  async (req, res) => {
    const tax = await taxService.updateTaxById(req.params.taxId, { ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, { tax }, TAX_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateTaxById',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateTaxStatus = catchAsync(
  async (req, res) => {
    const { isActive, companyId } = req.query;
    const tax = await taxService.updateTaxStatus(req.params.taxId, isActive, companyId, req.user._id);
    return successResponse(res, { tax }, TAX_MESSAGES.STATUS_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateTaxStatus',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.STATUS_UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteTax = catchAsync(
  async (req, res) => {
    await taxService.deleteTaxById(req.params.taxId, req.query.companyId);
    return successResponse(res, {}, TAX_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteTaxById',
    controller: 'tax',
    failureMessage: TAX_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  getTaxes,
  getTaxSections,
  getTaxesDropdown,
  createTax,
  getTax,
  updateTax,
  updateTaxStatus,
  deleteTax,
};
