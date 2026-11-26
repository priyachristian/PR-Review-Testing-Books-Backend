const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const maintenancePurchaseService = require('./maintenancePurchase.service');
const { MAINTENANCE_PURCHASE_MESSAGES } = require('../../../utils/messages');
const { successResponse } = require('../../../services/response.service');

// Status actions respond with the same document the view API returns, so the client can replace its copy directly.
const viewResult = (id, companyId) => maintenancePurchaseService.getMaintenancePurchaseById(id, companyId);

const createMaintenancePurchase = catchAsync(
  async (req, res) => {
    await maintenancePurchaseService.createMaintenancePurchase({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, null, MAINTENANCE_PURCHASE_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createMaintenancePurchase',
    controller: 'maintenancePurchase',
    failureMessage: MAINTENANCE_PURCHASE_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const approveMaintenancePurchase = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenancePurchaseService.approveMaintenancePurchase({ ...req.body, companyId, id: req.params.id }, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_PURCHASE_MESSAGES.APPROVE_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'approveMaintenancePurchase',
    controller: 'maintenancePurchase',
    failureMessage: MAINTENANCE_PURCHASE_MESSAGES.APPROVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const raisePurchaseOrder = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenancePurchaseService.raisePurchaseOrder({ ...req.body, companyId, id: req.params.id }, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_PURCHASE_MESSAGES.RAISE_PO_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'raisePurchaseOrder',
    controller: 'maintenancePurchase',
    failureMessage: MAINTENANCE_PURCHASE_MESSAGES.RAISE_PO_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const receiveMaintenancePurchase = catchAsync(
  async (req, res) => {
    const { companyId } = req.query;
    await maintenancePurchaseService.receiveMaintenancePurchase({ ...req.body, companyId, id: req.params.id }, req.user._id);
    return successResponse(
      res,
      await viewResult(req.params.id, companyId),
      MAINTENANCE_PURCHASE_MESSAGES.RECEIVE_SUCCESS,
      httpStatus.OK,
    );
  },
  {
    service: 'receiveMaintenancePurchase',
    controller: 'maintenancePurchase',
    failureMessage: MAINTENANCE_PURCHASE_MESSAGES.RECEIVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getAllMaintenancePurchases = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await maintenancePurchaseService.getAllMaintenancePurchases(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, MAINTENANCE_PURCHASE_MESSAGES.RETRIEVE_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getAllMaintenancePurchases',
    controller: 'maintenancePurchase',
    failureMessage: MAINTENANCE_PURCHASE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMaintenancePurchaseById = catchAsync(
  async (req, res) => {
    const result = await maintenancePurchaseService.getMaintenancePurchaseById(req.params.id, req.query.companyId);
    return successResponse(res, result, MAINTENANCE_PURCHASE_MESSAGES.RETRIEVE_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getMaintenancePurchaseById',
    controller: 'maintenancePurchase',
    failureMessage: MAINTENANCE_PURCHASE_MESSAGES.RETRIEVE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getMaintenancePurchaseDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'search', 'stage', 'linkedMrId']);
    const result = await maintenancePurchaseService.getMaintenancePurchaseDropdown(filter);
    return successResponse(res, result, MAINTENANCE_PURCHASE_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getMaintenancePurchaseDropdown',
    controller: 'maintenancePurchase',
    failureMessage: MAINTENANCE_PURCHASE_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  getMaintenancePurchaseDropdown,
  getAllMaintenancePurchases,
  getMaintenancePurchaseById,
  createMaintenancePurchase,
  receiveMaintenancePurchase,
  raisePurchaseOrder,
  approveMaintenancePurchase,
};
