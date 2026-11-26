const httpStatus = require('http-status');
const { getBooksCrmModels, getCommonModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { warehousesInUse } = require('../../../services/locationDeleteGuard.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const CODE_GENERATION_MAX_RETRIES = 3;
const { WAREHOUSE_MESSAGES } = require('../../../utils/messages');
const {
  INVENTORY_TRANSFER_REQUEST,
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
 * Create a new Warehouse
 * @param {Object} warehouseBody
 * @param {ObjectId} userId
 * @returns {Promise<Warehouse>}
 */
const createNewWarehouse = async (warehouseBody, userId) => {
  const { Warehouse, Branch } = getBooksCrmModels();

  const existingWarehouse = await Warehouse.findOne({
    name: { $regex: new RegExp(`^${warehouseBody.name}$`, 'i') }, // Case-insensitive regex
    branchId: warehouseBody.branchId,
    companyId: warehouseBody.companyId,
  });

  if (existingWarehouse) {
    throw new ApiError(httpStatus.CONFLICT, 'A warehouse with this name already exists in the same branch');
  }

  const branch = await Branch.findOne({ _id: warehouseBody.branchId, companyId: warehouseBody.companyId }, { branchCode: 1 });
  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Branch not found');
  }

  for (let attempt = 0; attempt < CODE_GENERATION_MAX_RETRIES; attempt++) {
    const nextWarehouseNumber = await getNextWarehouseNumber(
      warehouseBody.companyId,
      warehouseBody.divisionId,
      warehouseBody.branchId,
    );
    const newWarehouseId = `${branch.branchCode}-${nextWarehouseNumber}`;

    const warehouseData = {
      ...warehouseBody,
      warehouseId: newWarehouseId,
      addedBy: userId,
      updatedBy: userId,
    };

    try {
      return await Warehouse.create(warehouseData);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  throw new ApiError(httpStatus.CONFLICT, 'A warehouse with this code already exists. Please try again.');
};

/**
 * Get all warehouses
 * @param {ObjectId} companyId
 * @returns {Promise<Array<Object>>}
 */

const getNextWarehouseNumber = async (companyId, divisionId, branchId) => {
  const { Warehouse } = getBooksCrmModels();
  try {
    const warehouses = await Warehouse.find({ companyId, divisionId, branchId }, { warehouseId: 1 }).lean();
    let maxNumber = 0;
    for (const warehouse of warehouses) {
      const matched = warehouse.warehouseId?.match(/-WH-(\d+)$/);
      if (matched) maxNumber = Math.max(maxNumber, parseInt(matched[1], 10));
    }

    return `WH-${maxNumber + 1}`;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't generate a new Warehouse number. Please try again.");
  }
};

const getAllWarehouses = async (query, filter, options) => {
  const { Warehouse } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();

  if (filter.isSplit === undefined) {
    const getBranchConfig = await CompanySettings.findOne({ companyId: filter.companyId }).select('branchConfig');
    const { warehouseId } = getBranchConfig?.branchConfig || {};
    if (warehouseId) {
      filter._id = { $ne: warehouseId.toString() };
    }
  }
  delete filter?.isSplit;

  if (filter.status === 'ACTIVE') filter.isActive = true;
  else if (filter.status === 'INACTIVE') filter.isActive = false;
  delete filter.status;

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());

    filter.$or = [{ name: searchRegex }];
  }

  options.populate = `divisionId:name,branchId:name`;
  const warehouse = await Warehouse.paginate(filter, options);
  warehouse.results = warehouse.results.map(item => ({
    _id: item._id,
    warehouseId: item.warehouseId || '',
    name: item.name || '',
    branchName: item.branchId?.name || '',
    divisionName: item.divisionId?.name || '',
    isActive: item.isActive,
  }));
  return warehouse;
};

/**
 * Update an existing Warehouse
 * @param {ObjectId} warehouseId
 * @param {Object} warehouseBody
 * @param {ObjectId} userId
 * @returns {Promise<Warehouse>}
 */
const updateWarehouse = async (warehouseId, warehouseBody, userId) => {
  const { Warehouse } = getBooksCrmModels();
  const warehouse = await Warehouse.findById(warehouseId);
  if (!warehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, WAREHOUSE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (warehouseBody.name) {
    const existingWarehouse = await Warehouse.findOne({
      _id: { $ne: warehouseId },
      name: { $regex: new RegExp(`^${warehouseBody.name}$`, 'i') },
      branchId: warehouse.branchId,
      companyId: warehouse.companyId,
    });

    if (existingWarehouse) {
      throw new ApiError(httpStatus.CONFLICT, 'A warehouse with this name already exists in the same branch');
    }
  }
  const updatedWarehouse = await Warehouse.findByIdAndUpdate(
    warehouseId,
    { ...warehouseBody, updatedBy: userId },
    {
      new: true,
    },
  );
  return updatedWarehouse;
};

/**
 * Delete a warehouse by ID
 * @param {ObjectId} warehouseId
 * @returns {Promise<Warehouse>}
 */
const deleteWarehouse = async (warehouseId, companyId) => {
  const { Warehouse } = getBooksCrmModels();
  const warehouse = await Warehouse.findOne({ _id: warehouseId, companyId });
  if (!warehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, WAREHOUSE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (await warehousesInUse([warehouse._id], companyId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, WAREHOUSE_MESSAGES.DELETE_IN_USE);
  }
  await Warehouse.deleteOne({ _id: warehouse._id, companyId });
  return warehouse;
};

/**
 * Get warehouses dropdown
 * @param {ObjectId} companyId
 * @returns {Promise<Array<Object>>}
 */
const getWarehousesDropdown = async (filter, options) => {
  const { CompanySettings } = getCommonModels();

  const { companyId } = filter;
  const warehouseQuery = { companyId, isActive: true };

  if (filter.branchId) {
    warehouseQuery.branchId = filter.branchId;
  }

  // Collect warehouse ids that should not appear in the generic document dropdown.
  const excludedWarehouseIds = [];

  const needsBranchConfig = filter.isSplit === undefined;
  const needsRejectionConfig = !filter.includeRejectionWarehouses;

  if (needsBranchConfig || needsRejectionConfig) {
    const settings = await CompanySettings.findOne({ companyId }).select('branchConfig rejectionWarehouseConfig');

    if (needsBranchConfig) {
      const { warehouseId } = settings?.branchConfig || {};
      if (warehouseId) {
        excludedWarehouseIds.push(warehouseId.toString());
      }
    }

    // Reuse/return/scrap warehouses are reserved for rejection recovery. Hide them everywhere
    // except the rejection-config settings screen (which opts in via includeRejectionWarehouses).
    if (needsRejectionConfig) {
      const cfg = settings?.rejectionWarehouseConfig || {};
      [cfg.reuseWarehouseId, cfg.returnWarehouseId, cfg.scrapWarehouseId]
        .filter(Boolean)
        .forEach(id => excludedWarehouseIds.push(id.toString()));
    }
  }

  if (excludedWarehouseIds.length > 0) {
    warehouseQuery._id = { $nin: [...new Set(excludedWarehouseIds)] };
  }

  const { Warehouse } = getBooksCrmModels();
  options.populate = `divisionId:name divisionCode,branchId:name branchCode`;
  options.select = `warehouseId name isActive`;
  options.pagination = false;
  options.sortBy = options.sortBy || 'createdAt:asc';
  const warehouse = await Warehouse.paginate(warehouseQuery, options);
  return warehouse;
};

const warehouseById = async (warehouseId, companyId) => {
  const { Warehouse } = getBooksCrmModels();
  const warehouse = await Warehouse.findOne({ _id: warehouseId, companyId })
    .populate('divisionId', 'name')
    .populate('branchId', 'name');
  if (!warehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, WAREHOUSE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return warehouse;
};

/**
 * Helper function to get branchId and divisionId for a given warehouse
 * @param {string} warehouseId - The warehouse ID
 * @returns {Promise<Object>} Object containing branchId and divisionId
 */
const getWarehouseDetails = async (warehouseId, session = null) => {
  const { Warehouse } = getBooksCrmModels();

  const warehouse = await Warehouse.findById(warehouseId).select('branchId divisionId').session(session);

  if (!warehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, WAREHOUSE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return {
    warehouseId: warehouse?._id,
    branchId: warehouse.branchId,
    divisionId: warehouse.divisionId,
  };
};

const updateStatus = async (warehouseId, isActive, companyId) => {
  const { Warehouse, Quote, SalesOrder } = getBooksCrmModels();
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
    Quote.countDocuments({ status: { $nin: quote_restictedStatus }, companyId, warehouseId }),
    SalesOrder.countDocuments({ status: { $nin: salesOrder_restictedStatus }, companyId, warehouseId }),
    DeliveryChallan.countDocuments({ status: { $nin: deliveryChallan_restictedStatus }, companyId, warehouseId }),
    Invoice.countDocuments({ status: { $nin: invoice_restictedStatus }, companyId, warehouseId }),
    PurchaseOrder.countDocuments({ status: { $nin: purchaseOrder_restictedStatus }, companyId, warehouseId }),
    GrpoOrder.countDocuments({ status: { $nin: grpoOrder__restictedStatus }, companyId, warehouseId }),
    Bill.countDocuments({ status: { $nin: bill_restictedStatus }, companyId, warehouseId }),
    RecurringInvoice.countDocuments({
      warehouseId,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringExpense.countDocuments({
      warehouseId,
      companyId,
      status: 'ACTIVE',
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringBills.countDocuments({
      warehouseId,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    ProductionOrder.countDocuments({ warehouseId, companyId, status: { $nin: [PRODUCTION_ORDER_STATUS.COMPLETED] } }),
    InventoryTransferRequest.countDocuments({
      companyId,
      status: INVENTORY_TRANSFER_REQUEST.PENDING,
      $or: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }],
    }),

    InventoryAdjustment.countDocuments({ warehouseId, companyId, status: 'DRAFT' }),
    DebitNote.countDocuments({ status: { $nin: debitNote_restictedStatus }, companyId, warehouseId }),
    CreditNote.countDocuments({ status: { $nin: creditNote_restictedStatus }, companyId, warehouseId }),
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
    throw new ApiError(httpStatus.BAD_REQUEST, 'Warehouse cannot be deactivated because it is used in active documents');
  }

  const warehouse = await Warehouse.findOneAndUpdate({ _id: warehouseId, companyId }, { isActive });

  if (!warehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, 'WareHouse not found');
  }

  return warehouse;
};

module.exports = {
  createNewWarehouse,
  getAllWarehouses,
  updateWarehouse,
  deleteWarehouse,
  getWarehousesDropdown,
  warehouseById,
  getWarehouseDetails,
  updateStatus,
};
