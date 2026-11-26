const Joi = require('joi');
const { objectId } = require('../../validations/custom.validation');
const {
  COMPLAINT_FORM_TYPES,
  COMPLAINT_STEPS,
  COMPLAINT_CONTACT_CHANNELS,
  COMPLAINT_WARRANTY_POSITIONS,
  COMPLAINT_SETTLEMENT_TYPES,
  COMPLAINT_FIX_HELD_RESULTS,
  COMPLAINT_WAITING_REASONS,
  COMPLAINT_NOT_REAL_REASONS,
  COMPLAINT_REOPEN_REASONS,
  COMPLAINT_LINK_TYPES,
  COMPLAINT_LIST_STATUS,
  PROBLEM_TYPES,
  DEPARTMENTS,
  ATTACHMENT_TYPES,
  URGENCY_LEVELS,
} = require('@smit9313/abss-models-core/src/utils/enum');

const formTypeValues = Object.values(COMPLAINT_FORM_TYPES);
const stepValues = Object.values(COMPLAINT_STEPS);
const channelValues = Object.values(COMPLAINT_CONTACT_CHANNELS);
const departmentValues = Object.values(DEPARTMENTS);
const attachmentTypeValues = Object.values(ATTACHMENT_TYPES);
const warrantyValues = Object.values(COMPLAINT_WARRANTY_POSITIONS);
const settlementValues = Object.values(COMPLAINT_SETTLEMENT_TYPES);
const fixHeldValues = Object.values(COMPLAINT_FIX_HELD_RESULTS);
const urgencyValues = Object.values(URGENCY_LEVELS);
const waitingReasonValues = Object.values(COMPLAINT_WAITING_REASONS);
const notRealReasonValues = Object.values(COMPLAINT_NOT_REAL_REASONS);
const reopenReasonValues = Object.values(COMPLAINT_REOPEN_REASONS);
const linkTypeValues = Object.values(COMPLAINT_LINK_TYPES);
const listStatusValues = [...Object.values(COMPLAINT_LIST_STATUS), 'PROCESSING', 'FINISH', 'NEED_ACTION', 'ONHOLD'];
const problemTypeValues = Object.values(PROBLEM_TYPES);

const optionalMediaFields = {
  attachments: Joi.array().items(Joi.string()).optional(),
  photos: Joi.array().items(Joi.string()).optional(),
};

const evidenceItem = Joi.object({
  type: Joi.string()
    .valid(...attachmentTypeValues)
    .required(),
  date: Joi.date().iso().allow(null).optional(),
  itemId: Joi.string().custom(objectId).allow(null).optional(),
  quantity: Joi.number().min(0).allow(null).optional(),
  invoiceId: Joi.string().custom(objectId).allow(null).optional(),
  billId: Joi.string().custom(objectId).allow(null).optional(),
  batchNumber: Joi.string().trim().allow('', null).optional(),
  amount: Joi.number().allow(null).optional(),
  salesPersonId: Joi.string().custom(objectId).allow(null).optional(),
  fileUrl: Joi.string().trim().allow('', null).optional(),
  fileName: Joi.string().trim().allow('', null).optional(),
  value: Joi.string().trim().allow('', null).optional(),
});

const companyQuery = Joi.object().keys({
  companyId: Joi.string().required().custom(objectId),
});

const createComplaint = {
  query: companyQuery,
  body: Joi.object()
    .keys({
      formType: Joi.string()
        .valid(...formTypeValues)
        .required(),
      problemListId: Joi.string().required().custom(objectId),
      title: Joi.string().trim().max(300).required(),
      notes: Joi.string().trim().allow('').optional(),
      raisedBy: Joi.string().custom(objectId).required(),
      fromDepartment: Joi.string()
        .valid(...departmentValues)
        .optional(),
      againstDepartment: Joi.string()
        .valid(...departmentValues)
        .optional(),
      againstPersonId: Joi.string().custom(objectId).optional(),
      customerId: Joi.string().custom(objectId).optional(),
      contactChannel: Joi.string()
        .valid(...channelValues)
        .optional(),
      urgency: Joi.string()
        .valid(...urgencyValues)
        .optional(),
      evidence: Joi.array().items(evidenceItem).optional(),
      attachments: Joi.array().items(Joi.string().uri()).optional(),
      photos: Joi.array().items(Joi.string().uri()).optional(),
    })
    .required(),
};

const getComplaints = {
  query: companyQuery.keys({
    problemType: Joi.string()
      .valid(...problemTypeValues)
      .optional(),
    status: Joi.string()
      .valid(...listStatusValues)
      .optional(),
    assignedTo: Joi.string().custom(objectId).optional(),
    customerId: Joi.string().custom(objectId).optional(),
    search: Joi.string().trim().allow('').optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).optional(),
    page: Joi.number().integer().min(1).optional(),
    pagination: Joi.boolean().optional(),
  }),
};

const getComplaintsDropdown = {
  query: companyQuery.keys({
    search: Joi.string().trim().allow('').optional(),
    customerId: Joi.string().custom(objectId).optional(),
    excludeComplaintId: Joi.string().custom(objectId).optional(),
    problemType: Joi.string()
      .valid(...problemTypeValues)
      .optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).optional(),
    page: Joi.number().integer().min(1).optional(),
    pagination: Joi.boolean().optional(),
  }),
};

const complaintIdParams = {
  params: Joi.object().keys({
    complaintId: Joi.string().required().custom(objectId),
  }),
  query: companyQuery,
};

const updateComplaint = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      title: Joi.string().trim().max(300).optional(),
      notes: Joi.string().trim().allow('').optional(),
      raisedBy: Joi.string().custom(objectId).optional(),
      urgency: Joi.string()
        .valid(...urgencyValues)
        .optional(),
      evidence: Joi.array().items(evidenceItem).optional(),
      attachments: Joi.array().items(Joi.string()).optional(),
      photos: Joi.array().items(Joi.string()).optional(),
    })
    .min(1),
};

const assignStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      department: Joi.string()
        .valid(...departmentValues)
        .required(),
      personId: Joi.string().required().custom(objectId),
      reason: Joi.string().trim().required(),
    })
    .required(),
};

const replyStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      channel: Joi.string()
        .valid(...channelValues)
        .required(),
      message: Joi.string().trim().required(),
      proofAttachments: Joi.array().items(Joi.string()).optional(),
    })
    .required(),
};

const startProgressStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      whatHappened: Joi.string().trim().required(),
    })
    .required(),
};

const warrantyStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      warrantyPosition: Joi.string()
        .valid(...warrantyValues)
        .required(),
      why: Joi.string().trim().required(),
    })
    .required(),
};

const rootCauseStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      whys: Joi.array().items(Joi.string().trim().allow('')).min(3).max(5).required(),
      realCause: Joi.string().trim().required(),
      immediateFix: Joi.string().trim().required(),
      preventiveAction: Joi.string().trim().required(),
      ensureByPersonId: Joi.string().custom(objectId).required(),
      ensureByDate: Joi.date().iso().required(),
    })
    .required(),
};

const stopGapStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      stopGapAction: Joi.string().trim().required(),
    })
    .required(),
};

const recordProgressStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      whatHappened: Joi.string().trim().required(),
    })
    .required(),
};

const settlementStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      settlementType: Joi.string()
        .valid(...settlementValues)
        .required(),
      pieces: Joi.number().integer().min(0).allow(null).optional(),
      costInRupees: Joi.number().min(0).required(),
      summary: Joi.string().trim().required(),
    })
    .required(),
};

const completeActionStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      whatHappened: Joi.string().trim().required(),
    })
    .required(),
};

const verifyStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      fixHeldResult: Joi.string()
        .valid(...fixHeldValues)
        .required(),
      howDoYouKnow: Joi.string().trim().required(),
    })
    .required(),
};

const closeStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      howItEnded: Joi.string().trim().required(),
      customerSatisfaction: Joi.number().integer().min(1).max(5).optional(),
    })
    .required(),
};

const skipStep = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      skipReason: Joi.string().trim().allow('', null).optional(),
    })
    .optional(),
};

const addTeamNote = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      text: Joi.string().trim().required(),
    })
    .required(),
};

const addTeamTask = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      title: Joi.string().trim().required(),
      assignedTo: Joi.string().custom(objectId).allow(null).optional(),
      dueDate: Joi.date().iso().allow(null).optional(),
    })
    .required(),
};

const updateTeamTask = {
  params: Joi.object().keys({
    complaintId: Joi.string().required().custom(objectId),
    taskId: Joi.string().required().custom(objectId),
  }),
  query: companyQuery,
  body: Joi.object()
    .keys({
      title: Joi.string().trim().optional(),
      isDone: Joi.boolean().optional(),
      assignedTo: Joi.string().custom(objectId).allow(null).optional(),
      dueDate: Joi.date().iso().allow(null).optional(),
    })
    .min(1),
};

const handToSomeoneElse = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      department: Joi.string()
        .valid(...departmentValues)
        .required(),
      personId: Joi.string().required().custom(objectId),
      reason: Joi.string().trim().required(),
      ...optionalMediaFields,
    })
    .required(),
};

const markWaiting = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      isWaiting: Joi.boolean().required(),
      waitingReason: Joi.string()
        .valid(...waitingReasonValues)
        .when('isWaiting', {
          is: true,
          then: Joi.required(),
          otherwise: Joi.optional().allow(null),
        }),
      why: Joi.string().trim().when('isWaiting', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.forbidden(),
      }),
      ...optionalMediaFields,
    })
    .required(),
};

const escalateComplaint = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      personId: Joi.string().required().custom(objectId),
      reason: Joi.string().trim().required(),
      ...optionalMediaFields,
    })
    .required(),
};

const linkComplaint = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      connectionType: Joi.string()
        .valid(...linkTypeValues)
        .required(),
      linkedComplaintId: Joi.string().required().custom(objectId),
      ...optionalMediaFields,
    })
    .required(),
};

const markNotReal = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      reason: Joi.string()
        .valid(...notRealReasonValues)
        .required(),
      note: Joi.string().trim().allow('', null).optional(),
      ...optionalMediaFields,
    })
    .required(),
};

const reopenComplaint = {
  ...complaintIdParams,
  body: Joi.object()
    .keys({
      reason: Joi.string()
        .valid(...reopenReasonValues)
        .required(),
      note: Joi.string().trim().allow('', null).optional(),
    })
    .required(),
};

module.exports = {
  createComplaint,
  getComplaints,
  getComplaintsDropdown,
  getComplaint: complaintIdParams,
  updateComplaint,
  deleteComplaint: complaintIdParams,
  assignStep,
  replyStep,
  startProgressStep,
  warrantyStep,
  rootCauseStep,
  stopGapStep,
  recordProgressStep,
  settlementStep,
  completeActionStep,
  verifyStep,
  closeStep,
  skipStep,
  addTeamNote,
  addTeamTask,
  updateTeamTask,
  handToSomeoneElse,
  markWaiting,
  escalateComplaint,
  linkComplaint,
  markNotReal,
  reopenComplaint,
};
