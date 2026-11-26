const httpStatus = require('http-status');
const { getBooksCrmModels, getCommonModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { branchesInUse } = require('../../../services/locationDeleteGuard.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const CODE_GENERATION_MAX_RETRIES = 3;
const mongoose = require('mongoose');
const { BRANCH_MESSAGES } = require('../../../utils/messages');
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

/**
 * Create a new Branch
 * @param {Object} branchBody
 * @param {ObjectId} userId
 * @param {Object} file
 * @returns {Promise<Branch>}
 */
const createNewBranch = async (branchBody, userId) => {
  const { Branch, Division } = getBooksCrmModels();

  const existingBranch = await Branch.findOne({
    name: { $regex: new RegExp(`^${branchBody.name}$`, 'i') },
    divisionId: branchBody.divisionId,
  });

  if (existingBranch) {
    throw new ApiError(httpStatus.CONFLICT, 'A branch with this name already exists in the same division');
  }

  const division = await Division.findOne({ _id: branchBody.divisionId, companyId: branchBody.companyId }, { divisionCode: 1 });
  if (!division) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Division not found');
  }

  for (let attempt = 0; attempt < CODE_GENERATION_MAX_RETRIES; attempt++) {
    const nextBranchNumber = await getNextBranchNumber(branchBody.companyId, branchBody.divisionId);
    const branchCode = `${division.divisionCode}-${nextBranchNumber}`;

    const BranchData = {
      ...branchBody,
      branchCode,
      addedBy: userId,
      updatedBy: userId,
    };

    try {
      return await Branch.create(BranchData);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  throw new ApiError(httpStatus.CONFLICT, 'A branch with this code already exists. Please try again.');
};

const getNextBranchNumber = async (companyId, divisionId) => {
  const { Branch } = getBooksCrmModels();
  try {
    const branches = await Branch.find({ companyId, divisionId }, { branchCode: 1 }).lean();
    let maxNumber = 0;
    for (const branch of branches) {
      const matched = branch.branchCode?.match(/-BR-(\d+)$/);
      if (matched) maxNumber = Math.max(maxNumber, parseInt(matched[1], 10));
    }

    return `BR-${maxNumber + 1}`;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't generate a new Branch number. Please try again.");
  }
};

/**
 * Get all branches
 * @param {ObjectId} companyId
 * @returns {Promise<Array<Object>>}
 */
const getAllBranches = async (query, filter, options) => {
  const { Branch, Division } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();

  if (filter.isSplit == undefined) {
    const getBranchConfig = await CompanySettings.findOne({ companyId: query.companyId }).select('branchConfig');
    const { branchId } = getBranchConfig?.branchConfig || {};
    if (branchId) {
      filter._id = { $ne: branchId.toString() };
    }
  }
  delete filter.isSplit;

  if (filter?.status === 'ACTIVE') filter.isActive = true;
  else if (filter?.status === 'INACTIVE') filter.isActive = false;
  delete filter.status;

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());

    const matchingDivisions = await Division.find({ name: searchRegex }).select('_id');
    const divisionIds = matchingDivisions.map(div => div._id);

    filter.$or = [
      { branchCode: searchRegex },
      { name: searchRegex },
      { divisionId: { $in: divisionIds } },
      { 'branchManager.firstName': searchRegex },
      { 'branchManager.contactEmail': searchRegex },
      { 'branchManager.contactPhone': searchRegex },
    ];
  }
  options.populate = 'divisionId:name ';
  const branches = await Branch.paginate(filter, options);
  return branches;
};

/**
 * Update an existing Branch
 * @param {ObjectId} branchId - The ID of the branch to update
 * @param {Object} branchBody - The updated branch data
 * @param {Object} file
 * @param {ObjectId} userId - The ID of the user making the update
 * @returns {Promise<Branch>}
 */
const updateBranch = async (branchId, branchBody, userId) => {
  const { Branch } = getBooksCrmModels();
  const branch = await Branch.findOne({ _id: branchId, companyId: branchBody?.companyId });

  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Branch not found');
  }
  if (branchBody.name) {
    const existingBranch = await Branch.findOne({
      _id: { $ne: branchId },
      name: { $regex: new RegExp(`^${branchBody.name}$`, 'i') },
      divisionId: branch.divisionId,
      companyId: branch.companyId,
    });

    if (existingBranch) {
      throw new ApiError(httpStatus.CONFLICT, 'A branch with this name already exists in the same division');
    }
  }

  await Branch.findByIdAndUpdate(branchId, { ...branchBody, updatedBy: userId }, { new: true });
  return branch;
};

/**
 * Delete a branch by ID
 * @param {ObjectId} branchId
 * @returns {Promise<Branch>}
 */
const deleteBranch = async (branchId, companyId) => {
  const { Branch, Warehouse } = getBooksCrmModels();
  const branch = await Branch.findOne({ _id: branchId, companyId });
  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Branch not found');
  }

  const hasWarehouses = await Warehouse.exists({ branchId: branch._id, companyId });
  if (hasWarehouses) {
    throw new ApiError(httpStatus.BAD_REQUEST, BRANCH_MESSAGES.HAS_WAREHOUSES);
  }

  if (await branchesInUse([branch._id], companyId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, BRANCH_MESSAGES.DELETE_IN_USE);
  }

  await Branch.deleteOne({ _id: branch._id, companyId });
  return branch;
};

/**
 * Get branches by divisionId
 * @param {ObjectId} divisionId
 * @returns {Promise<Array>}
 */
const getBranchIdsAndNamesByDivisionId = async (divisionId, companyId, isSplit) => {
  const { Branch } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();

  const branchQuery = { companyId, isActive: true };

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      branchQuery.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (isSplit == undefined) {
    const getBranchConfig = await CompanySettings.findOne({ companyId }).select('branchConfig');
    const { branchId } = getBranchConfig?.branchConfig || {};
    if (branchId) {
      branchQuery._id = { $ne: branchId.toString() };
    }
  }
  const branches = await Branch.find(branchQuery, { _id: 1, name: 1, branchCode: 1, isActive: 1, divisionId: 1 }).populate({
    path: 'divisionId',
    select: 'name divisionCode',
  });

  return branches || [];
};

const getBranchById = async (branchId, companyId) => {
  const { Branch } = getBooksCrmModels();
  const branch = await Branch.findOne({ _id: branchId, companyId }).populate({
    path: 'divisionId',
    select: 'name',
  });
  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, BRANCH_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return branch;
};

/**
 * Get all branches with division details
 * @param {ObjectId} companyId
 * @returns {Promise<Array<Object>>}
 */
const getAllBranchesWithDivision = async companyId => {
  const { Branch } = getBooksCrmModels();
  let branchFilter = { companyId, isActive: true };

  const branches = await Branch.find(branchFilter).select('name branchCode divisionId isActive').populate({
    path: 'divisionId',
    select: 'name divisionCode',
  });

  return branches;
};

const updateStatus = async (branchId, isActive, companyId) => {
  const { Branch, Quote, SalesOrder } = getBooksCrmModels();
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
    inventoryAdjustment,
    creditNote,
    debitNote,
  ] = await Promise.all([
    Quote.countDocuments({ status: { $nin: quote_restictedStatus }, companyId, branchId }),
    SalesOrder.countDocuments({ status: { $nin: salesOrder_restictedStatus }, companyId, branchId }),
    DeliveryChallan.countDocuments({ status: { $nin: deliveryChallan_restictedStatus }, companyId, branchId }),
    Invoice.countDocuments({ status: { $nin: invoice_restictedStatus }, companyId, branchId }),
    PurchaseOrder.countDocuments({ status: { $nin: purchaseOrder_restictedStatus }, companyId, branchId }),
    GrpoOrder.countDocuments({ status: { $nin: grpoOrder__restictedStatus }, companyId, branchId }),
    Bill.countDocuments({ status: { $nin: bill_restictedStatus }, companyId, branchId }),
    RecurringInvoice.countDocuments({
      branchId,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringExpense.countDocuments({
      branchId,
      companyId,
      status: 'ACTIVE',
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringBills.countDocuments({
      branchId,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    ProductionOrder.countDocuments({ branchId, companyId, status: { $nin: [PRODUCTION_ORDER_STATUS.COMPLETED] } }),
    InventoryAdjustment.countDocuments({ branchId, companyId, status: 'DRAFT' }),
    DebitNote.countDocuments({ status: { $nin: debitNote_restictedStatus }, companyId, branchId }),
    CreditNote.countDocuments({ status: { $nin: creditNote_restictedStatus }, companyId, branchId }),
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
      inventoryAdjustment ||
      debitNote ||
      creditNote)
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Branch cannot be deactivated because it is used in active documents');
  }

  const branch = await Branch.findOneAndUpdate({ _id: branchId, companyId }, { isActive });

  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Branch not found');
  }

  return branch;
};

module.exports = {
  createNewBranch,
  getAllBranches,
  updateBranch,
  deleteBranch,
  getBranchIdsAndNamesByDivisionId,
  getBranchById,
  getAllBranchesWithDivision,
  updateStatus,
};
