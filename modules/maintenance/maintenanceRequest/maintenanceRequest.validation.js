const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const {
  MAINTENANCE_REQUEST_TYPE,
  MAINTENANCE_REQUEST_PRIORITY,
  MAINTENANCE_FAULT_CATEGORY,
  MAINTENANCE_REQUEST_STATUS,
  MAINTENANCE_ASSIGNMENT_MODE,
} = require('@smit9313/abss-models-core/src/utils/enum');

const ASSIGNMENT_MODES = Object.values(MAINTENANCE_ASSIGNMENT_MODE);
const REQUEST_TYPES = Object.values(MAINTENANCE_REQUEST_TYPE);
const PRIORITIES = Object.values(MAINTENANCE_REQUEST_PRIORITY);
const FAULT_CATEGORIES = Object.values(MAINTENANCE_FAULT_CATEGORY);

const createMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  body: Joi.object().keys({
    branchId: Joi.string().required().custom(objectId).label('Branch ID'),
    type: Joi.string()
      .valid(...REQUEST_TYPES)
      .required()
      .label('Request type'),
    priority: Joi.string()
      .valid(...PRIORITIES)
      .required()
      .label('Priority'),
    machineId: Joi.string().custom(objectId).required().label('Machine'),
    slaHours: Joi.number().min(0).label('SLA hours'),
    problemDescription: Joi.string().trim().required().label('Problem description'),
    isMachineStopped: Joi.boolean().label('Machine stopped'),
  }),
};

const MR_STATUSES = Object.values(MAINTENANCE_REQUEST_STATUS);

const getAllMaintenanceRequests = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
    branchId: Joi.string().custom(objectId).label('Branch ID'),
    sortBy: Joi.string(),
    limit: Joi.number().integer().min(1),
    page: Joi.number().integer().min(1),
    pagination: Joi.boolean(),
    search: Joi.string().trim().allow(''),
    status: Joi.string()
      .valid(...MR_STATUSES)
      .label('Status'),
    type: Joi.string()
      .valid(...REQUEST_TYPES)
      .label('Request type'),
    priority: Joi.string()
      .valid(...PRIORITIES)
      .label('Priority'),
    machineId: Joi.string().custom(objectId).label('Machine'),
    raisedBy: Joi.string().custom(objectId).label('Raised by'),
    isMachineStopped: Joi.boolean().label('Machine stopped'),
    fromDate: Joi.date().label('From date'),
    toDate: Joi.date().min(Joi.ref('fromDate')).label('To date').messages({
      'date.min': 'To date cannot be earlier than from date',
    }),
  }),
};

const getMaintenanceRequestById = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
};

const approveMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
  body: Joi.object().keys({
    remark: Joi.string().trim().allow('', null).label('Remark'),
  }),
};

const rejectMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
  body: Joi.object().keys({
    rejectReason: Joi.string().trim().required().label('Reject reason'),
  }),
};

const assignMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
  body: Joi.object().keys({
    assigneeId: Joi.string().custom(objectId).required().label('Assignee'),
    mode: Joi.string()
      .trim()
      .lowercase()
      .valid(...ASSIGNMENT_MODES)
      .default(MAINTENANCE_ASSIGNMENT_MODE.INTERNAL)
      .label('Mode'),
    targetAt: Joi.date().required().label('Target date'),
    estimatedHours: Joi.number().min(0).label('Estimated hours'),
  }),
};

const startWorkMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
};

const completeMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
  body: Joi.object().keys({
    workDone: Joi.string().trim().required().label('Work done'),
    faultCategory: Joi.string()
      .valid(...FAULT_CATEGORIES)
      .label('Fault category'),
    subCause: Joi.string().trim().allow('', null).label('Sub cause'),
    preventiveAction: Joi.string().trim().allow('', null).label('Preventive action'),
    laborHours: Joi.number().min(0).label('Labour hours'),
    vendorCost: Joi.number().min(0).label('Vendor cost'),
  }),
};

const closeMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
  body: Joi.object().keys({
    closeRemark: Joi.string().trim().allow('', null).label('Close remark'),
    isFirstTimeFix: Joi.boolean().label('First-time fix'),
  }),
};

const requestPartMaintenanceRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required().label('Maintenance request ID'),
  }),
  body: Joi.object().keys({
    sparePartId: Joi.string().custom(objectId).required().label('Spare part'),
    requestedQty: Joi.number().greater(0).required().label('Required quantity'),
  }),
};

const getMaintenanceRequestDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
    search: Joi.string().trim().allow(''),
    status: Joi.string()
      .valid(...MR_STATUSES)
      .label('Status'),
    type: Joi.string()
      .valid(...REQUEST_TYPES)
      .label('Request type'),
    priority: Joi.string()
      .valid(...PRIORITIES)
      .label('Priority'),
    machineId: Joi.string().custom(objectId).label('Machine'),
  }),
};

module.exports = {
  getMaintenanceRequestDropdown,
  createMaintenanceRequest,
  getAllMaintenanceRequests,
  getMaintenanceRequestById,
  approveMaintenanceRequest,
  rejectMaintenanceRequest,
  assignMaintenanceRequest,
  startWorkMaintenanceRequest,
  completeMaintenanceRequest,
  closeMaintenanceRequest,
  requestPartMaintenanceRequest,
};
