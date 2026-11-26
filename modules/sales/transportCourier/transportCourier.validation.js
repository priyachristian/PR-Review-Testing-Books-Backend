const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createTransportCourier = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    name: Joi.string().required(),
    bookingOfficeAddress: Joi.string().allow('', null),
    trackingLink: Joi.string().allow('', null),
    gstNo: Joi.string().allow('', null),
  }),
};

const getTransportCouriers = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    name: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

const getTransportCourier = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    transportCourierId: Joi.string().custom(objectId),
  }),
};

const updateTransportCourier = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    transportCourierId: Joi.string().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string(),
      bookingOfficeAddress: Joi.string().allow('', null),
      trackingLink: Joi.string().allow('', null),
      gstNo: Joi.string().allow('', null),
    })
    .min(1),
};

const deleteTransportCourier = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    transportCourierId: Joi.string().custom(objectId),
  }),
};

module.exports = {
  createTransportCourier,
  getTransportCouriers,
  getTransportCourier,
  updateTransportCourier,
  deleteTransportCourier,
};
