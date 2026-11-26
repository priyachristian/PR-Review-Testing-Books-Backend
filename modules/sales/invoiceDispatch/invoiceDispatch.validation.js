const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createInvoiceDispatch = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    invoiceId: Joi.string().custom(objectId).required(),
    dispatchMode: Joi.string()
      .valid('Transport & Courier Service', 'Full Truck Load', 'OurSelf Delivery', 'Pickup By Customer')
      .required(),
    goodsBookingDate: Joi.date().optional(),
    approxDeliveryDate: Joi.date().optional(),

    transportCourier: Joi.when('dispatchMode', {
      is: 'Transport & Courier Service',
      then: Joi.object({
        transportType: Joi.string().valid('Transport', 'Courier').required(),
        transportId: Joi.string().custom(objectId).required(),
        trackingNumber: Joi.string().optional().allow('', null),
        trackingLink: Joi.string().optional().allow('', null),
        bookingCopyImage: Joi.array().items(Joi.string().trim()).optional().label('Booking Copy Image').messages({
          'array.base': '{{#label}} must be an array of strings',
        }),
      }).required(),
      otherwise: Joi.object().optional(),
    }),

    truckLoad: Joi.when('dispatchMode', {
      is: 'Full Truck Load',
      then: Joi.object({
        truckName: Joi.string().optional().allow('', null),
        truckNumber: Joi.string().optional().allow('', null),
        driverName: Joi.string().optional().allow('', null),
        driverContact: Joi.string().optional().allow('', null),
        truck_goodsImage: Joi.array().items(Joi.string().trim()).optional().label('Booking Copy Image').messages({
          'array.base': '{{#label}} must be an array of strings',
        }),
      }).required(),
      otherwise: Joi.object().optional(),
    }),

    selfDelivery: Joi.when('dispatchMode', {
      is: Joi.valid('OurSelf Delivery', 'Pickup By Customer'),
      then: Joi.object({
        deliveryBoyName: Joi.string().optional().allow('', null),
        vehicleNumber: Joi.string().optional().allow('', null),
        driverName: Joi.string().optional().allow('', null),
        driverContact: Joi.string().optional().allow('', null),
        vehicle_goodsImage: Joi.array().items(Joi.string().trim()).optional().label('Booking Copy Image').messages({
          'array.base': '{{#label}} must be an array of strings',
        }),
      }).required(),
      otherwise: Joi.object().optional(),
    }),
  }),
};

const getDispatch = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

const updateInvoiceDispatch = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      dispatchMode: Joi.string()
        .valid('Transport & Courier Service', 'Full Truck Load', 'OurSelf Delivery', 'Pickup By Customer')
        .required(),
      goodsBookingDate: Joi.date().optional(),
      approxDeliveryDate: Joi.date().optional(),

      transportCourier: Joi.when('dispatchMode', {
        is: 'Transport & Courier Service',
        then: Joi.object({
          transportType: Joi.string().valid('Transport', 'Courier').required(),
          transportId: Joi.string().custom(objectId).required(),
          trackingNumber: Joi.string().optional().allow('', null),
          trackingLink: Joi.string().optional().allow('', null),
          bookingCopyImage: Joi.array().items(Joi.string().trim()).optional().label('Booking Copy Image').messages({
            'array.base': '{{#label}} must be an array of strings',
          }),
        }).required(),
        otherwise: Joi.object().optional(),
      }),
      truckLoad: Joi.object().optional(),
      selfDelivery: Joi.object().optional(),
    })
    .min(1), // At least one field required
};

const deleteInvoiceDispatch = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required(),
  }),
};

module.exports = {
  createInvoiceDispatch,
  getDispatch,
  updateInvoiceDispatch,
  deleteInvoiceDispatch,
};
