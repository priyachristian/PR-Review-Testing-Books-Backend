const httpStatus = require('http-status');
const catchAsync = require('../../../utils/catchAsync');
const transportCourierService = require('./transportCourier.service');
const { successResponse } = require('../../../services/response.service');
const pick = require('../../../utils/pick');
const { TRANSPORT_COURIER_MESSAGES } = require('../../../utils/messages');

const createTransportCourier = catchAsync(
  async (req, res) => {
    const data = await transportCourierService.createTransportCourier({
      ...req.body,
      companyId: req.query.companyId,
    });
    return successResponse(res, data, TRANSPORT_COURIER_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createTransportCourier',
    controller: 'transportCourier',
    failureMessage: TRANSPORT_COURIER_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTransportCouriers = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['name', 'companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const data = await transportCourierService.queryTransportCouriers(filter, options);
    const { results, ...otherFields } = data;
    return successResponse(res, results, TRANSPORT_COURIER_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryTransportCouriers',
    controller: 'transportCourier',
    failureMessage: TRANSPORT_COURIER_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getTransportCourier = catchAsync(
  async (req, res) => {
    const data = await transportCourierService.getTransportCourierById(req.params.transportCourierId, req.query.companyId);
    return successResponse(res, data, TRANSPORT_COURIER_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getTransportCourierById',
    controller: 'transportCourier',
    failureMessage: TRANSPORT_COURIER_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateTransportCourier = catchAsync(
  async (req, res) => {
    const data = await transportCourierService.updateTransportCourierById(
      req.params.transportCourierId,
      req.body,
      req.query.companyId,
    );
    return successResponse(res, data, TRANSPORT_COURIER_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateTransportCourierById',
    controller: 'transportCourier',
    failureMessage: TRANSPORT_COURIER_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteTransportCourier = catchAsync(
  async (req, res) => {
    await transportCourierService.deleteTransportCourierById(req.params.transportCourierId, req.query.companyId);
    return successResponse(res, null, TRANSPORT_COURIER_MESSAGES.DELETE_SUCCESS, httpStatus.NO_CONTENT);
  },
  {
    service: 'deleteTransportCourierById',
    controller: 'transportCourier',
    failureMessage: TRANSPORT_COURIER_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createTransportCourier,
  getTransportCouriers,
  getTransportCourier,
  updateTransportCourier,
  deleteTransportCourier,
};
