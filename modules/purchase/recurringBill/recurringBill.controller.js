const catchAsync = require('../../../utils/catchAsync');
const recurringBillService = require('./recurringBill.service');
const { successResponse } = require('../../../services/response.service');
const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const { RECURRING_BILL_MESSAGES } = require('../../../utils/messages');

const createRecurringBill = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const recurringBill = await recurringBillService.createRecurringBill({ ...req.body, companyId: req.query.companyId }, userId);
    return successResponse(res, recurringBill, RECURRING_BILL_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createRecurringBill',
    controller: 'recurringBill',
    failureMessage: RECURRING_BILL_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecurringBills = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'recurringBillId',
      'vendorId',
      'status',
      'companyId',
      'search',
      'startDate',
      'endDate',
      'recurringBillDate',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await recurringBillService.queryRecurringBills(filter, options);
    const { results, nextRecurringBillId, ...otherFields } = result;
    otherFields.nextRecurringBillId = nextRecurringBillId;
    return successResponse(res, results, RECURRING_BILL_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryRecurringBills',
    controller: 'recurringBill',
    failureMessage: RECURRING_BILL_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const getRecurringBillById = catchAsync(
  async (req, res) => {
    const recurringBill = await recurringBillService.getRecurringBillById(req.params.id, req.query.companyId);
    return successResponse(res, recurringBill, RECURRING_BILL_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getRecurringBillById',
    controller: 'recurringBill',
    failureMessage: RECURRING_BILL_MESSAGES.FETCH_NOT_FOUND,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRecurringBill = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const updatedBill = await recurringBillService.updateRecurringBill(
      req.params.id,
      { ...req.body, companyId: req.query.companyId },
      userId,
    );
    return successResponse(res, updatedBill, RECURRING_BILL_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRecurringBill',
    controller: 'recurringBill',
    failureMessage: RECURRING_BILL_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const deleteRecurringBill = catchAsync(
  async (req, res) => {
    const deleted = await recurringBillService.deleteRecurringBill(req.params.id, req.query.companyId);
    return successResponse(res, null, RECURRING_BILL_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteRecurringBill',
    controller: 'recurringBill',
    failureMessage: RECURRING_BILL_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const createBillFromRecurringDoc = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const bill = await recurringBillService.createBillFromRecurringDoc(req.params.id, userId, req.query.companyId);
    return successResponse(res, bill, RECURRING_BILL_MESSAGES.CREATE_BILL_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createBillFromRecurringDoc',
    controller: 'recurringBill',
    failureMessage: RECURRING_BILL_MESSAGES.CREATE_BILL_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

const updateRecurringBillStatus = catchAsync(
  async (req, res) => {
    const userId = req.user._id;
    const bill = await recurringBillService.updateRecurringBillStatus(
      req.params.id,
      req.body.status,
      userId,
      req.query?.companyId,
    );
    return successResponse(res, bill, RECURRING_BILL_MESSAGES.STATUS_UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateRecurringBillStatus',
    controller: 'recurringBill',
    failureMessage: RECURRING_BILL_MESSAGES.STATUS_UPDATE_FAILURE,
    failureStatus: httpStatus.INTERNAL_SERVER_ERROR,
  },
);

module.exports = {
  createRecurringBill,
  getRecurringBills,
  getRecurringBillById,
  updateRecurringBill,
  deleteRecurringBill,
  createBillFromRecurringDoc,
  updateRecurringBillStatus,
};
