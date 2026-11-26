const Joi = require('joi');
const { objectId } = require('../../validations/custom.validation');
const {
  PROBLEM_TYPES,
  URGENCY_LEVELS,
  ATTACHMENT_TYPES,
  DEPARTMENTS,
} = require('@smit9313/abss-models-core/src/models/books/problemList.model');

const problemTypeValues = Object.values(PROBLEM_TYPES);
const urgencyValues = Object.values(URGENCY_LEVELS);
const attachmentValues = Object.values(ATTACHMENT_TYPES);
const departmentValues = Object.values(DEPARTMENTS);

const createProblemList = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().max(200).required().label('Problem Name'),
      parentProblemId: Joi.string().custom(objectId).allow(null).optional(),
      problemType: Joi.string()
        .valid(...problemTypeValues)
        .optional()
        .label('Problem Type'),
      sortOrder: Joi.number().integer().min(0).optional(),
      department: Joi.string()
        .valid(...departmentValues)
        .allow(null)
        .optional(),
      assignedTo: Joi.string().custom(objectId).allow(null).optional(),
      urgency: Joi.string()
        .valid(...urgencyValues)
        .optional(),
      replyWithinHours: Joi.number().min(0).allow(null).optional(),
      sortOutWithinDays: Joi.number().min(0).allow(null).optional(),
      requiredAttachments: Joi.array()
        .items(Joi.string().valid(...attachmentValues))
        .optional(),
      visibility: Joi.string().valid('EVERYONE').optional(),
      canAddChild: Joi.boolean().optional(),
      isActive: Joi.boolean().optional(),
    })
    .custom((value, helpers) => {
      if (!value.parentProblemId && !value.problemType) {
        return helpers.message('problemType is required when creating a root problem');
      }
      return value;
    }),
};

const getProblemLists = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    isActive: Joi.boolean().optional(),
    search: Joi.string().allow('').optional(),
  }),
};

const getProblemListById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    problemListId: Joi.string().custom(objectId).required(),
  }),
};

const updateProblemList = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    problemListId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().max(200).optional().label('Problem Name'),
      parentProblemId: Joi.string().custom(objectId).allow(null).optional(),
      sortOrder: Joi.number().integer().min(0).optional(),
      department: Joi.string()
        .valid(...departmentValues)
        .allow(null)
        .optional(),
      assignedTo: Joi.string().custom(objectId).allow(null).optional(),
      urgency: Joi.string()
        .valid(...urgencyValues)
        .optional(),
      replyWithinHours: Joi.number().min(0).allow(null).optional(),
      sortOutWithinDays: Joi.number().min(0).allow(null).optional(),
      requiredAttachments: Joi.array()
        .items(Joi.string().valid(...attachmentValues))
        .optional(),
      visibility: Joi.string().valid('EVERYONE').optional(),
      canAddChild: Joi.boolean().optional(),
      isActive: Joi.boolean().optional(),
    })
    .min(1),
};

const deleteProblemList = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    problemListId: Joi.string().custom(objectId).required(),
  }),
};

module.exports = {
  createProblemList,
  getProblemLists,
  getProblemListById,
  updateProblemList,
  deleteProblemList,
};
