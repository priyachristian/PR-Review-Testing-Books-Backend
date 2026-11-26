const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createPriceList = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    priceListCode: Joi.string().required().label('Price List Code').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    priceListName: Joi.string().required().label('Price List Name').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    remarks: Joi.string().trim().required().label('Remarks').messages({
      'string.base': '{{#label}} must be a string',
    }),
    currency: Joi.string().custom(objectId).optional().label('Currency').messages({
      'string.base': '{{#label}} must be a valid id',
    }),
    items: Joi.array()
      .items(
        Joi.object().keys({
          itemId: Joi.string().required().custom(objectId).label('Item ID').messages({
            'string.empty': '{{#label}} cannot be empty',
            'any.required': '{{#label}} is required',
          }),
          itemGroup: Joi.string().required().custom(objectId).label('itemGroup ID').messages({
            'string.empty': '{{#label}} cannot be empty',
            'any.required': '{{#label}} is required',
          }),
          netPrice: Joi.number().optional().label('Net Price').messages({
            'number.base': '{{#label}} must be a number',
          }),
          grossPrice: Joi.number().optional().label('Gross Price').messages({
            'number.base': '{{#label}} must be a number',
          }),
          unitPrices: Joi.array()
            .items(
              Joi.object().keys({
                itemUnitId: Joi.string().required().custom(objectId).label('Item Unit ID').messages({
                  'string.empty': '{{#label}} cannot be empty',
                  'any.required': '{{#label}} is required',
                }),
                netPrice: Joi.number().required().label('Net Price').messages({
                  'number.base': '{{#label}} must be a number',
                  'any.required': '{{#label}} is required',
                }),
              }),
            )
            .optional()
            .label('Unit Prices'),
        }),
      )
      .min(1)
      .messages({
        'array.min': 'At least one item is required',
      }),
  }),
};

const getPriceLists = {
  query: Joi.object().keys({
    priceListName: Joi.string(),
    companyId: Joi.string().custom(objectId),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
  }),
};

const getPriceList = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    priceListId: Joi.string().custom(objectId),
  }),
};

const updatePriceList = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    priceListId: Joi.required().custom(objectId).label('Price List ID').messages({
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object()
    .keys({
      priceListName: Joi.string().label('Price List Name').messages({
        'string.empty': '{{#label}} cannot be empty',
      }),
      remarks: Joi.string().trim().allow('').optional().label('Remarks').messages({
        'string.base': '{{#label}} must be a string',
      }),
      currency: Joi.string().custom(objectId).optional().label('Currency').messages({
        'string.base': '{{#label}} must be a valid id',
      }),
      items: Joi.array().items(
        Joi.object().keys({
          itemId: Joi.string().required().custom(objectId).label('Item ID').messages({
            'string.empty': '{{#label}} cannot be empty',
            'any.required': '{{#label}} is required',
          }),
          itemGroup: Joi.string().required().custom(objectId).label('itemGroup ID').messages({
            'string.empty': '{{#label}} cannot be empty',
            'any.required': '{{#label}} is required',
          }),
          netPrice: Joi.number().optional().label('Net Price').messages({
            'number.base': '{{#label}} must be a number',
          }),
          grossPrice: Joi.number().optional().label('Gross Price').messages({
            'number.base': '{{#label}} must be a number',
          }),
          unitPrices: Joi.array()
            .items(
              Joi.object().keys({
                itemUnitId: Joi.string().required().custom(objectId).label('Item Unit ID').messages({
                  'string.empty': '{{#label}} cannot be empty',
                  'any.required': '{{#label}} is required',
                }),
                netPrice: Joi.number().required().label('Net Price').messages({
                  'number.base': '{{#label}} must be a number',
                  'any.required': '{{#label}} is required',
                }),
              }),
            )
            .optional()
            .label('Unit Prices'),
        }),
      ),
    })
    .min(1)
    .messages({
      'object.min': 'At least one field is required to update',
    }),
};

const deletePriceList = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    priceListId: Joi.string().custom(objectId),
  }),
};

const getPriceListsDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
};

module.exports = {
  createPriceList,
  getPriceLists,
  getPriceList,
  updatePriceList,
  deletePriceList,
  getPriceListsDropdown,
};
