const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { INVENTORY_TRANSFER_MESSAGES } = require('../../../utils/messages');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { INVENTORY_TRANSFER_REQUEST, PRODUCTION_ORDER_STATUS } = require('../../../utils/enum');
const { checkRawMaterialsStockAvailability } = require('../../../utils/inventoryConfig');
const { handleWarehouseStock, resolveUnitConversion } = require('../../../services/warehouseBatch.service');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');

const escapeRegex = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Transfer stock between warehouses.
 * Accepts an optional externalSession — when provided the caller owns the transaction
 * boundary and this function participates without starting/committing its own.
 */
const transferStock = async (transferData, externalSession = null) => {
  const { Item, Warehouse, ItemInventory } = getBooksCrmModels();

  const { companyId, itemId, itemUnitId, fromWarehouseId, toWarehouseId, quantity, addedBy, sourceType, requestId } =
    transferData;

  if (fromWarehouseId.toString() === toWarehouseId.toString()) {
    if (sourceType !== 'PRODUCTIONORDER_STOCK_TRANSFER') {
      throw new ApiError(httpStatus.BAD_REQUEST, INVENTORY_TRANSFER_MESSAGES.SAME_WAREHOUSE_ERROR);
    }
    return { success: true };
  }

  const ownSession = externalSession === null;
  let session = externalSession;

  if (ownSession) {
    const connection = await getClientConnection();
    session = await connection.startSession();
  }

  try {
    if (ownSession) await session.startTransaction();

    const [item, fromWarehouse, toWarehouse] = await Promise.all([
      Item.findOne({ _id: itemId, companyId }).session(session),
      Warehouse.findById(fromWarehouseId).session(session),
      Warehouse.findById(toWarehouseId).session(session),
    ]);

    if (!item) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.ITEM_NOT_FOUND);
    }
    if (item.itemCategory?.isService === true) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Service items cannot be transferred as inventory stock');
    }
    if (item.trackInventory === false) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${item.itemName} is not inventory tracked and does not hold stock, so it cannot be transferred`,
      );
    }
    if (!fromWarehouse) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.FROM_WAREHOUSE_NOT_FOUND);
    }
    if (!toWarehouse) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.TO_WAREHOUSE_NOT_FOUND);
    }

    const itemInventory = await ItemInventory.findOne({ itemId, companyId }).session(session);
    if (!itemInventory) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Item inventory not found');
    }

    const hasDestWarehouse = itemInventory.warehouses.some(w => w.warehouseId.equals(toWarehouseId));
    if (!hasDestWarehouse) {
      await defaultWarehouseEntry(
        {
          itemArray: [item],
          companyId,
          warehouseId: toWarehouseId,
          branchId: toWarehouse.branchId,
          divisionId: toWarehouse.divisionId,
          isActive: true,
        },
        session,
      );
    }

    const deductionSummary = await handleWarehouseStock({
      action: 'inventoryTransferDeduction',
      stockData: {
        itemId,
        companyId,
        branchId: fromWarehouse.branchId,
        warehouseId: fromWarehouseId,
        quantity,
        itemUnitId,
        deductedSourceType: sourceType,
        deductedSourceId: requestId,
      },
      session,
    });

    if (Array.isArray(deductionSummary) && deductionSummary.length > 0) {
      // The summary price is per main unit, but addStock takes a price per the unit it is given (itemUnitId) and
      // divides it by that unit's conversion factor, so hand it the main-unit price scaled up to the transfer unit.
      const transferConversionFactor = resolveUnitConversion(item, itemUnitId);
      for (const batch of deductionSummary) {
        await handleWarehouseStock({
          action: 'addStock',
          stockData: {
            itemId,
            companyId,
            divisionId: toWarehouse.divisionId,
            branchId: toWarehouse.branchId,
            warehouseId: toWarehouseId,
            quantity: batch.sellingQuantity,
            baseQuantity: batch.quantity,
            itemUnitId,
            purchasePrice: batch.purchasePrice * transferConversionFactor,
            vendorBatchNo: batch.vendorBatchNo,
            vendorBatchExpiry: batch.vendorBatchExpiry,
            sourceType,
            sourceId: requestId,
            addedBy,
            referenceBatches: [
              {
                batchId: batch.itemBatchId,
                batchNo: batch.batchNo,
                quantity: batch.quantity,
                purchasePrice: batch.purchasePrice,
              },
            ],
          },
          session,
        });
      }
    }

    if (ownSession) await session.commitTransaction();
    return { success: true };
  } catch (error) {
    if (ownSession) await session.abortTransaction();
    throw error;
  } finally {
    if (ownSession) session.endSession();
  }
};

const createInventoryTransferRequest = async transferData => {
  const { Item, Warehouse } = getBooksCrmModels();
  const { InventoryTransferRequest } = getBooksModels();
  const {
    itemId,
    itemUnitId,
    companyId,
    fromWarehouseId,
    toWarehouseId,
    quantity,
    batchNumber,
    notes,
    referenceNumber,
    addedBy,
    updatedBy,
    date,
  } = transferData;

  if (fromWarehouseId.toString() === toWarehouseId.toString()) {
    throw new ApiError(httpStatus.BAD_REQUEST, INVENTORY_TRANSFER_MESSAGES.SAME_WAREHOUSE_ERROR);
  }

  const item = await Item.findOne({ _id: itemId, companyId });
  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.ITEM_NOT_FOUND);
  }

  if (item.itemCategory?.isService === true) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Service items cannot be transferred as inventory stock');
  }

  // Throws if the selected unit is neither the item's main unit nor one of its configured conversions.
  resolveUnitConversion(item, itemUnitId);

  const sourceWarehouse = await Warehouse.findOne({ _id: fromWarehouseId, companyId });
  if (!sourceWarehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.FROM_WAREHOUSE_NOT_FOUND);
  }

  const destWarehouse = await Warehouse.findOne({ _id: toWarehouseId, companyId });
  if (!destWarehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.TO_WAREHOUSE_NOT_FOUND);
  }

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const latestInventoryTransfer = await InventoryTransferRequest.findOne(
      { companyId },
      { transferId: 1 },
      { sort: { createdAt: -1 } },
    );

    let nextTransferNumber = 1;
    if (latestInventoryTransfer?.transferId) {
      const match = latestInventoryTransfer.transferId.match(/TRF(\d+)/);
      if (match) {
        nextTransferNumber = parseInt(match[1], 10) + 1;
      }
    }

    try {
      const transferRequest = await InventoryTransferRequest.create({
        transferId: `TRF${nextTransferNumber}`,
        companyId,
        itemId,
        itemUnitId: itemUnitId || item.itemUnitId,
        fromWarehouseId,
        toWarehouseId,
        quantity,
        batchNumber,
        notes,
        referenceNumber,
        addedBy,
        updatedBy,
        date,
      });
      return transferRequest;
    } catch (err) {
      if (err.code === 11000 && attempt < MAX_RETRIES) continue;
      if (err.code === 11000) throw new ApiError(httpStatus.CONFLICT, 'Could not generate a unique transfer ID, please retry.');
      throw err;
    }
  }
};

const getInventoryTransferById = async (transferId, companyId) => {
  const { InventoryTransferRequest, ProductionOrder } = getBooksModels();
  const { Item, Warehouse, ItemUnit } = getBooksCrmModels();
  const { Company, User } = getCommonModels();

  const request = await InventoryTransferRequest.findOne({
    _id: transferId,
    companyId,
  }).lean();

  if (!request) {
    throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const rawMaterialIds = (request.rawMaterials || []).map(item => item.rawMaterialId).filter(Boolean);

  const userIds = [request.addedBy, request.updatedBy].filter(Boolean);

  const [company, item, itemUnit, fromWarehouse, toWarehouse, productionOrder, rawMaterials, users] = await Promise.all([
    request.companyId ? Company.findById(request.companyId).select('name').lean() : null,

    request.itemId ? Item.findById(request.itemId).select('itemName itemNo itemUnit').lean() : null,

    request.itemUnitId ? ItemUnit.findById(request.itemUnitId).select('name').lean() : null,

    request.fromWarehouseId ? Warehouse.findById(request.fromWarehouseId).select('name warehouseId').lean() : null,

    request.toWarehouseId ? Warehouse.findById(request.toWarehouseId).select('name warehouseId').lean() : null,

    request.productionOrderId
      ? ProductionOrder.findById(request.productionOrderId).select('productionOrderCode status quantity').lean()
      : null,

    rawMaterialIds.length
      ? Item.find({ _id: { $in: rawMaterialIds } })
          .select('itemName itemNo itemUnit')
          .lean()
      : [],

    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select('firstName lastName')
          .lean()
      : [],
  ]);

  const userMap = new Map(users.map(user => [user._id.toString(), user]));

  const rawMaterialMap = new Map(rawMaterials.map(item => [item._id.toString(), item]));

  return {
    ...request,

    companyId: company || request.companyId,
    itemId: item || request.itemId,
    itemUnitId: itemUnit || request.itemUnitId,
    fromWarehouseId: fromWarehouse || request.fromWarehouseId,
    toWarehouseId: toWarehouse || request.toWarehouseId,
    productionOrderId: productionOrder || request.productionOrderId,

    addedBy: request.addedBy ? userMap.get(request.addedBy.toString()) || request.addedBy : null,

    updatedBy: request.updatedBy ? userMap.get(request.updatedBy.toString()) || null : null,

    rawMaterials: (request.rawMaterials || []).map(material => ({
      ...material,
      rawMaterialId: material.rawMaterialId
        ? rawMaterialMap.get(material.rawMaterialId.toString()) || material.rawMaterialId
        : material.rawMaterialId,
    })),
  };
};

const getInventoryTransferRequests = async (filter, options) => {
  const { InventoryTransferRequest, ProductionOrder } = getBooksModels();
  const { Item, Warehouse, Branch, ItemUnit } = getBooksCrmModels();
  const { User } = getCommonModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const query = { companyId };
  const filterConditions = [];
  const searchConditions = [];

  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter.startDate || filter.endDate) {
    query.date = {};
    if (filter.startDate) query.date.$gte = new Date(filter.startDate);
    if (filter.endDate) query.date.$lte = new Date(filter.endDate);
  }

  if (filter.isProductionOrderReq !== undefined) {
    query.isProductionOrderReq = filter.isProductionOrderReq === true;
  }

  if (filter.divisionId && !filter.branchId) {
    const divisionObjectId = new mongoose.Types.ObjectId(filter.divisionId);
    const branches = await Branch.find({ companyId, divisionId: divisionObjectId }).select('_id');
    const branchIds = branches.map(b => b._id);
    if (branchIds.length > 0) {
      const warehouses = await Warehouse.find({ companyId, branchId: { $in: branchIds } }).select('_id');
      const warehouseIds = warehouses.map(w => w._id);
      if (warehouseIds.length > 0) {
        filterConditions.push({ fromWarehouseId: { $in: warehouseIds } }, { toWarehouseId: { $in: warehouseIds } });
      }
    }
  }

  if (filter.divisionId && filter.branchId) {
    const branchObjectIds = filter.branchId
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    const warehouses = await Warehouse.find({ companyId, branchId: { $in: branchObjectIds } }).select('_id');
    const warehouseIds = warehouses.map(w => w._id);
    if (warehouseIds.length > 0) {
      filterConditions.push({ fromWarehouseId: { $in: warehouseIds } }, { toWarehouseId: { $in: warehouseIds } });
    }
  }

  if (filter.warehouseId) {
    filterConditions.push(
      { fromWarehouseId: new mongoose.Types.ObjectId(filter.warehouseId) },
      { toWarehouseId: new mongoose.Types.ObjectId(filter.warehouseId) },
    );
  }

  if (filter.search) {
    const searchRegex = new RegExp(escapeRegex(filter.search.trim()), 'i');
    const matchingWarehouses = await Warehouse.find({ name: searchRegex }).select('_id');
    const warehouseIds = matchingWarehouses.map(div => div._id);
    searchConditions.push({ transferId: searchRegex }, { status: searchRegex }, { referenceNumber: searchRegex });
    const matchingItems = await Item.find({
      itemName: { $regex: searchRegex },
    }).select('_id');

    const matchingItemIds = matchingItems.map(i => i._id);

    if (matchingItemIds.length > 0) {
      searchConditions.push({ itemId: { $in: matchingItemIds } });
    }
    if (warehouseIds.length > 0) {
      searchConditions.push({ fromWarehouseId: { $in: warehouseIds } });
      searchConditions.push({ toWarehouseId: { $in: warehouseIds } });
    }
  }

  if (filterConditions.length > 0 && searchConditions.length > 0) {
    query.$and = [{ $or: filterConditions }, { $or: searchConditions }];
  } else if (filterConditions.length > 0) {
    query.$or = filterConditions;
  } else if (searchConditions.length > 0) {
    query.$or = searchConditions;
  }

  const result = await InventoryTransferRequest.paginate(query, options);
  const transferRequests = result.results;

  const itemIds = [...new Set(transferRequests.map(t => t.itemId?.toString()).filter(Boolean))];
  const fromWarehouseIds = [...new Set(transferRequests.map(t => t.fromWarehouseId?.toString()).filter(Boolean))];
  const toWarehouseIds = [...new Set(transferRequests.map(t => t.toWarehouseId?.toString()).filter(Boolean))];
  const rawMaterialIds = [
    ...new Set(
      transferRequests
        .filter(t => t.isProductionOrderReq && Array.isArray(t.rawMaterials))
        .flatMap(t => t.rawMaterials.map(rm => rm.rawMaterialId?.toString()).filter(Boolean)),
    ),
  ];
  const productionOrderIds = [
    ...new Set(
      transferRequests
        .filter(t => t.isProductionOrderReq && t.productionOrderId)
        .map(t => t.productionOrderId?.toString())
        .filter(Boolean),
    ),
  ];

  const items = await Item.find({ _id: { $in: itemIds } }).select('itemName itemNo');
  const itemUnitIds = [...new Set(transferRequests.map(t => t.itemUnitId?.toString()).filter(Boolean))];
  const itemUnits = itemUnitIds.length ? await ItemUnit.find({ _id: { $in: itemUnitIds } }).select('name') : [];
  const itemUnitMap = Object.fromEntries(itemUnits.map(u => [u._id.toString(), u]));
  const fromWarehouses = await Warehouse.find({ _id: { $in: fromWarehouseIds } }).select('name');
  const toWarehouses = await Warehouse.find({ _id: { $in: toWarehouseIds } }).select('name');
  const rawMaterials = rawMaterialIds.length ? await Item.find({ _id: { $in: rawMaterialIds } }).select('itemName itemNo') : [];
  const productionOrders = productionOrderIds.length
    ? await ProductionOrder.find({ _id: { $in: productionOrderIds } }).select('productionOrderCode')
    : [];

  const userIds = [
    ...new Set([
      ...transferRequests.map(t => t.addedBy?.toString()).filter(Boolean),
      ...transferRequests.map(t => t.updatedBy?.toString()).filter(Boolean),
    ]),
  ];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('firstName lastName') : [];

  const itemMap = Object.fromEntries(items.map(i => [i._id.toString(), i]));
  const fromWarehouseMap = Object.fromEntries(fromWarehouses.map(w => [w._id.toString(), w]));
  const toWarehouseMap = Object.fromEntries(toWarehouses.map(w => [w._id.toString(), w]));
  const rawMaterialMap = Object.fromEntries(rawMaterials.map(rm => [rm._id.toString(), rm]));
  const productionOrderMap = Object.fromEntries(productionOrders.map(po => [po._id.toString(), po]));
  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

  const populatedResults = transferRequests.map(req => ({
    ...req.toObject(),
    itemId: itemMap[req.itemId?.toString()] || null,
    itemUnitId: itemUnitMap[req.itemUnitId?.toString()] || null,
    fromWarehouseId: fromWarehouseMap[req.fromWarehouseId?.toString()] || null,
    toWarehouseId: toWarehouseMap[req.toWarehouseId?.toString()] || null,
    ...(req.productionOrderId && { productionOrderId: productionOrderMap[req.productionOrderId.toString()] || null }),
    addedBy: req.addedBy ? userMap[req.addedBy.toString()] || null : null,
    updatedBy: req.updatedBy ? userMap[req.updatedBy.toString()] || null : null,
    rawMaterials:
      req.isProductionOrderReq && Array.isArray(req.rawMaterials) && req.rawMaterials.length > 0
        ? req.rawMaterials.map(rm => {
            const plainRm = rm.toObject ? rm.toObject() : { ...rm };
            return {
              _id: plainRm._id,
              rawMaterialId: rawMaterialMap[plainRm.rawMaterialId?.toString()]
                ? {
                    _id: rawMaterialMap[plainRm.rawMaterialId?.toString()]._id,
                    itemName: rawMaterialMap[plainRm.rawMaterialId?.toString()].itemName,
                  }
                : null,
              perItemRequiredUnit: plainRm.perItemRequiredUnit,
              productionOrderRequiredUnit: plainRm.productionOrderRequiredUnit,
            };
          })
        : [],
  }));

  return {
    ...result,
    results: populatedResults,
  };
};

const approveInventoryTransfer = async (id, companyId, userId, manPower_inventoryTransfer) => {
  const { InventoryTransferRequest, ProductionOrder } = getBooksModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const request = await InventoryTransferRequest.findOne({ _id: id, companyId }).session(session);
    if (!request) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (request.status !== INVENTORY_TRANSFER_REQUEST.PENDING) {
      throw new ApiError(httpStatus.BAD_REQUEST, INVENTORY_TRANSFER_MESSAGES.ONLY_PENDING_CAN_APPROVE);
    }

    if (request.isProductionOrderReq && Array.isArray(request.rawMaterials) && request.rawMaterials.length > 0) {
      await checkRawMaterialsStockAvailability({
        warehouseId: request.fromWarehouseId,
        rawMaterials: request.rawMaterials,
        companyId: request.companyId,
        session,
        includeRejectQty: false,
        strictValidation: true,
      });

      if (request?.fromWarehouseId?.toString() !== request?.toWarehouseId?.toString()) {
        for (const rm of request.rawMaterials) {
          await transferStock(
            {
              companyId: request.companyId,
              itemId: rm.rawMaterialId,
              itemUnitId: rm.itemUnitId,
              fromWarehouseId: request.fromWarehouseId,
              toWarehouseId: request.toWarehouseId,
              quantity: Math.round(Number(rm.productionOrderRequiredUnit) * 1000) / 1000,
              notes: request.notes,
              referenceNumber: request.referenceNumber,
              addedBy: userId,
              sourceType: 'PRODUCTIONORDER_STOCK_TRANSFER',
              requestId: request._id,
              docNo: request.transferId,
            },
            session,
          );
        }
      }

      if (request.productionOrderId) {
        // ProductionOrder.updatedBy holds the last user id (not a history list like the transfer request's).
        const productionOrderUpdate = { status: PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED, updatedBy: userId };
        if (manPower_inventoryTransfer !== undefined)
          productionOrderUpdate.manPower_inventoryTransfer = manPower_inventoryTransfer;
        await ProductionOrder.findByIdAndUpdate(request.productionOrderId, productionOrderUpdate, { new: true, session });
      }
    } else {
      if (request?.fromWarehouseId?.toString() !== request?.toWarehouseId?.toString()) {
        await transferStock(
          {
            companyId: request.companyId,
            itemId: request.itemId,
            itemUnitId: request.itemUnitId,
            fromWarehouseId: request.fromWarehouseId,
            toWarehouseId: request.toWarehouseId,
            quantity: request.quantity,
            notes: request.notes,
            referenceNumber: request.referenceNumber,
            addedBy: userId,
            sourceType: 'MANUAL_STOCK_TRANSFER',
            requestId: request._id,
            docNo: request.transferId,
          },
          session,
        );
      }
    }

    request.status = INVENTORY_TRANSFER_REQUEST.APPROVED;
    request.updatedBy = userId;
    await request.save({ session });

    await session.commitTransaction();
    return request;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const rejectInventoryTransfer = async (id, companyId, userId, manPower_inventoryTransfer) => {
  const { InventoryTransferRequest, ProductionOrder } = getBooksModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const request = await InventoryTransferRequest.findOne({ _id: id, companyId }).session(session);
    if (!request) {
      throw new ApiError(httpStatus.NOT_FOUND, INVENTORY_TRANSFER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (request.status !== INVENTORY_TRANSFER_REQUEST.PENDING) {
      throw new ApiError(httpStatus.BAD_REQUEST, INVENTORY_TRANSFER_MESSAGES.ONLY_PENDING_CAN_REJECT);
    }

    request.status = INVENTORY_TRANSFER_REQUEST.REJECTED;
    request.updatedBy = userId;
    if (request.isProductionOrderReq && request.productionOrderId) {
      const productionOrderUpdate = {
        status: PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED,
        $set: { updatedBy: userId },
      };
      if (Array.isArray(manPower_inventoryTransfer) && manPower_inventoryTransfer.length > 0) {
        productionOrderUpdate.manPower_inventoryTransfer = manPower_inventoryTransfer;
      }
      await ProductionOrder.findByIdAndUpdate(request.productionOrderId, productionOrderUpdate, { session });
    }
    await request.save({ session });

    await session.commitTransaction();
    return request;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

module.exports = {
  createInventoryTransferRequest,
  getInventoryTransferById,
  getInventoryTransferRequests,
  approveInventoryTransfer,
  rejectInventoryTransfer,
  transferStock,
};
