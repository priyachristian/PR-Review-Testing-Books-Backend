const httpStatus = require('http-status');
const { getBooksCrmModels, getCommonModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { divisionsInUse } = require('../../../services/locationDeleteGuard.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const CODE_GENERATION_MAX_RETRIES = 3;
const {
  PRODUCTION_ORDER_STATUS,
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  INVOICE_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  BILL_STATUSES,
  CREDIT_NOTE_STATUS,
  DEBIT_NOTE_STATUS,
} = require('../../../utils/enum');
const { DIVISION_MESSAGES } = require('../../../utils/messages');

/**
 * Create a new division
 * @param {Object} divisionBody
 * @param {ObjectId} userId
 * @returns {Promise<Division>}
 */
const createNewDivision = async (divisionBody, userId) => {
  const { Division } = getBooksCrmModels();

  const existingDivision = await Division.findOne({
    name: { $regex: new RegExp(`^${divisionBody.name}$`, 'i') },
    companyId: divisionBody.companyId,
  });

  if (existingDivision) {
    throw new ApiError(httpStatus.CONFLICT, 'A Division with this name already exists in the same Company');
  }

  for (let attempt = 0; attempt < CODE_GENERATION_MAX_RETRIES; attempt++) {
    const divisionCode = await getNextDivisionNumber(divisionBody.companyId);

    const divisionData = {
      ...divisionBody,
      divisionCode,
      addedBy: userId,
      updatedBy: userId,
    };

    try {
      return await Division.create(divisionData);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  throw new ApiError(httpStatus.CONFLICT, 'A Division with this code already exists. Please try again.');
};

const getNextDivisionNumber = async companyId => {
  const { Division } = getBooksCrmModels();
  try {
    const divisions = await Division.find({ companyId }, { divisionCode: 1 }).lean();
    let maxNumber = 0;
    for (const division of divisions) {
      const matched = division.divisionCode?.match(/DIV-(\d+)$/);
      if (matched) maxNumber = Math.max(maxNumber, parseInt(matched[1], 10));
    }

    return `DIV-${maxNumber + 1}`;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error calculating the next Division number');
  }
};

/**
 * Get all divisions for a company
 * @param {ObjectId} companyId
 * @returns {Promise<Array<Division>>}
 */
const getDivisionsByCompanyId = async (query, filter, options) => {
  const { Division } = getBooksCrmModels();

  if (filter.status === 'ACTIVE') filter.isActive = true;
  else if (filter.status === 'INACTIVE') filter.isActive = false;
  delete filter.status;

  if (query.search) {
    const searchRegex = createSearchRegex(query.search);

    filter.$or = [
      { divisionCode: searchRegex },
      { name: searchRegex },
      { contactEmail: searchRegex },
      { contactPhone: searchRegex },
    ];
  }

  const divisions = await Division.paginate(filter, options);
  if (!divisions) {
    throw new ApiError(httpStatus.NOT_FOUND, DIVISION_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return divisions;
};

/**
 * Update division by id
 * @param {ObjectId} divisionId
 * @param {Object} updateBody
 * @param {ObjectId} userId
 * @returns {Promise<Division>}
 */
const updateDivisionById = async (divisionId, updateBody, userId) => {
  const { Division } = getBooksCrmModels();
  const division = await Division.findOne({ _id: divisionId, companyId: updateBody?.companyId });
  if (!division) {
    throw new ApiError(httpStatus.NOT_FOUND, DIVISION_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (updateBody.name) {
    const existingDivision = await Division.findOne({
      _id: { $ne: divisionId },
      name: { $regex: new RegExp(`^${updateBody.name}$`, 'i') },
      companyId: division.companyId,
    });

    if (existingDivision) {
      throw new ApiError(httpStatus.CONFLICT, 'A Division with this name already exists in the same Company');
    }
  }

  // Proceed with updating the division
  Object.assign(division, updateBody);

  // Track who updated the division and when
  division.updatedBy = userId;

  await division.save();
  return division;
};

/**
 * Delete division by id
 * @param {ObjectId} divisionId
 * @returns {Promise<Division>}
 */
const deleteDivisionById = async (divisionId, companyId) => {
  const { Division, Branch, Warehouse } = getBooksCrmModels();
  const division = await Division.findOne({ _id: divisionId, companyId });

  if (!division) {
    throw new ApiError(httpStatus.NOT_FOUND, DIVISION_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const [hasBranches, hasWarehouses] = await Promise.all([
    Branch.exists({ divisionId: division._id, companyId }),
    Warehouse.exists({ divisionId: division._id, companyId }),
  ]);
  if (hasBranches || hasWarehouses) {
    throw new ApiError(httpStatus.BAD_REQUEST, DIVISION_MESSAGES.HAS_CHILDREN);
  }

  if (await divisionsInUse([division._id], companyId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, DIVISION_MESSAGES.DELETE_IN_USE);
  }

  await Division.deleteOne({ _id: division._id, companyId });
  return division;
};

/**
 * Get division name by id
 * @param {ObjectId} divisionId
 * @returns {Promise<Division>}
 */
const getDivisionIdsAndNamesByCompanyId = async companyId => {
  const { Division } = getBooksCrmModels();
  const { Company } = getCommonModels();

  const divisionQuery = { companyId, isActive: true };

  const company = await Company.findById(companyId);
  const divisions = await Division.find(divisionQuery, { _id: 1, name: 1, divisionCode: 1, isActive: 1 });

  return { divisions: divisions || [], blockedApp: company?.blockedApp };
};

const getDivisonById = async (divisionId, companyId) => {
  const { Division } = getBooksCrmModels();

  const data = await Division.findOne({ _id: divisionId, companyId });
  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, DIVISION_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return data;
};

const updateStatus = async (divisionId, isActive, companyId) => {
  const { Division, Quote, SalesOrder } = getBooksCrmModels();
  const {
    DeliveryChallan,
    Invoice,
    PurchaseOrder,
    GrpoOrder,
    Bill,
    RecurringInvoice,
    RecurringBills,
    RecurringExpense,
    ProductionOrder,
    InventoryTransferRequest,
    InventoryAdjustment,
    DebitNote,
    CreditNote,
  } = getBooksModels();

  const quote_restictedStatus = [QUOTE_STATUS.COMPLETED, QUOTE_STATUS.CANCELLED];

  const salesOrder_restictedStatus = [SALES_ORDER_STATUS.CANCELLED, SALES_ORDER_STATUS.COMPLETED];

  const deliveryChallan_restictedStatus = [DELIVERY_CHALLAN_STATUS.CANCELLED, DELIVERY_CHALLAN_STATUS.DELIVERED];

  const invoice_restictedStatus = [INVOICE_STATUS.PAID, INVOICE_STATUS.CANCELLED];

  const purchaseOrder_restictedStatus = [PO_STATUSES.CONVERTED, PO_STATUSES.CANCELLED];

  const grpoOrder__restictedStatus = [GRPO_STATUSES.CONVERTED, GRPO_STATUSES.CANCELLED];

  const bill_restictedStatus = [BILL_STATUSES.PAID, BILL_STATUSES.CANCELLED];

  const creditNote_restictedStatus = [CREDIT_NOTE_STATUS.USED, CREDIT_NOTE_STATUS.CANCELLED, CREDIT_NOTE_STATUS.CLOSED];

  const debitNote_restictedStatus = [DEBIT_NOTE_STATUS.USED, DEBIT_NOTE_STATUS.CANCELLED, DEBIT_NOTE_STATUS.CLOSED];

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [
    quote,
    salesOrder,
    deliveryChallan,
    invoice,
    purchaseOrder,
    grpoOrder,
    bill,
    recurringInvoice,
    recurringExpense,
    recurringBill,
    productionOrder,
    inventoryTransferRequest,
    inventoryAdjustment,
    creditNote,
    debitNote,
  ] = await Promise.all([
    Quote.countDocuments({ status: { $nin: quote_restictedStatus }, companyId, divisionId }),
    SalesOrder.countDocuments({ status: { $nin: salesOrder_restictedStatus }, companyId, divisionId }),
    DeliveryChallan.countDocuments({ status: { $nin: deliveryChallan_restictedStatus }, companyId, divisionId }),
    Invoice.countDocuments({ status: { $nin: invoice_restictedStatus }, companyId, divisionId }),
    PurchaseOrder.countDocuments({ status: { $nin: purchaseOrder_restictedStatus }, companyId, divisionId }),
    GrpoOrder.countDocuments({ status: { $nin: grpoOrder__restictedStatus }, companyId, divisionId }),
    Bill.countDocuments({ status: { $nin: bill_restictedStatus }, companyId, divisionId }),
    RecurringInvoice.countDocuments({
      divisionId,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringExpense.countDocuments({
      divisionId,
      companyId,
      status: 'ACTIVE',
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringBills.countDocuments({
      divisionId,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    ProductionOrder.countDocuments({ divisionId, companyId, status: { $nin: [PRODUCTION_ORDER_STATUS.COMPLETED] } }),
    InventoryAdjustment.countDocuments({ divisionId, companyId, status: 'DRAFT' }),
    DebitNote.countDocuments({ status: { $nin: debitNote_restictedStatus }, companyId, divisionId }),
    CreditNote.countDocuments({ status: { $nin: creditNote_restictedStatus }, companyId, divisionId }),
  ]);

  if (
    !isActive &&
    (quote ||
      salesOrder ||
      deliveryChallan ||
      invoice ||
      purchaseOrder ||
      grpoOrder ||
      bill ||
      recurringInvoice ||
      recurringExpense ||
      recurringBill ||
      productionOrder ||
      inventoryTransferRequest ||
      inventoryAdjustment ||
      debitNote ||
      creditNote)
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Division cannot be deactivated because it is used in active documents');
  }

  const division = await Division.findOneAndUpdate({ _id: divisionId, companyId }, { isActive });

  if (!division) {
    throw new ApiError(httpStatus.NOT_FOUND, DIVISION_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return division;
};

module.exports = {
  createNewDivision,
  getDivisionsByCompanyId,
  updateDivisionById,
  deleteDivisionById,
  getDivisionIdsAndNamesByCompanyId,
  getDivisonById,
  updateStatus,
};
