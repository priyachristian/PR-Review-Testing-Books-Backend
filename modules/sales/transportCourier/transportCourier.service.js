const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { TRANSPORT_COURIER_MESSAGES } = require('../../../utils/messages');
// const  TransportCourier  = require('../models/transportCourier.model');
const { getBooksModels } = require('../../../services/model.service');

const createTransportCourier = async body => {
  const { TransportCourier } = getBooksModels();
  const courier = await TransportCourier.create(body);
  return courier;
};

const queryTransportCouriers = async (filter, options) => {
  const { TransportCourier } = getBooksModels();
  options.pagination = false;
  const couriers = await TransportCourier.paginate(filter, options);
  return couriers;
};

const getTransportCourierById = async (id, companyId) => {
  const { TransportCourier } = getBooksModels();
  const courier = await TransportCourier.findOne({ _id: id, companyId });
  if (!courier) {
    throw new ApiError(httpStatus.NOT_FOUND, TRANSPORT_COURIER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return courier;
};

const updateTransportCourierById = async (id, updateBody, companyId) => {
  const { TransportCourier } = getBooksModels();
  const courier = await TransportCourier.findOne({ _id: id, companyId });
  if (!courier) {
    throw new ApiError(httpStatus.NOT_FOUND, TRANSPORT_COURIER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  Object.assign(courier, updateBody);
  await courier.save();
  return courier;
};

const deleteTransportCourierById = async (id, companyId) => {
  const { TransportCourier } = getBooksModels();
  const courier = await TransportCourier.findOne({ _id: id, companyId });
  if (!courier) {
    throw new ApiError(httpStatus.NOT_FOUND, TRANSPORT_COURIER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  await courier.remove();
  return true;
};

module.exports = {
  createTransportCourier,
  queryTransportCouriers,
  getTransportCourierById,
  updateTransportCourierById,
  deleteTransportCourierById,
};
