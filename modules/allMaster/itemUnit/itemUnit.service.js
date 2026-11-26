const httpStatus = require('http-status');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { createSearchRegex, escapeRegex } = require('../../../utils/regexUtils');
const { ITEM_UNIT_MESSAGES } = require('../../../utils/messages');
const { findItemUnitUsage } = require('../../../services/itemUnitUsage.service');

const nameMatcher = name => new RegExp(`^${escapeRegex(name.trim())}$`, 'i');

const findItemUnitOrThrow = async (itemUnitId, companyId) => {
  const { ItemUnit } = getBooksCrmModels();
  const itemUnit = await ItemUnit.findOne({ _id: itemUnitId, companyId });
  if (!itemUnit) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_UNIT_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return itemUnit;
};

const assertNameAvailable = async (name, companyId, excludeId) => {
  const { ItemUnit } = getBooksCrmModels();
  const existing = await ItemUnit.findOne({
    companyId,
    name: nameMatcher(name),
    ...(excludeId && { _id: { $ne: excludeId } }),
  }).lean();

  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, ITEM_UNIT_MESSAGES.DUPLICATE_NAME);
  }
};

const createItemUnit = async (itemUnitBody, userId) => {
  const { ItemUnit } = getBooksCrmModels();

  await assertNameAvailable(itemUnitBody.name, itemUnitBody.companyId);

  return ItemUnit.create({
    ...itemUnitBody,
    name: itemUnitBody.name.trim(),
    isSystemGenerated: false,
    addedBy: userId,
  });
};

const getItemUnits = async (filter, options) => {
  const { ItemUnit } = getBooksCrmModels();

  const query = { companyId: filter.companyId };
  if (filter.isActive !== undefined) query.isActive = filter.isActive;
  if (filter.search) query.name = createSearchRegex(filter.search);

  return ItemUnit.paginate(query, { sortBy: 'name:asc', ...options });
};

const getItemUnitsDropdown = async companyId => {
  const { ItemUnit } = getBooksCrmModels();
  return ItemUnit.find({ companyId, isActive: true }, { _id: 1, name: 1, isSystemGenerated: 1 }).sort({ name: 1 }).lean();
};

const getItemUnitById = async (itemUnitId, companyId) => {
  const itemUnit = await findItemUnitOrThrow(itemUnitId, companyId);
  return itemUnit;
};

const updateItemUnit = async (itemUnitId, updateBody, userId) => {
  const itemUnit = await findItemUnitOrThrow(itemUnitId, updateBody.companyId);

  if (updateBody.name && updateBody.name.trim().toLowerCase() !== itemUnit.name.toLowerCase()) {
    await assertNameAvailable(updateBody.name, itemUnit.companyId, itemUnitId);
    // Items and documents snapshot the unit name, so renaming a unit already in use would leave
    // those copies stale. Block the rename while it is referenced.
    const usedIn = await findItemUnitUsage(itemUnit, itemUnit.companyId);
    if (usedIn.length) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${ITEM_UNIT_MESSAGES.IN_USE}: ${usedIn.join(', ')}`);
    }
  }

  itemUnit.name = updateBody.name.trim();
  itemUnit.updatedBy = userId;
  await itemUnit.save();
  return itemUnit;
};

const updateItemUnitStatus = async (itemUnitId, isActive, companyId, userId) => {
  const itemUnit = await findItemUnitOrThrow(itemUnitId, companyId);

  if (itemUnit.isSystemGenerated && !isActive) {
    throw new ApiError(httpStatus.BAD_REQUEST, ITEM_UNIT_MESSAGES.SYSTEM_GENERATED_CANNOT_DEACTIVATE);
  }

  itemUnit.isActive = isActive;
  itemUnit.updatedBy = userId;
  await itemUnit.save();
  return itemUnit;
};

const deleteItemUnit = async (itemUnitId, companyId) => {
  const { ItemUnit } = getBooksCrmModels();
  const itemUnit = await findItemUnitOrThrow(itemUnitId, companyId);

  if (itemUnit.isSystemGenerated) {
    throw new ApiError(httpStatus.BAD_REQUEST, ITEM_UNIT_MESSAGES.SYSTEM_GENERATED_CANNOT_DELETE);
  }

  const usedIn = await findItemUnitUsage(itemUnit, companyId);
  if (usedIn.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${ITEM_UNIT_MESSAGES.IN_USE}: ${usedIn.join(', ')}`);
  }

  await ItemUnit.deleteOne({ _id: itemUnit._id });
};

const itemUnitUsage = async (itemUnitIds, companyId) => {
  const { Item, ItemBatch, SalesOrder, Quote, ItemUnit } = getBooksCrmModels();

  const itemUnits = await ItemUnit.find({ _id: { $in: itemUnitIds }, companyId });
  if (itemUnits.length !== itemUnitIds.length) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_UNIT_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const {
    DeliveryChallan,
    Invoice,
    CreditNote,
    RecurringInvoice,
    Bill,
    DebitNote,
    GrpoOrder,
    PurchaseOrder,
    RecurringBills,
    CustomerOrder,
    InventoryAdjustment,
    InventoryTransferRequest,
    ProductionOrder,
  } = getBooksModels();

  const unitId = itemUnits.map(unit => unit._id);

  const directUsageChecks = [
    {
      name: 'itembatches',
      model: ItemBatch,
      filter: { itemUnitId: { $in: unitId } },
    },
    {
      name: 'salesorders',
      model: SalesOrder,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'quotes',
      model: Quote,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'deliverychallans',
      model: DeliveryChallan,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'invoices',
      model: Invoice,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'creditnotes',
      model: CreditNote,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'recurringinvoices',
      model: RecurringInvoice,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'bills',
      model: Bill,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'debitnotes',
      model: DebitNote,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'grpoorders',
      model: GrpoOrder,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'purchaseorders',
      model: PurchaseOrder,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'recurringbills',
      model: RecurringBills,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
    {
      name: 'customerorders',
      model: CustomerOrder,
      filter: { 'items.itemUnitId': { $in: unitId } },
    },
  ];

  // Check direct itemUnitId references.
  for (const target of directUsageChecks) {
    const exists = await target.model.exists({
      companyId,
      ...target.filter,
    });

    if (exists) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${ITEM_UNIT_MESSAGES.IN_USE}`);
    }
  }

  // Find items whose main unit is the unit being checked.
  const matchingItems = await Item.find({
    companyId,
    itemUnitId: { $in: unitId },
  })
    .select('_id')
    .lean();

  const itemIds = matchingItems.map(item => item._id);

  // No matching items means there is no indirect usage through item references.
  if (!itemIds.length) {
    return {
      isInUse: false,
      usedIn: null,
    };
  }

  const itemIdFilter = { $in: itemIds };

  // Check item references inside nested structures.
  const indirectUsageChecks = [
    {
      name: 'items.productionData.bomBased',
      model: Item,
      filter: {
        'productionData.bomBased.item': itemIdFilter,
      },
    },
    {
      name: 'items.productionData.productionScrapOutInventory',
      model: Item,
      filter: {
        'productionData.productionScrapOutInventory.scrapItemName': itemIdFilter,
      },
    },
    {
      name: 'inventoryadjustments',
      model: InventoryAdjustment,
      filter: {
        'items.itemId': itemIdFilter,
      },
    },
    {
      name: 'inventorytransferrequests',
      model: InventoryTransferRequest,
      filter: {
        $or: [{ itemId: itemIdFilter }, { 'rawMaterials.rawMaterialId': itemIdFilter }],
      },
    },
    {
      name: 'productionorders',
      model: ProductionOrder,
      filter: {
        $or: [
          { itemId: itemIdFilter },
          { 'rawMaterials.rawMaterialId': itemIdFilter },
          { 'scrapOut.item': itemIdFilter },
          { 'submissionHistory.rawMaterialsConsumed.rawMaterialId': itemIdFilter },
          { 'submissionHistory.scrapOut.item': itemIdFilter },
          { 'inventoryImpactLog.item': itemIdFilter },
          {
            'processBased.processes.processRawMaterialInput.item': itemIdFilter,
          },
          {
            'processBased.processes.scrapOutProcess.item': itemIdFilter,
          },
          {
            'processBased.processes.submissionHistory.processRawMaterialInput.item': itemIdFilter,
          },
          {
            'processBased.processes.submissionHistory.scrapOutProcess.item': itemIdFilter,
          },
        ],
      },
    },
  ];

  for (const target of indirectUsageChecks) {
    const exists = await target.model.exists({
      companyId,
      ...target.filter,
    });

    if (exists) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${ITEM_UNIT_MESSAGES.IN_USE}`);
    }
  }

  return {
    isInUse: false,
    usedIn: null,
  };
};

module.exports = {
  createItemUnit,
  getItemUnits,
  getItemUnitsDropdown,
  getItemUnitById,
  updateItemUnit,
  updateItemUnitStatus,
  deleteItemUnit,
  itemUnitUsage,
};
