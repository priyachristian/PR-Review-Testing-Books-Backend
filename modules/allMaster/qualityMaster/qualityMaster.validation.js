const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const createQCMaster = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    qcReportID: Joi.string().required(),
    qcType: Joi.string().required().label('QC Type').messages({
      'any.required': '"QC Type" is required',
    }),
    qcReportName: Joi.string().required().label('QC Report Name').messages({
      'any.required': '"QC Report Name" is required',
    }),
    qcReportResponsible: Joi.string().required().label('QC Report Responsible').messages({
      'any.required': '"QC Report Responsible" is required',
    }),
    productName: Joi.string().required().label('Product Name').messages({
      'any.required': '"Product Name" is required',
    }),
    tests: Joi.array()
      .items(
        Joi.object().keys({
          testName: Joi.string().required().label('Test Name').messages({
            'any.required': '"Test Name" is required',
          }),
          responseType: Joi.string().valid('possibleResponses', 'custom', 'single').required().label('Response Type').messages({
            'any.required': '"Response Type" is required',
            'any.only': '"Response Type" must be one of [possibleResponses, custom, single]',
          }),
          possibleResponses: Joi.array()
            .items(
              Joi.object().keys({
                label: Joi.string().label('Response Label'),
                value: Joi.string().label('Response Value'),
                color: Joi.string().label('Response Color'),
              }),
            )
            .label('Possible Responses'),
          selectedResponse: Joi.string().label('Selected Response'),
          customInputFields: Joi.object()
            .keys({
              weight: Joi.number().label('Weight'),
              length: Joi.number().label('Length'),
              width: Joi.number().label('Width'),
              height: Joi.number().label('Height'),
              volume: Joi.number().label('Volume'),
            })
            .label('Custom Input Fields'),
          remark: Joi.string().label('Remark'),
        }),
      )
      .required()
      .label('Tests')
      .messages({
        'any.required': '"Tests" is required',
      }),
  }),
};

const getQCMasters = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
  }),
};

const getQCDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
};

const updateQCMaster = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    qcMasterId: Joi.string().required().custom(objectId).label('QC Master ID').messages({
      'any.required': '"QC Master ID" is required',
    }),
  }),
  body: Joi.object().keys({
    qcType: Joi.string().label('QC Type'),
    qcReportName: Joi.string().label('QC Report Name'),
    qcReportResponsible: Joi.string().label('QC Report Responsible'),
    productName: Joi.string().label('Product Name'),
    tests: Joi.array()
      .items(
        Joi.object().keys({
          testName: Joi.string().label('Test Name'),
          responseType: Joi.string().valid('possibleResponses', 'custom', 'single').label('Response Type').messages({
            'any.only': '"Response Type" must be one of [possibleResponses, custom, single]',
          }),
          possibleResponses: Joi.array()
            .items(
              Joi.object().keys({
                label: Joi.string().label('Response Label'),
                value: Joi.string().label('Response Value'),
                color: Joi.string().label('Response Color'),
              }),
            )
            .label('Possible Responses'),
          selectedResponse: Joi.string().label('Selected Response'),
          customInputFields: Joi.object()
            .keys({
              weight: Joi.number().label('Weight'),
              length: Joi.number().label('Length'),
              width: Joi.number().label('Width'),
              height: Joi.number().label('Height'),
              volume: Joi.number().label('Volume'),
            })
            .label('Custom Input Fields'),
          remark: Joi.string().label('Remark'),
        }),
      )
      .label('Tests'),
  }),
};

const deleteQCMaster = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    qcMasterId: Joi.string().required().custom(objectId),
  }),
};

const getQCById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    qcMasterId: Joi.string().required().custom(objectId),
  }),
};

module.exports = {
  createQCMaster,
  getQCMasters,
  updateQCMaster,
  deleteQCMaster,
  getQCDropdown,
  getQCById,
};
