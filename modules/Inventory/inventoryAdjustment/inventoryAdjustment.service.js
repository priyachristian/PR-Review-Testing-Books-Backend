const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { INVENTORY_ADJUSTMENT_MESSAGES } = require('../../../utils/messages');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { MODULE_NAMES } = require('../../../utils/enum');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
  resolveUnitConversion,
  roundQty,
} = require('../../../services/warehouseBatch.service');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { createSearchRegex } = require('../../../utils/regexUtils');

// A line states the item's stock as counted (current -> updated), and every line starts from the same current stock,
// so a repeated item would have its difference applied twice on approval.
const assertNoDuplicateItems = items => {
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item.itemId);
    if (seen.has(key)) {
      throw new ApiError(httpStatus.BAD_REQUEST, INVENTORY_ADJUSTMENT_MESSAGES.DUPLICATE_ITEM);
    }
    seen.add(key);
  }
};

/**
 * Create a new inventory adjustment (DRAFT status)
 * @param {Object} adjustmentBody
 * @param {ObjectId} userId
 * @returns {Promise<InventoryAdjustment>}
 */
const createInventoryAdjustment = async (adjustmentBody, userId) => {
  const { Item } = getBooksCrmModels();
  const { InventoryAdjustment } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { items, inventoryAdjustmentNumber } = adjustmentBody;
    const normalizedInventoryAdjustmentNumber = inventoryAdjustmentNumber?.trim();

    const generatedAdjustmentNumber = await generateUniqueId(
      InventoryAdjustment,
      adjustmentBody.companyId,
      MODULE_NAMES.INVENTORY_ADJUSTMENT,
      'inventoryAdjustmentNumber',
      'INA',
      session,
      normalizedInventoryAdjustmentNumber,
    );

    assertNoDuplicateItems(items);

    // Validate items and calculate adjustedStock from frontend values
    const validatedItems = [];
    for (const item of items) {
      const itemDoc = await Item.findById(item.itemId).session(session);
      if (!itemDoc) {
        throw new ApiError(httpStatus.NOT_FOUND, `Item ${item.itemId} not found`);
      }
      if (itemDoc?.itemCategory?.isService) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Service item ${itemDoc.itemName} cannot be adjusted in inventory`);
      }
      if (itemDoc?.trackInventory === false) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${itemDoc.itemName} is not inventory tracked and does not hold stock, so it cannot be adjusted`,
        );
      }

      // Block creating a new adjustment for an item that already has a pending (DRAFT) request in the same warehouse
      const pendingAdjustment = await InventoryAdjustment.findOne({
        companyId: adjustmentBody.companyId,
        warehouseId: adjustmentBody.warehouseId,
        status: 'DRAFT',
        'items.itemId': item.itemId,
      }).session(session);

      if (pendingAdjustment) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `An inventory adjustment request (${pendingAdjustment.inventoryAdjustmentNumber}) for item ${itemDoc.itemName} is already pending for this warehouse`,
        );
      }

      // Use currentStock and updatedStock from frontend directly
      // Calculate adjusted stock from frontend values
      // Throws if the selected unit is neither the item's main unit nor one of its configured conversions.
      resolveUnitConversion(itemDoc, item.itemUnitId);

      const adjustedStock = roundQty(item.updatedStock - item.currentStock);

      validatedItems.push({
        itemId: item.itemId,
        itemUnitId: item.itemUnitId || itemDoc.itemUnitId,
        currentStock: item.currentStock, // Use value from frontend
        updatedStock: item.updatedStock, // Use value from frontend
        adjustedStock,
        purchasePrice: item?.purchasePrice,
      });
    }

    // Create inventory adjustment
    const adjustment = await InventoryAdjustment.create(
      [
        {
          ...adjustmentBody,
          inventoryAdjustmentNumber: generatedAdjustmentNumber,
          items: validatedItems,
          status: 'DRAFT',
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return adjustment[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Approve inventory adjustment and update stock/batches
 * @param {ObjectId} adjustmentId
 * @param {ObjectId} companyId
 * @param {ObjectId} userId
 * @returns {Promise<InventoryAdjustment>}
 */
const approveInventoryAdjustment = async (adjustmentId, companyId, userId) => {
  const { Item, ItemInventory } = getBooksCrmModels();
  const { InventoryAdjustment } = getBooksModels();

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const adjustment = await InventoryAdjustment.findOne({
      _id: adjustmentId,
      companyId,
    }).session(session);

    if (!adjustment) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_ADJUSTMENT_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (adjustment.status !== 'DRAFT') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only DRAFT adjustments can be approved');
    }

    if (!adjustment.accountId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Select an adjustment account before approving');
    }
    const { Account } = getBooksModels();
    const adjustmentAccount = await Account.findOne({
      _id: adjustment.accountId,
      companyId,
      isActive: true,
    }).session(session);
    if (!adjustmentAccount) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Adjustment account not found');
    }
    const ADJUSTMENT_ACCOUNT_CATEGORIES = ['EXPENSE', 'OTHER_EXPENSE', 'COGS', 'INCOME', 'OTHER_INCOME'];
    if (!ADJUSTMENT_ACCOUNT_CATEGORIES.includes(adjustmentAccount.category)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'The adjustment account must be an income or expense account');
    }

    const { branchId, warehouseId, items, referenceNumber } = adjustment;

    // What the approval actually moved, for the ledger entry at the end.
    const stockIn = [];
    const stockOut = [];

    for (const item of items) {
      const itemDoc = await Item.findById(item.itemId).session(session);
      if (!itemDoc) {
        throw new ApiError(httpStatus.NOT_FOUND, `Item ${item.itemId} not found`);
      }
      if (itemDoc?.itemCategory?.isService) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Service item ${itemDoc.itemName} cannot be adjusted in inventory`);
      }
      if (itemDoc?.trackInventory === false) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${itemDoc.itemName} is not inventory tracked and does not hold stock, so it cannot be adjusted`,
        );
      }

      let inventory = await ItemInventory.findOne({
        itemId: item.itemId,
        companyId,
      }).session(session);

      if (!inventory) {
        inventory = await ItemInventory.create(
          [
            {
              itemId: item.itemId,
              companyId,
              totalOpeningStock: 0,
              totalAvailableStock: 0,
              totalInventoryValue: 0,
              warehouses: [],
              addedBy: userId,
            },
          ],
          { session },
        );
        inventory = inventory[0];
      }

      let warehouseData = inventory.warehouses.find(w => w.warehouseId.toString() === warehouseId.toString());

      if (!warehouseData) {
        inventory.warehouses.push({
          divisionId: adjustment?.divisionId,
          branchId,
          warehouseId,
          isActive: true,
          openingStock: 0,
          availableStock: 0,
          inventoryValue: 0,
        });
        // Re-assign to the actual Mongoose subdocument (push returns a new EmbeddedDocument;
        // the original plain object is a stale reference and modifying it would not persist)
        warehouseData = inventory.warehouses[inventory.warehouses.length - 1];

        // ★ IMPORTANT: Persist the new warehouse shell to DB NOW — before calling handleWarehouseStocks — to ensure it exists for stock updates in the service and avoid potential race conditions where concurrent adjustments might try to update the same warehouse stock
        await inventory.save({ session });
      }

      // Stock, batches and inventory value are kept in the item's main unit; the row was entered in item.itemUnitId.
      const conversionFactor = resolveUnitConversion(itemDoc, item.itemUnitId);
      const enteredStock = roundQty(item.adjustedStock);
      const adjustedStock = roundQty(enteredStock * conversionFactor);

      if (adjustedStock > 0) {
        const addedValue = await handlePositiveAdjustment(
          inventory,
          warehouseData,
          itemDoc,
          adjustedStock,
          enteredStock,
          item.itemUnitId,
          branchId,
          warehouseId,
          adjustment._id,
          companyId,
          referenceNumber,
          adjustment.inventoryAdjustmentNumber,
          userId,
          item?.purchasePrice,
          session,
        );
        stockIn.push({ itemId: item.itemId, value: addedValue });
      }

      if (adjustedStock < 0) {
        const removedValue = await handleNegativeAdjustment(
          inventory,
          warehouseData,
          itemDoc,
          Math.abs(adjustedStock),
          branchId,
          warehouseId,
          adjustment._id,
          companyId,
          referenceNumber,
          adjustment.inventoryAdjustmentNumber,
          userId,
          session,
        );
        stockOut.push({ itemId: item.itemId, value: removedValue });
      }

      inventory.updatedBy = userId;

      await inventory.save({ session });
    }

    adjustment.status = 'APPROVED';
    adjustment.approvedBy = userId;
    adjustment.approvalDate = new Date();
    adjustment.updatedBy = userId;

    await adjustment.save({ session });

    // Ledger: the gain or loss the count uncovered, in the same transaction as the stock.
    await ledgerService.postAdjustmentJournal({ companyId, adjustment, stockIn, stockOut, addedBy: userId }, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    return adjustment;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Handle positive stock adjustment (add stock and create batch)
 * @private
 */
const handlePositiveAdjustment = async (
  inventoryDoc,
  warehouseData,
  item,
  quantity,
  enteredQuantity,
  itemUnitId,
  branchId,
  warehouseId,
  adjustmentId,
  companyId,
  referenceNumber,
  docNo,
  userId,
  purchasePrice,
  session,
) => {
  const { Branch } = getBooksCrmModels();

  // Update warehouse stock
  warehouseData.availableStock = roundQty((warehouseData.availableStock || 0) + quantity);

  // Update total inventory stock
  inventoryDoc.totalAvailableStock = roundQty((inventoryDoc.totalAvailableStock || 0) + quantity);

  // Use the user-supplied purchase price when valid, otherwise fall back to the item's
  // cost so a missing/zero value (e.g. legacy adjustments, direct API calls) never
  // corrupts inventory value with NaN or understates it with 0.
  // The payload price is per entered unit and is used as is (the batch stores the rate as entered), so the
  // value is entered quantity x price. The item's cost price is per main unit, so it multiplies the main-unit quantity.
  const hasPayloadPrice = Number(purchasePrice) > 0;
  const resolvedPurchasePrice = hasPayloadPrice ? Number(purchasePrice) : item.purchaseInformation?.costPrice || 0;

  // Inventory value update
  const addedValue = (hasPayloadPrice ? enteredQuantity : quantity) * resolvedPurchasePrice;
  warehouseData.inventoryValue = (warehouseData.inventoryValue || 0) + addedValue;

  inventoryDoc.totalInventoryValue = (inventoryDoc.totalInventoryValue || 0) + addedValue;

  const branch = await Branch.findById(branchId).session(session);

  // Batch creation
  await handleWarehouseStock({
    action: 'addStock',
    stockData: {
      itemId: item._id,
      companyId,
      divisionId: branch?.divisionId,
      branchId,
      warehouseId,
      quantity: hasPayloadPrice ? enteredQuantity : quantity,
      itemUnitId: hasPayloadPrice ? itemUnitId : undefined,
      purchasePrice: resolvedPurchasePrice,
      vendorBatchNo: null,
      vendorBatchExpiry: null,
      sourceType: MODULE_NAMES.INVENTORY_ADJUSTMENT,
      sourceId: adjustmentId,
    },
    session,
  });

  await checkCompanyStockLevels({
    itemIds: [item._id],
    companyId,
    docType: MODULE_NAMES.INVENTORY_ADJUSTMENT,
    docId: adjustmentId,
    docNo,
    userId,
    session,
  });

  return addedValue;
};

/**
 * Handle negative stock adjustment (deduct stock and update batches)
 * @private
 */
const handleNegativeAdjustment = async (
  inventoryDoc,
  warehouseData,
  item,
  quantity,
  branchId,
  warehouseId,
  adjustmentId,
  companyId,
  referenceNumber,
  docNo,
  userId,
  session,
) => {
  if ((warehouseData.availableStock || 0) < quantity) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Insufficient stock for item ${item.itemId}`);
  }

  // Deduct warehouse stock (in-memory so save() persists correct value; warehouseBatch updates DB)
  warehouseData.availableStock = roundQty((warehouseData.availableStock || 0) - quantity);
  inventoryDoc.totalAvailableStock = roundQty((inventoryDoc.totalAvailableStock || 0) - quantity);

  // Batch deduction (FIFO logic in warehouseBatch)
  const deductionResult = await handleWarehouseStock({
    action: 'handleNegativeAdjustment',
    stockData: {
      itemId: item._id,
      companyId,
      branchId,
      warehouseId,
      quantity,
      deductedSourceType: MODULE_NAMES.INVENTORY_ADJUSTMENT,
      deductedSourceId: adjustmentId,
    },
    session,
  });

  /**
   * IMPORTANT:
   * deductionResult should return deductedValue
   * Example: { deductedValue: 1200 }
   */
  if (deductionResult?.deductedValue) {
    warehouseData.inventoryValue -= deductionResult.deductedValue;
    inventoryDoc.totalInventoryValue -= deductionResult.deductedValue;
  }

  await checkCompanyStockLevels({
    itemIds: [item._id],
    companyId,
    docType: MODULE_NAMES.INVENTORY_ADJUSTMENT,
    docId: adjustmentId,
    docNo,
    userId,
    session,
  });

  return deductionResult?.deductedValue || 0;
};

/**
 * Update inventory adjustment (only allowed for DRAFT status)
 * @param {ObjectId} adjustmentId
 * @param {Object} updateBody
 * @param {ObjectId} companyId
 * @param {ObjectId} userId
 * @returns {Promise<InventoryAdjustment>}
 */
const updateInventoryAdjustmentById = async (adjustmentId, updateBody, userId, companyId) => {
  const { Item } = getBooksCrmModels();
  const { InventoryAdjustment } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const adjustment = await InventoryAdjustment.findOne({
      _id: adjustmentId,
      companyId,
    }).session(session);

    if (!adjustment) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_ADJUSTMENT_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    // Only allow editing if status is DRAFT
    if (adjustment.status !== 'DRAFT') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot update adjustment with status ${adjustment.status}. Only DRAFT adjustments can be updated`,
      );
    }

    // Validate and update items if provided
    if (updateBody.items && Array.isArray(updateBody.items)) {
      assertNoDuplicateItems(updateBody.items);
      const validatedItems = [];
      for (const item of updateBody.items) {
        const itemDoc = await Item.findById(item.itemId).session(session);
        if (!itemDoc) {
          throw new ApiError(httpStatus.NOT_FOUND, `Item ${item.itemId} not found`);
        }
        if (itemDoc?.itemCategory?.isService) {
          throw new ApiError(httpStatus.BAD_REQUEST, `Service item ${itemDoc.itemName} cannot be adjusted in inventory`);
        }
        if (itemDoc?.trackInventory === false) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `${itemDoc.itemName} is not inventory tracked and does not hold stock, so it cannot be adjusted`,
          );
        }
        resolveUnitConversion(itemDoc, item.itemUnitId);
        const adjustedStock = roundQty(item.updatedStock - item.currentStock);

        validatedItems.push({
          itemId: item.itemId,
          itemUnitId: item.itemUnitId || itemDoc.itemUnitId,
          currentStock: item.currentStock,
          updatedStock: item.updatedStock,
          adjustedStock,
          purchasePrice: item?.purchasePrice,
        });
      }
      updateBody.items = validatedItems;
    }

    const normalizedInventoryAdjustmentNumber = updateBody.inventoryAdjustmentNumber?.trim();
    if (normalizedInventoryAdjustmentNumber) {
      updateBody.inventoryAdjustmentNumber = normalizedInventoryAdjustmentNumber;
    }

    Object.assign(adjustment, updateBody);

    adjustment.updatedBy = userId;

    await adjustment.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return adjustment;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Reject inventory adjustment
 * @param {ObjectId} adjustmentId
 * @param {ObjectId} companyId
 * @param {ObjectId} userId
 * @returns {Promise<InventoryAdjustment>}
 */
const rejectInventoryAdjustment = async (adjustmentId, companyId, userId) => {
  const { InventoryAdjustment } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const adjustment = await InventoryAdjustment.findOne({
      _id: adjustmentId,
      companyId,
    }).session(session);

    if (!adjustment) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_ADJUSTMENT_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (adjustment.status !== 'DRAFT') {
      throw new ApiError(httpStatus.BAD_REQUEST, `Cannot reject adjustment with status ${adjustment.status}`);
    }

    adjustment.status = 'REJECTED';
    adjustment.updatedBy = userId;

    await adjustment.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return adjustment;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Get inventory adjustment by ID
 * @param {ObjectId} adjustmentId
 * @param {ObjectId} companyId
 * @returns {Promise<InventoryAdjustment>}
 */
const getInventoryAdjustmentById = async (adjustmentId, companyId) => {
  const { InventoryAdjustment, Account } = getBooksModels();
  const { Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
  const { Company, User } = getCommonModels();

  const adjustment = await InventoryAdjustment.findOne({
    _id: adjustmentId,
    companyId,
  }).lean();

  if (!adjustment) {
    throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_ADJUSTMENT_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  // Manually populate all related documents
  const unitIds = [...new Set((adjustment.items || []).map(i => i.itemUnitId?.toString()).filter(Boolean))];
  const itemUnits = unitIds.length
    ? await ItemUnit.find({ _id: { $in: unitIds } })
        .select('name')
        .lean()
    : [];
  const itemUnitMap = new Map(itemUnits.map(u => [u._id.toString(), u]));

  const [company, division, branch, warehouse, account, createdByUser, approvedByUser, items, updatedByUser] = await Promise.all([
    adjustment.companyId ? Company.findById(adjustment.companyId).select('name').lean() : null,
    adjustment.divisionId ? Division.findById(adjustment.divisionId).select('name').lean() : null,
    adjustment.branchId ? Branch.findById(adjustment.branchId).select('name branchCode').lean() : null,
    adjustment.warehouseId ? Warehouse.findById(adjustment.warehouseId).select('name warehouseId').lean() : null,
    adjustment.accountId ? Account.findById(adjustment.accountId).select('accountName accountCode category').lean() : null,
    adjustment.createdBy ? User.findById(adjustment.createdBy).select('firstName lastName email').lean() : null,
    adjustment.approvedBy ? User.findById(adjustment.approvedBy).select('firstName lastName email').lean() : null,
    adjustment.items && adjustment.items.length > 0
      ? Item.find({
          _id: { $in: adjustment.items.map(item => item.itemId).filter(Boolean) },
        })
          .select('itemName itemNo')
          .lean()
      : [],
    adjustment.updatedBy ? User.findById(adjustment.updatedBy).select('firstName lastName email').lean() : null,
  ]);

  // Create item map for quick lookup
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));

  // Populate the adjustment object
  const populated = { ...adjustment };
  populated.inventoryAdjustmentNumber = adjustment.inventoryAdjustmentNumber || '';

  populated.companyId = company || adjustment.companyId;
  populated.divisionId = division || adjustment.divisionId;
  populated.branchId = branch || adjustment.branchId;
  populated.warehouseId = warehouse || adjustment.warehouseId;
  populated.accountId = account || adjustment.accountId;
  populated.createdBy = createdByUser || adjustment.createdBy;
  populated.approvedBy = approvedByUser || adjustment.approvedBy;

  // Populate items
  if (adjustment.items && Array.isArray(adjustment.items)) {
    populated.items = adjustment.items.map(item => ({
      ...item,
      itemId: item.itemId ? itemMap.get(item.itemId.toString()) || item.itemId : item.itemId,
      itemUnitId: item.itemUnitId ? itemUnitMap.get(item.itemUnitId.toString()) || item.itemUnitId : item.itemUnitId,
    }));
  }

  populated.updatedBy = updatedByUser || adjustment.updatedBy;

  return populated;
};

/**
 * Query inventory adjustments
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<QueryResult>}
 */
const queryInventoryAdjustments = async (filter, options) => {
  const { InventoryAdjustment, Account } = getBooksModels();
  const { Item, Division, Branch, Warehouse, ItemUnit } = getBooksCrmModels();
  const { Company, User } = getCommonModels();

  const conditions = { companyId: new mongoose.Types.ObjectId(filter.companyId) };

  const branchDivisionCond = buildBranchDivisionOrCondition(filter);
  if (branchDivisionCond) {
    Object.assign(conditions, branchDivisionCond);
  }

  if (filter.warehouseId) {
    const warehouseArray = filter.warehouseId.split(',').filter(Boolean);
    if (warehouseArray.length > 0) {
      conditions.warehouseId = {
        $in: warehouseArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.status) {
    if (filter.status.split(',').length > 0) {
      conditions.status = { $in: filter.status.split(',') };
    } else {
      conditions.status = filter.status;
    }
  }

  if (filter.reason) {
    conditions.reason = filter.reason;
  }

  if (filter.referenceNumber) {
    conditions.referenceNumber = { $regex: filter.referenceNumber, $options: 'i' };
  }

  if (filter.inventoryAdjustmentNumber) {
    const inventoryAdjustmentNumberRegex = { $regex: filter.inventoryAdjustmentNumber, $options: 'i' };
    conditions.inventoryAdjustmentNumber = inventoryAdjustmentNumberRegex;
  }

  if (filter.startDate && filter.endDate) {
    conditions.adjustmentDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  if (filter.search && filter.search.trim()) {
    const searchRegex = createSearchRegex(filter.search.trim());

    const [matchingItems, matchingWarehouses, matchingUsers] = await Promise.all([
      Item.find({ companyId: conditions.companyId, itemName: searchRegex }).select('_id'),
      Warehouse.find({ companyId: conditions.companyId, name: searchRegex }).select('_id'),
      User.find({
        $or: [{ firstName: searchRegex }, { lastName: searchRegex }, { email: searchRegex }],
      }).select('_id'),
    ]);

    const searchConditions = [
      { inventoryAdjustmentNumber: searchRegex },
      { referenceNumber: searchRegex },
      { status: searchRegex },
      { reason: searchRegex },
    ];

    if (matchingItems.length > 0) {
      searchConditions.push({ 'items.itemId': { $in: matchingItems.map(i => i._id) } });
    }

    if (matchingWarehouses.length > 0) {
      searchConditions.push({ warehouseId: { $in: matchingWarehouses.map(w => w._id) } });
    }

    if (matchingUsers.length > 0) {
      searchConditions.push({ approvedBy: { $in: matchingUsers.map(u => u._id) } });
    }

    conditions.$or = searchConditions;
  }

  const sortBy = options.sortBy || '-createdAt';
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;
  const pagination = options.pagination !== false;

  let query = InventoryAdjustment.find(conditions).sort(sortBy);

  if (pagination) {
    query = query.skip(skip).limit(limit);
  }

  const results = await query.lean();
  const totalResults = pagination ? await InventoryAdjustment.countDocuments(conditions) : results.length;

  // Extract unique IDs for manual population
  const companyIds = [...new Set(results.map(r => r.companyId?.toString()).filter(Boolean))];
  const divisionIds = [...new Set(results.map(r => r.divisionId?.toString()).filter(Boolean))];
  const branchIds = [...new Set(results.map(r => r.branchId?.toString()).filter(Boolean))];
  const warehouseIds = [...new Set(results.map(r => r.warehouseId?.toString()).filter(Boolean))];
  const accountIds = [...new Set(results.map(r => r.accountId?.toString()).filter(Boolean))];
  const userIds = [
    ...new Set([
      ...results.map(r => r.createdBy?.toString()).filter(Boolean),
      ...results.map(r => r.approvedBy?.toString()).filter(Boolean),
      ...results.map(r => r.updatedBy?.toString()).filter(Boolean),
    ]),
  ];
  const itemIds = [...new Set(results.flatMap(r => r.items?.map(item => item.itemId?.toString()).filter(Boolean) || []))];

  const unitIds = [...new Set(results.flatMap(r => r.items?.map(item => item.itemUnitId?.toString()).filter(Boolean) || []))];

  // Fetch all related documents
  const [companies, divisions, branches, warehouses, accounts, users, items, itemUnits] = await Promise.all([
    companyIds.length > 0
      ? Company.find({ _id: { $in: companyIds } })
          .select('name')
          .lean()
      : Promise.resolve([]),
    divisionIds.length > 0
      ? Division.find({ _id: { $in: divisionIds } })
          .select('name')
          .lean()
      : Promise.resolve([]),
    branchIds.length > 0
      ? Branch.find({ _id: { $in: branchIds } })
          .select('name branchCode')
          .lean()
      : Promise.resolve([]),
    warehouseIds.length > 0
      ? Warehouse.find({ _id: { $in: warehouseIds } })
          .select('name warehouseId')
          .lean()
      : Promise.resolve([]),
    accountIds.length > 0
      ? Account.find({ _id: { $in: accountIds } })
          .select('accountName accountCode category')
          .lean()
      : Promise.resolve([]),
    userIds.length > 0
      ? User.find({ _id: { $in: userIds } })
          .select('firstName lastName email')
          .lean()
      : Promise.resolve([]),
    itemIds.length > 0
      ? Item.find({ _id: { $in: itemIds } })
          .select('itemName itemNo')
          .lean()
      : Promise.resolve([]),
    unitIds.length > 0
      ? ItemUnit.find({ _id: { $in: unitIds } })
          .select('name')
          .lean()
      : Promise.resolve([]),
  ]);

  // Create maps for quick lookup
  const companyMap = new Map(companies.map(c => [c._id.toString(), c]));
  const divisionMap = new Map(divisions.map(d => [d._id.toString(), d]));
  const branchMap = new Map(branches.map(b => [b._id.toString(), b]));
  const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w]));
  const accountMap = new Map(accounts.map(a => [a._id.toString(), a]));
  const userMap = new Map(users.map(u => [u._id.toString(), u]));
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));
  const itemUnitMap = new Map(itemUnits.map(u => [u._id.toString(), u]));

  // Populate results manually
  const populatedResults = results.map(adjustment => {
    const populated = { ...adjustment };
    populated.inventoryAdjustmentNumber = adjustment.inventoryAdjustmentNumber || '';

    // Populate company
    if (adjustment.companyId) {
      populated.companyId = companyMap.get(adjustment.companyId.toString()) || adjustment.companyId;
    }

    // Populate division
    if (adjustment.divisionId) {
      populated.divisionId = divisionMap.get(adjustment.divisionId.toString()) || adjustment.divisionId;
    }

    // Populate branch
    if (adjustment.branchId) {
      populated.branchId = branchMap.get(adjustment.branchId.toString()) || adjustment.branchId;
    }

    // Populate warehouse
    if (adjustment.warehouseId) {
      populated.warehouseId = warehouseMap.get(adjustment.warehouseId.toString()) || adjustment.warehouseId;
    }

    // Populate account
    if (adjustment.accountId) {
      populated.accountId = accountMap.get(adjustment.accountId.toString()) || adjustment.accountId;
    }

    // Populate createdBy
    if (adjustment.createdBy) {
      populated.createdBy = userMap.get(adjustment.createdBy.toString()) || adjustment.createdBy;
    }

    // Populate approvedBy
    if (adjustment.approvedBy) {
      populated.approvedBy = userMap.get(adjustment.approvedBy.toString()) || adjustment.approvedBy;
    }

    if (adjustment.updatedBy) {
      populated.updatedBy = userMap.get(adjustment.updatedBy.toString()) || adjustment.updatedBy;
    }

    // Populate items
    if (adjustment.items && Array.isArray(adjustment.items)) {
      populated.items = adjustment.items.map(item => ({
        ...item,
        itemId: item.itemId ? itemMap.get(item.itemId.toString()) || item.itemId : item.itemId,
        itemUnitId: item.itemUnitId ? itemUnitMap.get(item.itemUnitId.toString()) || item.itemUnitId : item.itemUnitId,
      }));
    }

    return populated;
  });

  return {
    results: populatedResults,
    page: pagination ? page : undefined,
    limit: pagination ? limit : undefined,
    totalPages: pagination ? Math.ceil(totalResults / limit) : undefined,
    totalResults,
  };
};

module.exports = {
  createInventoryAdjustment: withTransientRetry(createInventoryAdjustment),
  approveInventoryAdjustment,
  rejectInventoryAdjustment,
  updateInventoryAdjustmentById,
  getInventoryAdjustmentById,
  queryInventoryAdjustments,
};
