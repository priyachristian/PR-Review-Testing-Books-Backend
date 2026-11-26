const ApiError = require('../../../utils/ApiError');
const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { getBooksModels, getBooksCrmModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { escapeRegex } = require('../../../utils/regexUtils');
const { getWarehouseDetails } = require('../../allMaster/warehouse/warehouse.service');
const {
  PRODUCTION_ORDER_STATUS,
  PRODUCTION_ORDER_STATUS_ACTION,
  INVENTORY_TRANSFER_REQUEST,
  SALES_ORDER_STATUS,
  ALLOWED_STATUSES_FOR_CLOSE,
  MODULE_NAMES,
  LEDGER_SOURCE_MODULES,
  PROCESS_STATUS,
  PRODUCTION_ORDER_ACTIVITY_TYPE,
  PRODUCTION_ORDER_INVENTORY_EVENT_TYPE,
} = require('../../../utils/enum');
const {
  isStockTrackedItem,
  getUntrackedProductionItems,
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
  reverseDeductionByBatch,
  deleteStockByBatchId,
  adjustStockByBatchId,
  roundQty,
  resolveUnitConversion,
} = require('../../../services/warehouseBatch.service');
const { checkRawMaterialsStockAvailability } = require('../../../utils/inventoryConfig');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { PRODUCTION_ORDER_MESSAGES } = require('../../../utils/messages');
const { getPendingProductionByLine } = require('../../../services/conversionStatus.service');

const getRawMaterialNameMap = async (rawMaterials, session) => {
  const { Item } = getBooksCrmModels();
  const ids = [...new Set(rawMaterials.map(rm => rm?.rawMaterialId?.toString()).filter(Boolean))];
  const items = ids.length
    ? await Item.find({ _id: { $in: ids } })
        .select('itemName')
        .session(session)
        .lean()
    : [];
  return new Map(items.map(i => [i._id.toString(), i.itemName]));
};

// Rows arrive with the unit they were entered in (itemUnitId). Throws if that unit is neither the item's main unit
// nor a configured conversion, and defaults a missing unit to the item's main unit so the stored row always carries one.
const applyRowUnits = async (rows, itemKey, companyId, session) => {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const { Item } = getBooksCrmModels();
  const ids = [...new Set(rows.map(r => r?.[itemKey]?.toString()).filter(Boolean))];
  const items = ids.length
    ? await Item.find({ _id: { $in: ids }, companyId })
        .select('itemName itemUnitId unitConversions')
        .session(session)
        .lean()
    : [];
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));
  return rows.map(row => {
    const itemDoc = row?.[itemKey] ? itemMap.get(row[itemKey].toString()) : null;
    if (!itemDoc) return row;
    resolveUnitConversion(itemDoc, row.itemUnitId);
    return { ...row, itemUnitId: row.itemUnitId || itemDoc.itemUnitId };
  });
};

// The order keeps one raw material row per item + unit (the same item can be on the BOM in several units), and its
// quantities are in that row's unit. Prefer the row in the submitted unit; fall back to any row of the item.
const findRootRawMaterial = (productionOrder, rawMaterialId, itemUnitId) => {
  const rows = (productionOrder.rawMaterials || []).filter(rm => rm.rawMaterialId && rm.rawMaterialId.equals(rawMaterialId));
  return rows.find(rm => itemUnitId && rm.itemUnitId && String(rm.itemUnitId) === String(itemUnitId)) || rows[0];
};

const applySubmissionBodyUnits = async (updateBody, companyId, session) => {
  updateBody.rawMaterials = await applyRowUnits(updateBody.rawMaterials, 'rawMaterialId', companyId, session);
  updateBody.scrapOut = await applyRowUnits(updateBody.scrapOut, 'item', companyId, session);
};

const applyProcessBodyUnits = async (processData, companyId, session) => {
  processData.processRawMaterialInput = await applyRowUnits(processData.processRawMaterialInput, 'item', companyId, session);
  processData.scrapOutProcess = await applyRowUnits(processData.scrapOutProcess, 'item', companyId, session);
};

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

// An order in one of these is off the shop floor for good, so it cannot still hold work in progress.
const TERMINAL_PRODUCTION_STATUSES = [PRODUCTION_ORDER_STATUS.COMPLETED, PRODUCTION_ORDER_STATUS.CLOSED];

const logProductionOrderActivity = (productionOrder, { action, description, userId, processId, submissionId, metadata } = {}) => {
  if (!productionOrder.activityLog) {
    productionOrder.activityLog = [];
  }
  productionOrder.activityLog.push({
    action,
    description,
    performedBy: userId,
    performedAt: new Date(),
    ...(processId ? { processId } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(metadata ? { metadata } : {}),
  });
};

// Re-derives the status an on-hold order should resume with from its own data
// (submissions, process progress, latest transfer request) instead of the activity log.
const getProcessRouteStatusBeforeHold = productionOrder => {
  const processes = productionOrder.processBased?.processes || [];
  if (processes.length > 0 && processes.every(p => p.endDatetime)) return PRODUCTION_ORDER_STATUS.COMPLETED;
  if (processes.some(p => p.startDatetime)) return PRODUCTION_ORDER_STATUS.PARTIAL;
  return PRODUCTION_ORDER_STATUS.PENDING;
};

const getBomBasedStatusBeforeHold = async (productionOrder, session) => {
  const { InventoryTransferRequest } = getBooksModels();

  const latestTransfer = await InventoryTransferRequest.findOne({ productionOrderId: productionOrder._id })
    .sort({ createdAt: -1 })
    .session(session);
  if (latestTransfer?.status === INVENTORY_TRANSFER_REQUEST.PENDING) {
    return PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL;
  }
  if (latestTransfer?.status === INVENTORY_TRANSFER_REQUEST.REJECTED) {
    return PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED;
  }

  return deriveStatusFromTotals(
    productionOrder.totalFgSubmittedQty,
    productionOrder.totalFgRejectedQty,
    productionOrder.quantity,
  );
};

// Status implied purely by progress data, ignoring any manual completion.
const deriveStatusFromOrderData = (productionOrder, session) =>
  productionOrder.productionManageMethod === 'PROCESS_ROUTE'
    ? getProcessRouteStatusBeforeHold(productionOrder)
    : getBomBasedStatusBeforeHold(productionOrder, session);

const getStatusBeforeHold = async (productionOrder, session) => {
  if (productionOrder.isManuallyCompleted) {
    return PRODUCTION_ORDER_STATUS.COMPLETED;
  }

  return deriveStatusFromOrderData(productionOrder, session);
};

const logInventoryImpact = (
  productionOrder,
  { event, item, itemBatchId, warehouseId, stockBefore, change, stockAfter, userId, processId, submissionId, referenceCode } = {},
) => {
  if (stockBefore == null || change == null || stockAfter == null) return;
  if (!productionOrder.inventoryImpactLog) {
    productionOrder.inventoryImpactLog = [];
  }
  productionOrder.inventoryImpactLog.push({
    event,
    eventDatetime: new Date(),
    item,
    itemBatchId,
    warehouseId,
    stockBefore,
    change,
    stockAfter,
    performedBy: userId,
    referenceCode: referenceCode || productionOrder.productionOrderCode,
    ...(processId ? { processId } : {}),
    ...(submissionId ? { submissionId } : {}),
  });
};

const getItemWarehouseStock = async (itemId, warehouseId, companyId, session) => {
  if (!itemId || !warehouseId) return 0;
  const { ItemInventory } = getBooksCrmModels();
  const inventory = await ItemInventory.findOne({ itemId, companyId }, { warehouses: 1 }).session(session).lean();
  const warehouse = (inventory?.warehouses || []).find(w => w.warehouseId?.toString() === warehouseId.toString());
  return warehouse?.availableStock ?? 0;
};

const getItemProductionData = async (itemId, warehouseId, companyId, processId) => {
  const { Item } = getBooksCrmModels();
  const { Process } = getBooksModels();

  const item = await Item.findOne({ _id: itemId, companyId })
    .select('itemName itemNo itemUnit itemUnitId productionData')
    .populate([
      { path: 'productionData.bomBased.item', select: 'itemName itemNo itemUnit itemUnitId' },
      { path: 'productionData.bomBased.itemGroup', select: 'name' },
      { path: 'productionData.processBased.rawMaterials.item', select: 'itemName itemNo itemUnit itemUnitId' },
      { path: 'productionData.processBased.rawMaterials.itemGroup', select: 'name' },
      { path: 'productionData.productionScrapOutInventory.scrapItemName', select: 'itemName itemNo itemUnit itemUnitId' },
    ])
    .lean();

  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_ORDER_MESSAGES.ITEM_NOT_FOUND);
  }

  const productionData = item.productionData || {};
  const { productionManageMethod } = productionData;

  const response = {
    item: {
      _id: item._id,
      itemName: item.itemName,
      itemNo: item.itemNo,
      itemUnit: item.itemUnit,
      itemUnitId: item.itemUnitId,
    },
    warehouseId,
    productionData: {
      productionManageMethod: productionManageMethod || null,
    },
  };

  const mapRawMaterial = async rm => {
    const rmStock = rm.item?._id ? await getItemWarehouseStock(rm.item._id, warehouseId, companyId) : 0;

    return {
      item: rm.item
        ? {
            _id: rm.item._id,
            itemName: rm.item.itemName,
            itemNo: rm.item.itemNo,
            itemUnit: rm.item.itemUnit,
            itemUnitId: rm.item.itemUnitId,
          }
        : null,
      itemGroup: rm.itemGroup ? { _id: rm.itemGroup._id, name: rm.itemGroup.name } : null,
      itemUnitId: rm.itemUnitId || rm.item?.itemUnitId || null,
      qtyPerItem: rm.qtyPerItem ?? null,
      reject: rm.reject ?? null,
      return: rm.return ?? null,
      stock: rmStock,
    };
  };

  if (productionManageMethod === 'BOM_BASED') {
    const bomBased = productionData.bomBased || [];
    const productionScrapOutInventory = productionData.productionScrapOutInventory || [];

    response.bomBased = await Promise.all(bomBased.map(mapRawMaterial));

    response.productionScrapOutInventory = await Promise.all(
      productionScrapOutInventory.map(async scrap => {
        const scrapStock = scrap.scrapItemName?._id
          ? await getItemWarehouseStock(scrap.scrapItemName._id, warehouseId, companyId)
          : 0;

        return {
          scrapItemName: scrap.scrapItemName
            ? {
                _id: scrap.scrapItemName._id,
                itemName: scrap.scrapItemName.itemName,
                itemNo: scrap.scrapItemName.itemNo,
                itemUnit: scrap.scrapItemName.itemUnit,
                itemUnitId: scrap.scrapItemName.itemUnitId,
              }
            : null,
          itemUnitId: scrap.itemUnitId || scrap.scrapItemName?.itemUnitId || null,
          qtyPerItem: scrap.qtyPerItem ?? null,
          stock: scrapStock,
        };
      }),
    );
  }

  if (productionManageMethod === 'PROCESS_ROUTE') {
    const processBased = (productionData.processBased || []).filter(
      row => !processId || row.processId?.toString() === processId.toString(),
    );
    const processIds = processBased.map(row => row.processId).filter(Boolean);
    const processDocs = processIds.length
      ? await Process.find({ _id: { $in: processIds } })
          .select('name processId')
          .lean()
      : [];
    const processDocMap = new Map(processDocs.map(proc => [proc._id.toString(), proc]));

    response.processBased = await Promise.all(
      processBased.map(async row => ({
        processId: processDocMap.get(row.processId?.toString()) || row.processId || null,
        rawMaterials: await Promise.all((row.rawMaterials || []).map(mapRawMaterial)),
      })),
    );
  }

  return response;
};

const createProductionOrder = async (orderBody, userId) => {
  const { SalesOrder, Item } = getBooksCrmModels();
  const { ProductionOrder, InventoryTransferRequest } = getBooksModels();
  const session = await getClientConnection().startSession();

  try {
    await session.startTransaction();

    const productionItem = await Item.findOne({ _id: orderBody.itemId, companyId: orderBody.companyId }).session(session);

    if (!productionItem) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Production item not found.');
    }

    if (!(await isStockTrackedItem({ itemId: productionItem._id, companyId: orderBody.companyId, session }))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${PRODUCTION_ORDER_MESSAGES.FINISHED_GOOD_MUST_BE_STOCK}: ${productionItem.itemName}`,
      );
    }

    const untrackedRawMaterials = await getUntrackedProductionItems({
      itemIds: (orderBody.rawMaterials || []).map(rm => rm.rawMaterialId),
      companyId: orderBody.companyId,
      session,
    });
    if (untrackedRawMaterials.length) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${PRODUCTION_ORDER_MESSAGES.RAW_MATERIAL_MUST_BE_STOCK}: ${[...new Set(untrackedRawMaterials.map(i => i.itemName))].join(', ')}`,
      );
    }

    resolveUnitConversion(productionItem, orderBody.itemUnitId);
    orderBody.itemUnitId = orderBody.itemUnitId || productionItem.itemUnitId;
    if (Array.isArray(orderBody.rawMaterials)) {
      orderBody.rawMaterials = await applyRowUnits(orderBody.rawMaterials, 'rawMaterialId', orderBody.companyId, session);
    }

    orderBody.productionOrderCode = await generateUniqueId(
      ProductionOrder,
      orderBody?.companyId,
      MODULE_NAMES.PRODUCTION_ORDER,
      'productionOrderCode',
      'PRO',
      session,
      orderBody.productionOrderCode,
    );

    const newOrder = {
      ...orderBody,
      createdBy: userId,
      updatedBy: userId,
    };

    // Normalize raw material quantities to 2 decimals to prevent floating-point
    // artifacts (e.g. 2.4335500000000003) from leaking into ItemInventory/ItemBatch
    // once these figures are used to deduct/reserve stock.
    if (Array.isArray(newOrder.rawMaterials)) {
      newOrder.rawMaterials = newOrder.rawMaterials.map(rm => ({
        ...rm,
        perItemRequiredUnit: Math.round(Number(rm.perItemRequiredUnit) * 1000) / 1000,
        productionOrderRequiredUnit: Math.round(Number(rm.productionOrderRequiredUnit) * 1000) / 1000,
      }));
    }

    // Check for required warehouses if BOM_BASED
    if (newOrder.productionManageMethod === 'BOM_BASED') {
      if (!newOrder.inStockWarehouseId || !newOrder.productionWarehouseId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'inStockWarehouseId and productionWarehouseId are required for BOM_BASED production orders',
        );
      }
      // Set status to waiting for inventory approval for BOM_BASED orders
      newOrder.status = PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL;

      // Initialize tracking fields for partial submissions
      newOrder.totalFgSubmittedQty = 0;
      newOrder.totalFgRejectedQty = 0;
      newOrder.submissionHistory = [];
    } else {
      // Explicitly initialize for PROCESS_ROUTE (schema default handles this,
      // but being explicit prevents stale reads on older documents)
      newOrder.totalFgSubmittedQty = 0;
      newOrder.totalFgRejectedQty = 0;
    }

    const recipeName = newOrder.processBased?.recipeName;
    logProductionOrderActivity(newOrder, {
      action: PRODUCTION_ORDER_ACTIVITY_TYPE.ORDER_CREATED,
      description: `Production order created for ${newOrder.quantity} of ${productionItem.itemName}${
        recipeName ? ` · recipe ${recipeName}` : ''
      }`,
      userId,
      metadata: {
        itemId: productionItem._id,
        itemName: productionItem.itemName,
        quantity: newOrder.quantity,
        productionManageMethod: newOrder.productionManageMethod,
        recipeId: newOrder.processBased?.recipeId,
        recipeName,
      },
    });

    const productionOrder = await ProductionOrder.create([newOrder], { session });

    // Create InventoryTransferRequest if BOM_BASED
    if (newOrder.productionManageMethod === 'BOM_BASED') {
      const latestInventoryTransfer = await InventoryTransferRequest.findOne(
        { companyId: newOrder.companyId },
        { transferId: 1 },
        { sort: { createdAt: -1 } },
      ).session(session);

      let nextTransferNumber = 1;

      if (latestInventoryTransfer?.transferId) {
        const match = latestInventoryTransfer.transferId.match(/TRF(\d+)/);
        if (match) {
          nextTransferNumber = parseInt(match[1], 10) + 1;
        }
      }

      await InventoryTransferRequest.create(
        [
          {
            transferId: `TRF${nextTransferNumber}`,
            companyId: newOrder.companyId,
            itemId: newOrder.itemId,
            itemUnitId: newOrder.itemUnitId,
            fromWarehouseId: newOrder.inStockWarehouseId,
            toWarehouseId: newOrder.productionWarehouseId,
            quantity: newOrder.quantity,
            rawMaterials: newOrder.rawMaterials,
            isProductionOrderReq: true,
            productionOrderId: productionOrder[0]._id,
            referenceNumber: productionOrder[0].productionOrderCode,
            addedBy: userId,
            updatedBy: userId,
            date: new Date(),
          },
        ],
        { session },
      );
    }

    if (newOrder.salesOrderId) {
      await SalesOrder.findByIdAndUpdate(
        newOrder.salesOrderId,
        {
          productionOrderStatus: 'PARTIAL',
        },
        { new: true, session },
      );
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return productionOrder[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    session.endSession();
  }
};

const queryProductionOrders = async (query, filter, options) => {
  const { ProductionOrder, ManPower } = getBooksModels();
  const { Item, SalesOrder, Division, Branch, Warehouse } = getBooksCrmModels();

  if (filter?.status?.split(',').length > 0) {
    filter.status = {
      $in: filter.status.split(','),
    };
  }
  if (filter.productionDate) {
    const date = new Date(filter.productionDate);
    const startOfDay = new Date(date.setHours(0, 0, 0, 0));
    const endOfDay = new Date(date.setHours(23, 59, 59, 999));

    filter.productionDate = {
      $gte: startOfDay,
      $lte: endOfDay,
    };
  }

  if (filter.warehouseId) {
    const warehouseOrConditions = [
      { dispatchWarehouseId: new mongoose.Types.ObjectId(filter.warehouseId) },
      { inventoryInwarehouseId: new mongoose.Types.ObjectId(filter.warehouseId) },
      { inStockWarehouseId: new mongoose.Types.ObjectId(filter.warehouseId) },
      { productionWarehouseId: new mongoose.Types.ObjectId(filter.warehouseId) },
      { warehouseId: new mongoose.Types.ObjectId(filter.warehouseId) },
    ];

    filter.$and = filter.$and || [];
    filter.$and.push({ $or: warehouseOrConditions });

    delete filter.warehouseId;
  }

  // Division/Branch to Warehouse resolution
  if (filter.divisionId && !filter.branchId) {
    const divisionObjectId = new mongoose.Types.ObjectId(filter.divisionId);
    const branches = await Branch.find({ companyId: query.companyId, divisionId: divisionObjectId }).select('_id');
    const branchIds = branches.map(b => b._id);
    if (branchIds.length > 0) {
      const warehouses = await Warehouse.find({ companyId: query.companyId, branchId: { $in: branchIds } }).select('_id');
      const warehouseIds = warehouses.map(w => w._id);
      if (warehouseIds.length > 0) {
        const warehouseOrConditions = [
          { dispatchWarehouseId: { $in: warehouseIds } },
          { inventoryInwarehouseId: { $in: warehouseIds } },
          { inStockWarehouseId: { $in: warehouseIds } },
          { productionWarehouseId: { $in: warehouseIds } },
          { warehouseId: { $in: warehouseIds } },
        ];
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: warehouseOrConditions });
      }
    }
    delete filter.divisionId; // avoid double filtering
  }

  if (filter.divisionId && filter.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    const warehouses = await Warehouse.find({
      companyId: query.companyId,
      branchId: { $in: branchArray },
    }).select('_id');
    const warehouseIds = warehouses.map(w => w._id);
    if (warehouseIds.length > 0) {
      const warehouseOrConditions = [
        { dispatchWarehouseId: { $in: warehouseIds } },
        { inventoryInwarehouseId: { $in: warehouseIds } },
        { inStockWarehouseId: { $in: warehouseIds } },
        { productionWarehouseId: { $in: warehouseIds } },
        { warehouseId: { $in: warehouseIds } },
      ];
      filter.$and = filter.$and || [];
      filter.$and.push({ $or: warehouseOrConditions });
    }
    delete filter.divisionId;
    delete filter.branchId;
  }

  if (query.startDate && query.endDate) {
    const startDate = new Date(query.startDate);
    const endDate = new Date(query.endDate);

    // Check if dates are valid
    if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
      filter.productionDate = {
        $gte: startDate,
        $lte: endDate,
      };
    }
  }
  if (query.search) {
    const searchRegex = new RegExp(escapeRegex(query.search.trim()), 'i');

    // First find items that match the search term
    const matchingItems = await Item.find(
      {
        itemName: searchRegex,
      },
      {
        _id: 1,
      },
    );

    const matchingItemIds = matchingItems.map(item => item._id);

    const searchOrConditions = [{ productionOrderCode: searchRegex }, { itemId: { $in: matchingItemIds } }];
    filter.$and = filter.$and || [];
    filter.$and.push({ $or: searchOrConditions });
  }

  if (filter.itemGroupId) {
    const groupIds = filter.itemGroupId
      .split(',')
      .map(id => id.trim())
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));
    const groupItems = await Item.find({ itemGroup: { $in: groupIds }, companyId: query.companyId }, { _id: 1 });
    const groupItemIds = groupItems.map(item => item._id);
    filter.$and = filter.$and || [];
    filter.$and.push({ itemId: { $in: groupItemIds } });
    delete filter.itemGroupId;
  }

  if (filter.subItemGroupId) {
    const subGroupIds = filter.subItemGroupId
      .split(',')
      .map(id => id.trim())
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));
    const subGroupItems = await Item.find({ subItemGroup: { $in: subGroupIds }, companyId: query.companyId }, { _id: 1 });
    const subGroupItemIds = subGroupItems.map(item => item._id);
    filter.$and = filter.$and || [];
    filter.$and.push({ itemId: { $in: subGroupItemIds } });
    delete filter.subItemGroupId;
  }

  const activeOrConditions = [{ isActive: true }, { isActive: { $exists: false } }];
  filter.$and = filter.$and || [];
  filter.$and.push({ $or: activeOrConditions });
  // options.populate = "itemId:itemName itemNo, salesOrderId:orderId , divisionId:name, branchId:name, warehouseId:name, rawMaterials.rawMaterialId:itemName, processBased.processes.manPower.workerId:workerName, processBased.processes.processRawMaterialInput.item:itemName, processBased.processes.scrapOutProcess.item:itemName";

  // aggregate() bypasses Mongoose casting — cast string IDs to ObjectId manually
  const aggregateFilter = { ...filter };
  if (aggregateFilter.companyId) {
    aggregateFilter.companyId = new mongoose.Types.ObjectId(aggregateFilter.companyId);
  }

  // Status tile counts must ignore the status filter itself so all tiles stay visible
  // regardless of which status tab is currently selected.
  const statusCountFilter = { ...aggregateFilter };
  delete statusCountFilter.status;

  const [orders, summaryAgg, statusCountsAgg] = await Promise.all([
    ProductionOrder.paginate(filter, options),
    ProductionOrder.aggregate([
      { $match: aggregateFilter },
      {
        $group: {
          _id: null,
          totalPlanned: { $sum: '$quantity' },
          totalSubmitted: { $sum: '$totalFgSubmittedQty' },
          totalRejected: { $sum: '$totalFgRejectedQty' },
        },
      },
    ]),
    ProductionOrder.aggregate([{ $match: statusCountFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  orders.summary = summaryAgg[0]
    ? {
        totalPlanned: summaryAgg[0].totalPlanned || 0,
        totalSubmitted: summaryAgg[0].totalSubmitted || 0,
        totalRejected: summaryAgg[0].totalRejected || 0,
      }
    : { totalPlanned: 0, totalSubmitted: 0, totalRejected: 0 };

  const statusCountMap = statusCountsAgg.reduce((acc, item) => {
    acc[item._id] = item.count;
    return acc;
  }, {});
  const totalOrders = statusCountsAgg.reduce((sum, item) => sum + item.count, 0);

  orders.otherDetails = {
    totalOrders,
    pending: statusCountMap[PRODUCTION_ORDER_STATUS.PENDING] || 0,
    inProgress: statusCountMap[PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED] || 0,
    partiallyDone: statusCountMap[PRODUCTION_ORDER_STATUS.PARTIAL] || 0,
    completed: statusCountMap[PRODUCTION_ORDER_STATUS.COMPLETED] || 0,
    waitingForInventoryApproval: statusCountMap[PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL] || 0,
    onHold: statusCountMap[PRODUCTION_ORDER_STATUS.ON_HOLD] || 0,
    closed: statusCountMap[PRODUCTION_ORDER_STATUS.CLOSED] || 0,
  };

  // Get all unique IDs for population
  const itemIds = new Set();
  const salesOrderIds = new Set();
  const divisionIds = new Set();
  const branchIds = new Set();
  const warehouseIds = new Set();
  const dispatchWarehouseIds = new Set();
  const inStockWarehouseIds = new Set();
  const productionWarehouseIds = new Set();
  const inventoryInwarehouseIds = new Set();
  const rawMaterialIds = new Set();
  const workerIds = new Set();
  const nestedItemIds = new Set();
  const manPowerInventoryTransferIds = new Set();
  const productionOwnerIds = new Set();
  const manpowerCostIds = new Set();

  orders.results.forEach(order => {
    if (order.itemId) itemIds.add(order.itemId);

    if (order.salesOrderId) salesOrderIds.add(order.salesOrderId);

    if (order.divisionId) divisionIds.add(order.divisionId);

    if (order.branchId) branchIds.add(order.branchId);

    if (order.warehouseId) warehouseIds.add(order.warehouseId);

    if (order.dispatchWarehouseId) dispatchWarehouseIds.add(order.dispatchWarehouseId);

    if (order.inStockWarehouseId) inStockWarehouseIds.add(order.inStockWarehouseId);

    if (order.productionWarehouseId) productionWarehouseIds.add(order.productionWarehouseId);

    if (order.inventoryInwarehouseId) inventoryInwarehouseIds.add(order.inventoryInwarehouseId);
    if (order.productionOwnerIds) productionOwnerIds.add(order.productionOwnerId);
    order.rawMaterials?.forEach(rm => {
      if (rm.rawMaterialId) rawMaterialIds.add(rm.rawMaterialId);
    });
    // Collect raw material IDs from submission history
    order.submissionHistory?.forEach(submission => {
      submission.rawMaterialsConsumed?.forEach(rm => {
        if (rm.rawMaterialId) rawMaterialIds.add(rm.rawMaterialId);
      });
      // Collect manpowerCost IDs from submission history
      submission.manpowerCost?.forEach(mc => {
        if (mc.manpowerId) manpowerCostIds.add(mc.manpowerId);
      });
    });
    order?.processBased?.processes?.forEach(proc => {
      proc.manPower?.forEach(mp => {
        if (mp.workerId) workerIds.add(mp.workerId);
      });

      proc.processRawMaterialInput?.forEach(input => {
        if (input.item) nestedItemIds.add(input.item);
      });

      proc.scrapOutProcess?.forEach(scrap => {
        if (scrap.item) nestedItemIds.add(scrap.item);
      });
    });

    // Collect manPower_inventoryTransfer IDs
    order.manPower_inventoryTransfer?.forEach(manPowerId => {
      if (manPowerId) manPowerInventoryTransferIds.add(manPowerId);
    });

    if (order.productionOwner && Array.isArray(order.productionOwner)) {
      order.productionOwner.forEach(element => {
        if (element) productionOwnerIds.add(element);
      });
    }
  });

  // Fetch all referenced data in parallel
  const [
    items,
    salesOrders,
    divisions,
    branches,
    warehouses,
    dispatchWarehouses,
    inStockWarehouses,
    productionWarehouses,
    inventoryINWarehouses,
    rawMaterials,
    workers,
    nestedItems,
    manPowerInventoryTransfer,
    productionOwner,
    manpowerCostWorkers,
  ] = await Promise.all([
    Item.find({ _id: { $in: Array.from(itemIds) } }).select('itemName itemNo'),
    SalesOrder.find({ _id: { $in: Array.from(salesOrderIds) } }).select('orderId'),
    Division.find({ _id: { $in: Array.from(divisionIds) } }).select('name'),
    Branch.find({ _id: { $in: Array.from(branchIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(warehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(dispatchWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inStockWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(productionWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inventoryInwarehouseIds) } }).select('name'),
    Item.find({ _id: { $in: Array.from(rawMaterialIds) } }).select('itemName'),
    ManPower.find({ _id: { $in: Array.from(workerIds) } }).select('workerName'),
    Item.find({ _id: { $in: Array.from(nestedItemIds) } }).select('itemName'),
    ManPower.find({ _id: { $in: Array.from(manPowerInventoryTransferIds) } }).select('workerName'),
    ManPower.find({ _id: { $in: Array.from(productionOwnerIds) } }).select('workerName'),
    ManPower.find({
      _id: {
        $in: Array.from(manpowerCostIds),
      },
    }).select('workerName'),
  ]);

  // Create lookup maps
  const itemMap = new Map(items.map(item => [item._id.toString(), item]));
  const salesOrderMap = new Map(salesOrders.map(so => [so._id.toString(), so]));
  const divisionMap = new Map(divisions.map(div => [div._id.toString(), div]));
  const branchMap = new Map(branches.map(branch => [branch._id.toString(), branch]));
  const warehouseMap = new Map(warehouses.map(wh => [wh._id.toString(), wh]));
  const dispatchWarehouseMap = new Map(dispatchWarehouses.map(wh => [wh._id.toString(), wh]));
  const inStockWarehouseMap = new Map(inStockWarehouses.map(wh => [wh._id.toString(), wh]));
  const productionWarehouseMap = new Map(productionWarehouses.map(wh => [wh._id.toString(), wh]));
  const inventoryINWarehouseMap = new Map(inventoryINWarehouses.map(wh => [wh._id.toString(), wh]));
  const rawMaterialMap = new Map(rawMaterials.map(rm => [rm._id.toString(), rm]));
  const workerMap = new Map(workers.map(w => [w._id.toString(), w]));
  const nestedItemMap = new Map(nestedItems.map(i => [i._id.toString(), i]));
  const manPowerInventoryTransferMap = new Map(manPowerInventoryTransfer.map(mp => [mp._id.toString(), mp]));
  const productionOwnerMap = new Map(productionOwner.map(pq => [pq._id.toString(), pq]));
  const manpowerCostMap = new Map(manpowerCostWorkers.map(mp => [mp._id.toString(), mp]));
  // Populate the references in the results
  orders.results = orders.results.map(order => {
    const populatedOrder = order.toObject();

    if (order.itemId) {
      const item = itemMap.get(order.itemId.toString());
      if (item) {
        populatedOrder.itemId = {
          _id: item._id,
          itemName: item.itemName,
          itemNo: item.itemNo,
        };
      }
    }

    if (order.salesOrderId) {
      const salesOrder = salesOrderMap.get(order.salesOrderId.toString());
      if (salesOrder) {
        populatedOrder.salesOrderId = {
          _id: salesOrder._id,
          orderId: salesOrder.orderId,
        };
      }
    }

    if (order.divisionId) {
      const division = divisionMap.get(order.divisionId.toString());
      if (division) {
        populatedOrder.divisionId = {
          _id: division._id,
          name: division.name,
        };
      }
    }

    if (order.branchId) {
      const branch = branchMap.get(order.branchId.toString());
      if (branch) {
        populatedOrder.branchId = {
          _id: branch._id,
          name: branch.name,
        };
      }
    }

    if (order.warehouseId) {
      const warehouse = warehouseMap.get(order.warehouseId.toString());
      if (warehouse) {
        populatedOrder.warehouseId = {
          _id: warehouse._id,
          name: warehouse.name,
        };
      }
    }

    if (order.dispatchWarehouseId) {
      const dispatchWarehouse = dispatchWarehouseMap.get(order.dispatchWarehouseId.toString());
      if (dispatchWarehouse) {
        populatedOrder.dispatchWarehouseId = {
          _id: dispatchWarehouse._id,
          name: dispatchWarehouse.name,
        };
      }
    }

    if (order.inStockWarehouseId) {
      const inStockWarehouse = inStockWarehouseMap.get(order.inStockWarehouseId.toString());
      if (inStockWarehouse) {
        populatedOrder.inStockWarehouseId = {
          _id: inStockWarehouse._id,
          name: inStockWarehouse.name,
        };
      }
    }

    if (order.productionWarehouseId) {
      const productionWarehouse = productionWarehouseMap.get(order.productionWarehouseId.toString());
      if (productionWarehouse) {
        populatedOrder.productionWarehouseId = {
          _id: productionWarehouse._id,
          name: productionWarehouse.name,
        };
      }
    }

    if (order.inventoryInwarehouseId) {
      const inventoryINWarehouse = inventoryINWarehouseMap.get(order.inventoryInwarehouseId.toString());
      if (inventoryINWarehouse) {
        populatedOrder.inventoryInwarehouseId = {
          _id: inventoryINWarehouse._id,
          name: inventoryINWarehouse.name,
        };
      }
    }

    if (order.rawMaterials) {
      populatedOrder.rawMaterials = order.rawMaterials.map(rm => {
        const populatedRm = {
          ...rm.toObject(),
        };
        if (rm.rawMaterialId) {
          const rawMaterial = rawMaterialMap.get(rm.rawMaterialId.toString());
          if (rawMaterial) {
            populatedRm.rawMaterialId = {
              _id: rawMaterial._id,
              itemName: rawMaterial.itemName,
            };
          }
        }
        return populatedRm;
      });
    }

    // Populate rawMaterialsConsumed in submissionHistory
    if (order.submissionHistory) {
      populatedOrder.submissionHistory = order.submissionHistory.map(submission => {
        const populatedSubmission = {
          ...submission.toObject(),
        };
        if (submission.rawMaterialsConsumed) {
          populatedSubmission.rawMaterialsConsumed = submission.rawMaterialsConsumed.map(rm => {
            const populatedRm = {
              ...rm.toObject(),
            };
            if (rm.rawMaterialId) {
              const rawMaterial = rawMaterialMap.get(rm.rawMaterialId.toString());
              if (rawMaterial) {
                populatedRm.rawMaterialId = {
                  _id: rawMaterial._id,
                  itemName: rawMaterial.itemName,
                };
              }
            }
            return populatedRm;
          });
        }
        // Populate manpowerCost in submissionHistory
        if (submission.manpowerCost) {
          populatedSubmission.manpowerCost = submission.manpowerCost.map(mc => {
            const populatedMc = {
              ...mc.toObject(),
            };
            if (mc.manpowerId) {
              const worker = manpowerCostMap.get(mc.manpowerId.toString());
              if (worker) {
                populatedMc.manpowerId = {
                  _id: worker._id,
                  workerName: worker.workerName,
                };
              }
            }
            return populatedMc;
          });
        }
        return populatedSubmission;
      });
    }

    populatedOrder?.processBased?.processes?.forEach(proc => {
      // Populate manPower.workerId
      proc.manPower = proc.manPower?.map(mp => {
        const populatedMp = {
          ...mp,
        };
        if (mp.workerId) {
          const worker = workerMap.get(mp.workerId.toString());
          if (worker) {
            populatedMp.workerId = {
              _id: worker._id,
              workerName: worker.workerName,
            };
          }
        }
        return populatedMp;
      });

      // --- Populate productionOwner ---
      if (order.productionOwner) {
        populatedOrder.productionOwner = order.productionOwner.map(mpId => {
          const mp = productionOwnerMap.get(mpId.toString());
          if (mp) {
            return { _id: mp._id, workerName: mp.workerName };
          }
          return mpId;
        });
      }

      // Populate processRawMaterialInput.item
      proc.processRawMaterialInput = proc.processRawMaterialInput?.map(input => {
        const populatedInput = {
          ...input,
        };
        if (input.item) {
          const nestedItem = nestedItemMap.get(input.item.toString());
          if (nestedItem) {
            populatedInput.item = {
              _id: nestedItem._id,
              itemName: nestedItem.itemName,
            };
          }
        }
        return populatedInput;
      });

      // Populate scrapOutProcess.item
      proc.scrapOutProcess = proc.scrapOutProcess?.map(scrap => {
        const populatedScrap = {
          ...scrap,
        };
        if (scrap.item) {
          const nestedItem = nestedItemMap.get(scrap.item.toString());
          if (nestedItem) {
            populatedScrap.item = {
              _id: nestedItem._id,
              itemName: nestedItem.itemName,
            };
          }
        }
        return populatedScrap;
      });
    });

    // Populate manPower_inventoryTransfer
    if (order.manPower_inventoryTransfer) {
      populatedOrder.manPower_inventoryTransfer = order.manPower_inventoryTransfer.map(mpId => {
        const mp = manPowerInventoryTransferMap.get(mpId.toString());
        if (mp) {
          return { _id: mp._id, workerName: mp.workerName };
        }
        return mpId;
      });
    }

    const plannedQty = order.quantity || 0;
    const producedQty = order.totalFgSubmittedQty || 0;
    const rejectedQty = order.totalFgRejectedQty || 0;

    return {
      ...populatedOrder,
      plannedQty,
      producedQty,
      pendingQty: Math.max(roundQty(plannedQty - producedQty - rejectedQty), 0),
      id: order?._id,
    };
  });

  return orders;
};

const deductRawMaterialsForSubmission = async ({
  productionOrder,
  submission,
  updateBody,
  warehouseDetails,
  userId,
  session,
}) => {
  const submissionRawMaterialBatches = [];

  const hasRawMaterialConsumption = (updateBody.rawMaterials || []).some(
    rm => (rm.productionOrderSubmittedUnit || 0) + (rm.rejectQty || 0) > 0,
  );

  if (hasRawMaterialConsumption) {
    for (const [rmIndex, rmUpdate] of updateBody.rawMaterials.entries()) {
      const consumedQty = roundQty((rmUpdate.productionOrderSubmittedUnit || 0) + (rmUpdate.rejectQty || 0));

      if (consumedQty > 0) {
        const rm = findRootRawMaterial(productionOrder, rmUpdate.rawMaterialId, rmUpdate.itemUnitId);

        if (rm) {
          if (!rm.batches) {
            rm.batches = [];
          }

          const warehouseStockObj = {
            action: 'deductStock',
            stockData: {
              itemId: rmUpdate.rawMaterialId,
              companyId: productionOrder.companyId,
              branchId: warehouseDetails?.branchId,
              warehouseId: productionOrder.productionWarehouseId,
              quantity: consumedQty,
              itemUnitId: rmUpdate.itemUnitId,
              deductedSourceType: 'PRODUCTION_ORDER',
              deductedSourceId: productionOrder._id,
            },
            session,
          };

          let rmRunningStock = await getItemWarehouseStock(
            rmUpdate.rawMaterialId,
            productionOrder.productionWarehouseId,
            productionOrder.companyId,
            session,
          );

          const deductionSummary = await handleWarehouseStock(warehouseStockObj);

          for (const deducted of deductionSummary) {
            const rmStockBefore = rmRunningStock;
            const rmStockAfter = roundQty(rmStockBefore - deducted.quantity);
            rmRunningStock = rmStockAfter;
            logInventoryImpact(productionOrder, {
              event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.RAW_MATERIAL_CONSUMED,
              item: rmUpdate.rawMaterialId,
              itemBatchId: deducted.itemBatchId,
              warehouseId: deducted.warehouseId || productionOrder.productionWarehouseId,
              stockBefore: rmStockBefore,
              change: -deducted.quantity,
              stockAfter: rmStockAfter,
              userId,
              submissionId: submission._id,
            });
          }

          submissionRawMaterialBatches.push({
            rawMaterialId: rmUpdate.rawMaterialId,
            batches: deductionSummary,
          });

          rm.batches.push(...deductionSummary);

          submission.rawMaterialsConsumed[rmIndex].batches.push(...deductionSummary);
        }
      }
    }

    await checkCompanyStockLevels({
      itemIds: submissionRawMaterialBatches.map(b => b.rawMaterialId),
      companyId: productionOrder.companyId,
      docType: MODULE_NAMES.PRODUCTION_ORDER,
      docId: productionOrder._id,
      docNo: productionOrder.productionOrderCode,
      userId,
      session,
    });
  }

  return submissionRawMaterialBatches;
};

const batchCost = batches => (batches || []).reduce((sum, batch) => sum + (batch.quantity || 0) * (batch.purchasePrice || 0), 0);

// The cost of one BOM submission, and what each of its good units cost.
// Returned raw material went back to stock, so it is not in the batches and costs nothing.
const computeBomSubmissionCost = submission => {
  const goodQty = roundQty(submission.fgSubmittedQty || 0);
  const rejectedQty = roundQty(submission.fgRejectedQty || 0);
  const handledQty = roundQty(goodQty + rejectedQty);

  // Step 1: raw material, and the part of it written off with the rejected units
  let materialCost = 0;
  let rejectedMaterialCost = 0;
  const rejectedMaterials = [];
  for (const rawMaterial of submission.rawMaterialsConsumed || []) {
    const cost = batchCost(rawMaterial.batches);
    // Batches hold the main unit while reject/return are in the row's unit, so proportion against what was consumed in that unit.
    const batchQty = (rawMaterial.batches || []).reduce((sum, batch) => sum + (batch.quantity || 0), 0);
    const rowQty = (rawMaterial.productionOrderSubmittedUnit || 0) + (rawMaterial.rejectQty || 0);
    const qty = batchQty > 0 && rowQty > 0 ? rowQty : batchQty;
    const writtenOffCost = qty > 0 ? round2((cost / qty) * (rawMaterial.rejectQty || 0)) : 0;
    materialCost += cost;
    rejectedMaterialCost += writtenOffCost;
    rejectedMaterials.push({
      itemId: rawMaterial.rawMaterialId,
      writtenOffQty: rawMaterial.rejectQty || 0,
      returnedQty: rawMaterial.returnQty || 0,
      cost: writtenOffCost,
      returnedValue: qty > 0 ? (cost / qty) * (rawMaterial.returnQty || 0) : 0,
    });
  }

  // Step 2: labour and overhead went into every handled unit, good or rejected, so each gets an equal share
  const labourCost = (submission.manpowerCost || []).reduce((sum, worker) => sum + (worker.workerCost || 0), 0);
  const overheadCost = (submission.additionalCost || []).reduce((sum, cost) => sum + (cost.amount || 0), 0);
  const rejectedLabourCost = handledQty > 0 ? round2((labourCost / handledQty) * rejectedQty) : 0;
  const rejectedOverheadCost = handledQty > 0 ? round2((overheadCost / handledQty) * rejectedQty) : 0;

  // Step 3: each rejected part is rounded where it is worked out, so the rejected cost is exactly their sum;
  // good units take the rest
  const totalCost = materialCost + labourCost + overheadCost;
  const rejectedCost = round2(rejectedMaterialCost + rejectedLabourCost + rejectedOverheadCost);
  const goodUnitCost = goodQty > 0 ? (totalCost - rejectedCost) / goodQty : 0;

  return {
    goodQty,
    rejectedQty,
    labourCost,
    overheadCost,
    totalCost,
    rejectedCost,
    goodUnitCost,
    rejectedMaterials,
    rejectedLabourCost,
    rejectedOverheadCost,
  };
};

// Cost-to-date across all submissions of a BOM_BASED order, for its journal and its Cost Breakdown.
// Each submission (S1, S2 ...) is split between finished and rejected on its own, then the splits are added up.
const computeBomBasedCostToDate = productionOrder => {
  const rawMaterials = (productionOrder.rawMaterials || [])
    .filter(rawMaterial => rawMaterial.rawMaterialId)
    .map(rawMaterial => ({ itemId: rawMaterial.rawMaterialId, cost: batchCost(rawMaterial.batches) }));
  const scrap = (productionOrder.scrapOut || [])
    .filter(scrapItem => scrapItem.item)
    .map(scrapItem => ({ itemId: scrapItem.item, value: batchCost(scrapItem.batches) }));
  const rawMaterialCost = rawMaterials.reduce((sum, rawMaterial) => sum + rawMaterial.cost, 0);
  const scrapValue = scrap.reduce((sum, scrapItem) => sum + scrapItem.value, 0);

  let labourCost = 0;
  let overheadCost = 0;
  let finishedGoodsCost = 0;
  let productionLoss = 0;
  const rejectedMaterialsByItem = new Map();
  let rejectedLabourCost = 0;
  let rejectedOverheadCost = 0;
  for (const submission of productionOrder.submissionHistory || []) {
    const submissionCost = computeBomSubmissionCost(submission);
    labourCost += submissionCost.labourCost;
    overheadCost += submissionCost.overheadCost;

    // Rejected units carry what was spent on them; good units are valued at the batch price.
    finishedGoodsCost += submissionCost.goodQty * Math.max(round2(submissionCost.goodUnitCost), 0);
    productionLoss += submissionCost.rejectedCost;

    for (const material of submissionCost.rejectedMaterials) {
      if (!material.writtenOffQty && !material.returnedQty) continue;
      const key = String(material.itemId);
      const total = rejectedMaterialsByItem.get(key) || {
        itemId: material.itemId,
        writtenOffQty: 0,
        returnedQty: 0,
        cost: 0,
        returnedValue: 0,
      };
      total.writtenOffQty = roundQty(total.writtenOffQty + material.writtenOffQty);
      total.returnedQty = roundQty(total.returnedQty + material.returnedQty);
      total.cost += material.cost;
      total.returnedValue += material.returnedValue;
      rejectedMaterialsByItem.set(key, total);
    }
    rejectedLabourCost += submissionCost.rejectedLabourCost;
    rejectedOverheadCost += submissionCost.rejectedOverheadCost;
  }

  // What the rejected cost was spent on, for the Cost Breakdown; it does not feed the journal.
  const rejectedCostSplit = {
    materials: [...rejectedMaterialsByItem.values()],
    labourCost: rejectedLabourCost,
    overheadCost: rejectedOverheadCost,
  };

  return {
    rawMaterials,
    scrap,
    rawMaterialCost,
    scrapValue,
    labourCost,
    overheadCost,
    finishedGoodsCost,
    productionLoss,
    rejectedCostSplit,
  };
};

// Posts (or clears) the BOM_BASED order's ledger journal under sourceId: productionOrder._id -
// the same convention every other document module uses (invoice, bill, GRPO, credit/debit note,
// and PROCESS_ROUTE's own applyProcessRouteCompletionEffects all key their journal by their own
// document _id and delete-then-repost the whole thing on any edit) - instead of a separate journal
// per submission, which made a BOM_BASED order's ledger entries unreachable via its own id (the way
// GET /ledger/journal?sourceId=<productionOrderId> looks them up for every other source type).
// Call after a submission's stock effects (raw material deduction, scrap, FG) have been applied to
// the order's cumulative rawMaterials/scrapOut/submissionHistory/totalFgSubmittedQty.
const postBomBasedProductionLedger = async (productionOrder, companyId, userId, session) => {
  await ledgerService.deleteJournal(
    { companyId, sourceModule: LEDGER_SOURCE_MODULES.PRODUCTION, sourceId: productionOrder._id },
    session,
  );

  // Clean up stray entries from before this order-level convention, when each submission posted
  // (or tried to) its own journal under sourceId: submission._id - left in place, they'd sit
  // uncounted by the query above yet still land in the trial balance, double-counting this order's
  // activity once the consolidated journal above starts posting under the order's own id.
  const legacySubmissionIds = (productionOrder.submissionHistory || []).map(sub => sub._id).filter(Boolean);
  if (legacySubmissionIds.length) {
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.PRODUCTION, sourceId: { $in: legacySubmissionIds } },
      session,
    );
  }

  // No early return on a zero output: material consumed with nothing submitted yet still has to be
  // reported, and with no finished goods the whole cost reads as work in progress, which is what it is.
  const cumulativeFgQty = productionOrder.totalFgSubmittedQty || 0;
  const { rawMaterials, scrap, labourCost, overheadCost, productionLoss } = computeBomBasedCostToDate(productionOrder);

  const latestSubmission = productionOrder.submissionHistory?.[productionOrder.submissionHistory.length - 1];

  await ledgerService.postProductionJournal(
    {
      companyId,
      sourceId: productionOrder._id,
      postingDate: latestSubmission?.submissionDate || new Date(),
      narration: `Production ${productionOrder.productionOrderCode}`,
      finishedGoods:
        cumulativeFgQty > 0
          ? {
              itemId: productionOrder.itemId,
              quantity: cumulativeFgQty,
              unitCost: batchCost(productionOrder.batches) / cumulativeFgQty,
            }
          : null,
      rawMaterials,
      labourCost,
      overheadCost,
      scrap,
      productionLoss,
      isClosedOut: TERMINAL_PRODUCTION_STATUSES.includes(productionOrder.status),
      addedBy: userId,
    },
    session,
  );
};

const applySubmissionInventoryEffects = async ({ productionOrder, submission, updateBody, companyId, userId, session }) => {
  const { Item } = getBooksCrmModels();

  const newSubmittedQty = roundQty(updateBody.fgSubmittedQty || 0);

  const warehouseDetails = await getWarehouseDetails(productionOrder.productionWarehouseId, session);

  await deductRawMaterialsForSubmission({
    productionOrder,
    submission,
    updateBody,
    warehouseDetails,
    userId,
    session,
  });

  if (Array.isArray(updateBody.scrapOut) && updateBody.scrapOut.some(sc => sc.item && Number(sc.value) > 0)) {
    for (const [scrapIndex, scrap] of updateBody.scrapOut.entries()) {
      if (!scrap.item || typeof scrap.value !== 'number' || scrap.value <= 0) {
        continue; // Skip invalid entries instead of throwing an error
      }

      const scrapItem = await Item.findById(scrap.item).session(session);
      if (!scrapItem) {
        continue;
      }

      const warehouseStockObj = {
        action: 'addStock',
        stockData: {
          itemId: scrap.item,
          companyId: productionOrder.companyId,
          branchId: warehouseDetails?.branchId,
          divisionId: warehouseDetails?.divisionId,
          warehouseId: productionOrder.productionWarehouseId,
          quantity: scrap.value,
          itemUnitId: scrap.itemUnitId,
          purchasePrice: scrapItem.purchaseInformation?.costPrice || 0,
          rateIsBase: true,
          sourceType: 'PRODUCTION_ORDER',
          sourceId: productionOrder._id,
        },
        session,
      };

      const batchSummary = await handleWarehouseStock(warehouseStockObj);

      if (batchSummary && !batchSummary?.skipped) {
        const scrapBatchEntry = {
          batchNo: batchSummary.batchNo,
          quantity: batchSummary.quantity,
          purchasePrice: batchSummary.purchasePrice,
          warehouseId: productionOrder.productionWarehouseId,
          itemBatchId: batchSummary?._id,
        };
        submission.scrapOut[scrapIndex].batches.push(scrapBatchEntry);

        if (!productionOrder.scrapOut) {
          productionOrder.scrapOut = [];
        }
        let rootScrap = productionOrder.scrapOut.find(s => s.item?.toString() === scrap.item.toString());
        if (!rootScrap) {
          productionOrder.scrapOut.push({ item: scrap.item, itemUnitId: scrap.itemUnitId, totalScrapOutQty: 0, batches: [] });
          rootScrap = productionOrder.scrapOut[productionOrder.scrapOut.length - 1];
        }
        rootScrap.totalScrapOutQty = (rootScrap.totalScrapOutQty || 0) + batchSummary.quantity;
        rootScrap.batches.push(scrapBatchEntry);

        const scrapStockAfter = await getItemWarehouseStock(
          scrap.item,
          productionOrder.productionWarehouseId,
          productionOrder.companyId,
          session,
        );
        logInventoryImpact(productionOrder, {
          event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_BOOKED,
          item: scrap.item,
          itemBatchId: batchSummary._id,
          warehouseId: productionOrder.productionWarehouseId,
          stockBefore: roundQty(scrapStockAfter - batchSummary.quantity),
          change: batchSummary.quantity,
          stockAfter: scrapStockAfter,
          userId,
          submissionId: submission._id,
        });
      }
    }

    await checkCompanyStockLevels({
      itemIds: updateBody.scrapOut.filter(sc => sc.item && Number(sc.value) > 0).map(sc => sc.item),
      companyId: productionOrder.companyId,
      docType: MODULE_NAMES.PRODUCTION_ORDER,
      docId: productionOrder._id,
      docNo: productionOrder.productionOrderCode,
      userId,
      session,
    });
  }

  if (newSubmittedQty > 0) {
    const finishedGoodsItem = await Item.findById(productionOrder.itemId).session(session);
    if (finishedGoodsItem) {
      const finishedGoodsWarehouseDetails = await getWarehouseDetails(productionOrder.inventoryInwarehouseId, session);
      const finishedGoodsBranchId = finishedGoodsWarehouseDetails.branchId;
      const finishedGoodsDivisionId = finishedGoodsWarehouseDetails.divisionId;

      // This submission's good units at this submission's own cost per unit; other batches are untouched.
      // Per production-order unit: the warehouse converts it to the main-unit rate with the conversion factor.
      const purchasePricePerUnit = Math.max(round2(computeBomSubmissionCost(submission).goodUnitCost), 0);

      const warehouseStockObj = {
        action: 'addStock',
        stockData: {
          itemId: productionOrder.itemId,
          companyId: productionOrder.companyId,
          divisionId: finishedGoodsDivisionId,
          branchId: finishedGoodsBranchId,
          warehouseId: productionOrder.inventoryInwarehouseId,
          quantity: newSubmittedQty,
          itemUnitId: productionOrder.itemUnitId,
          purchasePrice: purchasePricePerUnit,
          sourceType: 'PRODUCTION_ORDER',
          sourceId: productionOrder._id,
        },
        session,
      };

      const batchSummary = await handleWarehouseStock(warehouseStockObj);

      if (batchSummary && !batchSummary?.skipped) {
        if (!productionOrder.batches) {
          productionOrder.batches = [];
        }
        productionOrder.batches.push({
          batchNo: batchSummary.batchNo,
          quantity: batchSummary.quantity,
          purchasePrice: batchSummary.purchasePrice,
          warehouseId: productionOrder.inventoryInwarehouseId,
          itemBatchId: batchSummary?._id,
        });
        submission.batches.push({
          batchNo: batchSummary.batchNo,
          quantity: batchSummary.quantity,
          purchasePrice: batchSummary.purchasePrice,
          warehouseId: productionOrder.inventoryInwarehouseId,
          itemBatchId: batchSummary?._id,
        });
        const fgStockAfter = await getItemWarehouseStock(
          productionOrder.itemId,
          productionOrder.inventoryInwarehouseId,
          productionOrder.companyId,
          session,
        );
        logInventoryImpact(productionOrder, {
          event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_POSTED,
          item: productionOrder.itemId,
          itemBatchId: batchSummary._id,
          warehouseId: productionOrder.inventoryInwarehouseId,
          stockBefore: roundQty(fgStockAfter - batchSummary.quantity),
          change: batchSummary.quantity,
          stockAfter: fgStockAfter,
          userId,
          submissionId: submission._id,
        });

        await checkCompanyStockLevels({
          itemIds: [productionOrder.itemId],
          companyId: productionOrder.companyId,
          docType: MODULE_NAMES.PRODUCTION_ORDER,
          docId: productionOrder._id,
          docNo: productionOrder.productionOrderCode,
          userId,
          session,
        });
      }
    }
  }

  await postBomBasedProductionLedger(productionOrder, companyId, userId, session);
};

const reverseRawMaterialConsumption = async (productionOrder, submission, companyId, userId, session) => {
  const touchedItemIds = new Set();

  for (const consumed of submission.rawMaterialsConsumed || []) {
    if (!consumed.rawMaterialId) continue;

    const rootRm = findRootRawMaterial(productionOrder, consumed.rawMaterialId, consumed.itemUnitId);

    for (const batchUse of consumed.batches || []) {
      if (!batchUse.itemBatchId || !batchUse.quantity) continue;

      const reversed = await reverseDeductionByBatch({
        stockData: {
          itemId: consumed.rawMaterialId,
          companyId,
          warehouseId: batchUse.warehouseId || productionOrder.productionWarehouseId,
          itemBatchId: batchUse.itemBatchId,
          quantity: batchUse.quantity,
          deductedSourceType: 'PRODUCTION_ORDER',
          deductedSourceId: productionOrder._id,
        },
        session,
      });

      if (reversed.remainingQty != null) {
        const rmReverseWarehouseId = batchUse.warehouseId || productionOrder.productionWarehouseId;
        const rmStockAfter = await getItemWarehouseStock(consumed.rawMaterialId, rmReverseWarehouseId, companyId, session);
        logInventoryImpact(productionOrder, {
          event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.RAW_MATERIAL_CONSUMPTION_DELETED,
          item: consumed.rawMaterialId,
          itemBatchId: batchUse.itemBatchId,
          warehouseId: rmReverseWarehouseId,
          stockBefore: roundQty(rmStockAfter - batchUse.quantity),
          change: batchUse.quantity,
          stockAfter: rmStockAfter,
          userId,
          submissionId: submission._id,
        });
      }

      touchedItemIds.add(consumed.rawMaterialId.toString());

      if (rootRm?.batches?.length) {
        const rootBatchIndex = rootRm.batches.findIndex(
          b => b.itemBatchId?.toString() === batchUse.itemBatchId.toString() && b.quantity === batchUse.quantity,
        );
        if (rootBatchIndex !== -1) rootRm.batches.splice(rootBatchIndex, 1);
      }
    }

    if (rootRm) {
      rootRm.productionOrderSubmittedUnit = Math.max(
        (rootRm.productionOrderSubmittedUnit || 0) - (consumed.productionOrderSubmittedUnit || 0),
        0,
      );
      rootRm.bomRRQty = Math.max((rootRm.bomRRQty || 0) - (consumed.bomRRQty || 0), 0);
      rootRm.rejectQty = Math.max((rootRm.rejectQty || 0) - (consumed.rejectQty || 0), 0);
      rootRm.returnQty = Math.max((rootRm.returnQty || 0) - (consumed.returnQty || 0), 0);
    }
  }

  return touchedItemIds;
};

const reverseSubmissionInventoryEffects = async (productionOrder, submission, companyId, userId, session) => {
  const touchedItemIds = await reverseRawMaterialConsumption(productionOrder, submission, companyId, userId, session);

  for (const batchUse of submission.batches || []) {
    if (!batchUse.itemBatchId) continue;

    const deleted = await deleteStockByBatchId({
      stockData: {
        itemId: productionOrder.itemId,
        companyId,
        warehouseId: batchUse.warehouseId || productionOrder.inventoryInwarehouseId,
        itemBatchId: batchUse.itemBatchId,
      },
      session,
    });

    if (deleted.removedStock > 0) {
      const fgDeleteWarehouseId = batchUse.warehouseId || productionOrder.inventoryInwarehouseId;
      const fgStockAfter = await getItemWarehouseStock(productionOrder.itemId, fgDeleteWarehouseId, companyId, session);
      logInventoryImpact(productionOrder, {
        event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_DELETED,
        item: productionOrder.itemId,
        itemBatchId: batchUse.itemBatchId,
        warehouseId: fgDeleteWarehouseId,
        stockBefore: roundQty(fgStockAfter + deleted.removedStock),
        change: -deleted.removedStock,
        stockAfter: fgStockAfter,
        userId,
        submissionId: submission._id,
      });
    }

    touchedItemIds.add(productionOrder.itemId.toString());

    const rootBatchIndex = (productionOrder.batches || []).findIndex(
      b => b.itemBatchId?.toString() === batchUse.itemBatchId.toString(),
    );
    if (rootBatchIndex !== -1) productionOrder.batches.splice(rootBatchIndex, 1);
  }

  for (const scrap of submission.scrapOut || []) {
    for (const batchUse of scrap.batches || []) {
      if (!batchUse.itemBatchId) continue;

      const deleted = await deleteStockByBatchId({
        stockData: {
          itemId: scrap.item,
          companyId,
          warehouseId: batchUse.warehouseId || productionOrder.productionWarehouseId,
          itemBatchId: batchUse.itemBatchId,
        },
        session,
      });

      if (deleted.removedStock > 0) {
        const scrapDeleteWarehouseId = batchUse.warehouseId || productionOrder.productionWarehouseId;
        const scrapStockAfter = await getItemWarehouseStock(scrap.item, scrapDeleteWarehouseId, companyId, session);
        logInventoryImpact(productionOrder, {
          event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_DELETED,
          item: scrap.item,
          itemBatchId: batchUse.itemBatchId,
          warehouseId: scrapDeleteWarehouseId,
          stockBefore: roundQty(scrapStockAfter + deleted.removedStock),
          change: -deleted.removedStock,
          stockAfter: scrapStockAfter,
          userId,
          submissionId: submission._id,
        });
      }

      const rootScrapIndex = (productionOrder.scrapOut || []).findIndex(s => s.item?.toString() === scrap.item?.toString());
      if (rootScrapIndex !== -1) {
        const rootScrap = productionOrder.scrapOut[rootScrapIndex];
        rootScrap.totalScrapOutQty = Math.max((rootScrap.totalScrapOutQty || 0) - (batchUse.quantity || 0), 0);
        const rootBatchIndex = rootScrap.batches.findIndex(b => b.itemBatchId?.toString() === batchUse.itemBatchId.toString());
        if (rootBatchIndex !== -1) rootScrap.batches.splice(rootBatchIndex, 1);
        if (!rootScrap.batches.length) {
          productionOrder.scrapOut.splice(rootScrapIndex, 1);
        }
      }

      if (scrap.item) touchedItemIds.add(scrap.item.toString());
    }
  }

  return touchedItemIds;
};

const submitProductionOrderrById = async (id, companyId, updateBody, userId) => {
  const { ProductionOrder } = getBooksModels();
  const connection = getClientConnection();

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const productionOrder = await ProductionOrder.findOne({ _id: id, companyId }).session(session);
    if (!productionOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
    }

    if (productionOrder.productionManageMethod !== 'BOM_BASED') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Partial submission only allowed for BOM_BASED production orders');
    }

    if (!productionOrder.productionWarehouseId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Production Warehouse not found');
    }
    if (!productionOrder.inventoryInwarehouseId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Finished Goods Warehouse not found');
    }

    if (
      productionOrder.status !== PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED &&
      productionOrder.status !== PRODUCTION_ORDER_STATUS.PARTIAL
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Production Order must be INVENTORY_ISSUED or PARTIAL for submission');
    }

    if (productionOrder.status === PRODUCTION_ORDER_STATUS.COMPLETED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Production Order already completed');
    }

    const currentTotalSubmitted = productionOrder.totalFgSubmittedQty || 0;
    const newSubmittedQty = roundQty(updateBody.fgSubmittedQty || 0);
    const totalSubmittedQty = roundQty(currentTotalSubmitted + newSubmittedQty);

    const currentTotalRejected = productionOrder.totalFgRejectedQty || 0;
    const newRejectedQty = roundQty(updateBody.fgRejectedQty || 0);
    const totalRejectedQty = roundQty(currentTotalRejected + newRejectedQty);

    if (newSubmittedQty === 0 && newRejectedQty === 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Please enter a finished quantity or rejected quantity before submitting. Both quantities cannot be 0.',
      );
    }

    const totalQuantity = totalSubmittedQty + totalRejectedQty;
    if (totalQuantity > productionOrder.quantity) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `The total submitted (${totalSubmittedQty}) and rejected (${totalRejectedQty}) quantity cannot be greater than the production order quantity of ${productionOrder.quantity}. Please adjust the quantities.`,
      );
    }

    await applySubmissionBodyUnits(updateBody, companyId, session);

    if (updateBody.rawMaterials && Array.isArray(updateBody.rawMaterials)) {
      const rmNameById = await getRawMaterialNameMap(updateBody.rawMaterials, session);
      for (const rm of updateBody.rawMaterials) {
        const rmName = rmNameById.get(String(rm.rawMaterialId)) || rm.rawMaterialId;
        const bomRRQty = rm.bomRRQty || 0;
        const rejectQty = rm.rejectQty || 0;
        const returnQty = rm.returnQty || 0;
        const sumRejectReturn = rejectQty + returnQty;

        if (Math.abs(Number(bomRRQty) - Number(sumRejectReturn)) > 1e-5) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `For raw material "${rmName}", the received quantity (${bomRRQty}) must equal the rejected quantity (${rejectQty}) plus the returned quantity (${returnQty}), which is ${sumRejectReturn}. Please check the quantities.`,
          );
        }
      }
    }

    const rawMaterialsWithConsumption = (updateBody.rawMaterials || []).filter(
      rm => (rm.productionOrderSubmittedUnit || 0) + (rm.rejectQty || 0) > 0,
    );

    if (rawMaterialsWithConsumption.length > 0) {
      await checkRawMaterialsStockAvailability({
        warehouseId: productionOrder.productionWarehouseId,
        rawMaterials: rawMaterialsWithConsumption,
        companyId: productionOrder.companyId,
        session,
        includeRejectQty: true,
        strictValidation: false,
      });
    }

    const submissionEntry = {
      submissionDate: new Date(),
      submittedBy: userId,
      fgSubmittedQty: newSubmittedQty,
      fgRejectedQty: newRejectedQty,
      batches: [],
      manpowerCost: (updateBody.manpowerCost || []).map(mc => ({
        manpowerId: mc.manpowerId,
        workerHours: mc.workerHours,
        workerCost: mc.workerCost,
      })),
      additionalCost: (updateBody.additionalCost || [])
        .filter(cost => cost && (cost.notes || cost.amount))
        .map(cost => ({
          notes: cost.notes || '',
          amount: cost.amount || 0,
        })),
      rawMaterialsConsumed: (updateBody.rawMaterials || []).map(rm => ({
        rawMaterialId: rm.rawMaterialId,
        itemUnitId: rm.itemUnitId,
        productionOrderSubmittedUnit: rm.productionOrderSubmittedUnit,
        bomRRQty: rm.bomRRQty || 0,
        rejectQty: rm.rejectQty || 0,
        returnQty: rm.returnQty || 0,
        batches: [],
      })),
      scrapOut: (updateBody.scrapOut || []).map(sc => ({
        item: sc.item,
        itemUnitId: sc.itemUnitId,
        value: sc.value,
        batches: [],
      })),
    };

    if (!productionOrder.submissionHistory) {
      productionOrder.submissionHistory = [];
    }
    productionOrder.submissionHistory.push(submissionEntry);
    const submission = productionOrder.submissionHistory[productionOrder.submissionHistory.length - 1];

    const existingScrapOut =
      productionOrder.scrapOut && productionOrder.scrapOut.length > 0
        ? productionOrder.scrapOut.map(sc => ({
            item: sc.item,
            totalScrapOutQty: sc.totalScrapOutQty || 0,
            batches: sc.batches && sc.batches.length > 0 ? [...sc.batches] : [],
          }))
        : [];

    // The order keeps every raw material it has used: this submission adds onto its matching row (or a new
    // row), never replaces the list - a row left out of this submission keeps its earlier batches and cost.
    const { rawMaterials: submittedRawMaterials, ...orderUpdate } = updateBody;
    Object.assign(productionOrder, orderUpdate);

    productionOrder.totalFgSubmittedQty = totalSubmittedQty;
    productionOrder.totalFgRejectedQty = totalRejectedQty;

    for (const rmUpdate of submittedRawMaterials || []) {
      const rootRm = findRootRawMaterial(productionOrder, rmUpdate.rawMaterialId, rmUpdate.itemUnitId);
      if (rootRm) {
        rootRm.productionOrderSubmittedUnit =
          (rootRm.productionOrderSubmittedUnit || 0) + (rmUpdate.productionOrderSubmittedUnit || 0);
        rootRm.bomRRQty = (rootRm.bomRRQty || 0) + (rmUpdate.bomRRQty || 0);
        rootRm.rejectQty = (rootRm.rejectQty || 0) + (rmUpdate.rejectQty || 0);
        rootRm.returnQty = (rootRm.returnQty || 0) + (rmUpdate.returnQty || 0);
      } else {
        productionOrder.rawMaterials.push({ ...rmUpdate, batches: [] });
      }
    }

    productionOrder.scrapOut = existingScrapOut;

    if (totalQuantity >= productionOrder.quantity) {
      productionOrder.status = PRODUCTION_ORDER_STATUS.COMPLETED;
    } else {
      productionOrder.status = PRODUCTION_ORDER_STATUS.PARTIAL;
    }

    logProductionOrderActivity(productionOrder, {
      action: PRODUCTION_ORDER_ACTIVITY_TYPE.FG_SUBMITTED,
      description: `Finished goods submitted${productionOrder.status === PRODUCTION_ORDER_STATUS.COMPLETED ? '' : ' (partial)'}`,
      userId,
      submissionId: submission._id,
      metadata: {
        fgSubmittedQty: newSubmittedQty,
        fgRejectedQty: newRejectedQty,
        resultingStatus: productionOrder.status,
      },
    });

    productionOrder.updatedBy = userId;

    await productionOrder.save({ session });

    if (productionOrder.productionManageMethod === 'BOM_BASED') {
      await applySubmissionInventoryEffects({ productionOrder, submission, updateBody, companyId, userId, session });

      await productionOrder.save({ session });
    }

    if (productionOrder.salesOrderId) {
      await syncSalesOrderProductionStatus(productionOrder.salesOrderId, productionOrder.companyId, session);
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    const updatedProductionOrder = await ProductionOrder.findById(id);
    return updatedProductionOrder;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
};

const deriveStatusFromTotals = (totalSubmittedQty, totalRejectedQty, quantity) => {
  const totalQuantity = (totalSubmittedQty || 0) + (totalRejectedQty || 0);
  if (totalQuantity >= quantity) return PRODUCTION_ORDER_STATUS.COMPLETED;
  if (totalQuantity > 0) return PRODUCTION_ORDER_STATUS.PARTIAL;
  return PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED;
};

const deleteSubmissionHistory = async (productionOrderId, companyId, submissionId, userId) => {
  const { ProductionOrder } = getBooksModels();
  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).session(session);
    if (!productionOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
    }

    if (productionOrder.productionManageMethod !== 'BOM_BASED') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Submission history is only applicable to BOM_BASED production orders');
    }

    if ([PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(productionOrder.status)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete a submission on a ${productionOrder.status.toLowerCase()} production order`,
      );
    }

    if (productionOrder.isManuallyCompleted) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete a submission on a manually completed production order');
    }

    const submission = productionOrder.submissionHistory.id(submissionId);
    if (!submission) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Submission not found on this production order');
    }

    await reverseSubmissionInventoryEffects(productionOrder, submission, companyId, userId, session);

    // Cleans up a legacy per-submission journal (pre-dating the order-level convention) for this
    // specific submission - it's about to be pulled from submissionHistory, so
    // postBomBasedProductionLedger's own legacy sweep below won't see its id any more.
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.PRODUCTION, sourceId: submissionId },
      session,
    );

    productionOrder.totalFgSubmittedQty = Math.max(
      roundQty((productionOrder.totalFgSubmittedQty || 0) - (submission.fgSubmittedQty || 0)),
      0,
    );
    productionOrder.totalFgRejectedQty = Math.max(
      roundQty((productionOrder.totalFgRejectedQty || 0) - (submission.fgRejectedQty || 0)),
      0,
    );

    productionOrder.submissionHistory.pull({ _id: submissionId });

    productionOrder.status = deriveStatusFromTotals(
      productionOrder.totalFgSubmittedQty,
      productionOrder.totalFgRejectedQty,
      productionOrder.quantity,
    );

    logProductionOrderActivity(productionOrder, {
      action: PRODUCTION_ORDER_ACTIVITY_TYPE.FG_SUBMISSION_DELETED,
      description: 'Finished goods submission deleted',
      userId,
      submissionId,
      metadata: {
        reversedFgSubmittedQty: submission.fgSubmittedQty || 0,
        reversedFgRejectedQty: submission.fgRejectedQty || 0,
      },
    });

    productionOrder.updatedBy = userId;
    await productionOrder.save({ session });

    await postBomBasedProductionLedger(productionOrder, companyId, userId, session);

    if (productionOrder.salesOrderId) {
      await syncSalesOrderProductionStatus(productionOrder.salesOrderId, productionOrder.companyId, session);
    }

    await flushCompanyStockLevels(session);
    await session.commitTransaction();

    return await ProductionOrder.findById(productionOrderId);
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const reconcileSubmissionOutputBatch = async ({
  existingBatch,
  itemId,
  companyId,
  warehouseId,
  branchId,
  divisionId,
  targetQuantity,
  purchasePrice,
  rateIsBase,
  itemUnitId,
  sourceType,
  sourceId,
  session,
  productionOrder,
  userId,
  submissionId,
  events,
}) => {
  if (existingBatch?.itemBatchId) {
    const adjusted = await adjustStockByBatchId({
      stockData: {
        itemId,
        companyId,
        warehouseId: existingBatch.warehouseId || warehouseId,
        itemBatchId: existingBatch.itemBatchId,
        newQuantity: targetQuantity,
        newPurchasePrice: purchasePrice,
        rateIsBase,
        itemUnitId,
      },
      session,
    });

    if (!adjusted?.itemBatchId || !adjusted.quantity) {
      if (adjusted?.removedStock > 0) {
        const deletedWarehouseId = existingBatch.warehouseId || warehouseId;
        const deletedStockAfter = await getItemWarehouseStock(itemId, deletedWarehouseId, companyId, session);
        logInventoryImpact(productionOrder, {
          event: events.deleted,
          item: itemId,
          itemBatchId: existingBatch.itemBatchId,
          warehouseId: deletedWarehouseId,
          stockBefore: roundQty(deletedStockAfter + adjusted.removedStock),
          change: -adjusted.removedStock,
          stockAfter: deletedStockAfter,
          userId,
          submissionId,
        });
      }
      return null;
    }

    const editedWarehouseId = existingBatch.warehouseId || warehouseId;
    // Batches hold the main unit; targetQuantity is in itemUnitId, so the change comes from the adjusted batch.
    const editedChange = roundQty(adjusted.quantity - existingBatch.quantity);
    const editedStockAfter = await getItemWarehouseStock(itemId, editedWarehouseId, companyId, session);
    logInventoryImpact(productionOrder, {
      event: events.edited,
      item: itemId,
      itemBatchId: adjusted.itemBatchId,
      warehouseId: editedWarehouseId,
      stockBefore: roundQty(editedStockAfter - editedChange),
      change: editedChange,
      stockAfter: editedStockAfter,
      userId,
      submissionId,
    });

    return {
      batchNo: adjusted.batchNo,
      quantity: adjusted.quantity,
      purchasePrice: adjusted.purchasePrice,
      warehouseId: existingBatch.warehouseId || warehouseId,
      itemBatchId: adjusted.itemBatchId,
    };
  }

  if (!targetQuantity || targetQuantity <= 0) return null;

  const batchSummary = await handleWarehouseStock({
    action: 'addStock',
    stockData: {
      itemId,
      companyId,
      branchId,
      divisionId,
      warehouseId,
      quantity: targetQuantity,
      itemUnitId,
      purchasePrice,
      rateIsBase,
      sourceType,
      sourceId,
    },
    session,
  });

  if (!batchSummary || batchSummary.skipped) return null;

  const createdStockAfter = await getItemWarehouseStock(itemId, warehouseId, companyId, session);
  logInventoryImpact(productionOrder, {
    event: events.created,
    item: itemId,
    itemBatchId: batchSummary._id,
    warehouseId,
    stockBefore: roundQty(createdStockAfter - batchSummary.quantity),
    change: batchSummary.quantity,
    stockAfter: createdStockAfter,
    userId,
    submissionId,
  });

  return {
    batchNo: batchSummary.batchNo,
    quantity: batchSummary.quantity,
    purchasePrice: batchSummary.purchasePrice,
    warehouseId,
    itemBatchId: batchSummary._id,
  };
};

const syncRootScrapOut = (productionOrder, itemId, existingBatch, reconciled) => {
  if (!existingBatch && !reconciled) return;
  if (!productionOrder.scrapOut) productionOrder.scrapOut = [];

  const qtyDelta = (reconciled?.quantity || 0) - (existingBatch?.quantity || 0);
  const rootIndex = productionOrder.scrapOut.findIndex(s => s.item?.toString() === itemId.toString());

  if (rootIndex === -1) {
    if (reconciled) {
      productionOrder.scrapOut.push({ item: itemId, totalScrapOutQty: reconciled.quantity, batches: [reconciled] });
    }
    return;
  }

  const rootScrap = productionOrder.scrapOut[rootIndex];
  rootScrap.totalScrapOutQty = Math.max((rootScrap.totalScrapOutQty || 0) + qtyDelta, 0);

  const rootBatchIndex = existingBatch?.itemBatchId
    ? rootScrap.batches.findIndex(b => b.itemBatchId?.toString() === existingBatch.itemBatchId.toString())
    : -1;

  if (reconciled) {
    if (rootBatchIndex !== -1) {
      rootScrap.batches[rootBatchIndex] = reconciled;
    } else {
      rootScrap.batches.push(reconciled);
    }
  } else if (rootBatchIndex !== -1) {
    rootScrap.batches.splice(rootBatchIndex, 1);
  }

  if (!rootScrap.batches.length) {
    productionOrder.scrapOut.splice(rootIndex, 1);
  }
};

const applySubmissionEdit = async ({
  productionOrder,
  oldFgBatch,
  oldScrapEntries,
  submission,
  updateBody,
  companyId,
  userId,
  session,
}) => {
  const { Item } = getBooksCrmModels();

  const newSubmittedQty = roundQty(updateBody.fgSubmittedQty || 0);
  const warehouseDetails = await getWarehouseDetails(productionOrder.productionWarehouseId, session);

  await deductRawMaterialsForSubmission({
    productionOrder,
    submission,
    updateBody,
    warehouseDetails,
    userId,
    session,
  });

  // The same scrap item can be on several lines (different units), each owning its own batch. Pair every submitted
  // line with the old batch of the same item + unit first, then with any left of the same item; whatever old batch
  // is left over belongs to a removed line.
  const oldScrapPool = (oldScrapEntries || [])
    .filter(sc => sc.item && sc.batches?.length)
    .map(sc => ({ itemId: sc.item.toString(), unitKey: String(sc.itemUnitId ?? ''), batch: sc.batches[0] }));
  const newScrapItemIds = new Set((updateBody.scrapOut || []).filter(sc => sc.item).map(sc => sc.item.toString()));
  const existingScrapBatchByIndex = new Map();
  const claimOldScrap = (scrapIndex, scrap, sameUnitOnly) => {
    if (existingScrapBatchByIndex.has(scrapIndex)) return;
    const entry = oldScrapPool.find(
      old => old.itemId === scrap.item.toString() && (!sameUnitOnly || old.unitKey === String(scrap.itemUnitId ?? '')),
    );
    if (!entry) return;
    oldScrapPool.splice(oldScrapPool.indexOf(entry), 1);
    existingScrapBatchByIndex.set(scrapIndex, entry.batch);
  };
  for (const sameUnitOnly of [true, false]) {
    (updateBody.scrapOut || []).forEach((scrap, scrapIndex) => {
      if (scrap.item) claimOldScrap(scrapIndex, scrap, sameUnitOnly);
    });
  }

  if (Array.isArray(updateBody.scrapOut)) {
    for (const [scrapIndex, scrap] of updateBody.scrapOut.entries()) {
      if (!scrap.item) continue;

      const targetQty = typeof scrap.value === 'number' && scrap.value > 0 ? scrap.value : 0;
      const existingBatch = existingScrapBatchByIndex.get(scrapIndex);
      if (targetQty <= 0 && !existingBatch) continue;

      const scrapItem = await Item.findById(scrap.item).session(session);
      const reconciled = await reconcileSubmissionOutputBatch({
        existingBatch,
        itemId: scrap.item,
        companyId: productionOrder.companyId,
        warehouseId: productionOrder.productionWarehouseId,
        branchId: warehouseDetails?.branchId,
        divisionId: warehouseDetails?.divisionId,
        targetQuantity: targetQty,
        itemUnitId: scrap.itemUnitId,
        purchasePrice: scrapItem?.purchaseInformation?.costPrice || 0,
        rateIsBase: true,
        sourceType: 'PRODUCTION_ORDER',
        sourceId: productionOrder._id,
        session,
        productionOrder,
        userId,
        submissionId: submission._id,
        events: {
          edited: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_EDITED,
          created: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_BOOKED,
          deleted: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_DELETED,
        },
      });

      syncRootScrapOut(productionOrder, scrap.item, existingBatch, reconciled);

      if (reconciled) {
        submission.scrapOut[scrapIndex].batches.push(reconciled);
      }
    }
  }

  const removedScrapItemIds = new Set();
  for (const { itemId: itemIdStr, batch: existingBatch } of oldScrapPool) {
    removedScrapItemIds.add(itemIdStr);
    await reconcileSubmissionOutputBatch({
      existingBatch,
      itemId: itemIdStr,
      companyId: productionOrder.companyId,
      warehouseId: productionOrder.productionWarehouseId,
      targetQuantity: 0,
      session,
      productionOrder,
      userId,
      submissionId: submission._id,
      events: {
        edited: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_EDITED,
        created: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_BOOKED,
        deleted: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_DELETED,
      },
    });

    syncRootScrapOut(productionOrder, itemIdStr, existingBatch, null);
  }

  const scrapTouchedItemIds = [...new Set([...newScrapItemIds, ...removedScrapItemIds])];
  if (scrapTouchedItemIds.length) {
    await checkCompanyStockLevels({
      itemIds: scrapTouchedItemIds,
      companyId: productionOrder.companyId,
      docType: MODULE_NAMES.PRODUCTION_ORDER,
      docId: productionOrder._id,
      docNo: productionOrder.productionOrderCode,
      userId,
      session,
    });
  }

  const finishedGoodsItem = await Item.findById(productionOrder.itemId).session(session);
  if (finishedGoodsItem) {
    // Per production-order unit; the warehouse converts it to the main-unit rate with the conversion factor.
    const purchasePricePerUnit = Math.max(round2(computeBomSubmissionCost(submission).goodUnitCost), 0);

    const finishedGoodsWarehouseDetails = await getWarehouseDetails(productionOrder.inventoryInwarehouseId, session);

    const reconciledFg = await reconcileSubmissionOutputBatch({
      existingBatch: oldFgBatch,
      itemId: productionOrder.itemId,
      companyId: productionOrder.companyId,
      warehouseId: productionOrder.inventoryInwarehouseId,
      branchId: finishedGoodsWarehouseDetails?.branchId,
      divisionId: finishedGoodsWarehouseDetails?.divisionId,
      targetQuantity: newSubmittedQty,
      itemUnitId: productionOrder.itemUnitId,
      purchasePrice: purchasePricePerUnit,
      sourceType: 'PRODUCTION_ORDER',
      sourceId: productionOrder._id,
      session,
      productionOrder,
      userId,
      submissionId: submission._id,
      events: {
        edited: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_EDITED,
        created: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_POSTED,
        deleted: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_DELETED,
      },
    });

    if (!productionOrder.batches) productionOrder.batches = [];
    const rootIndex = oldFgBatch?.itemBatchId
      ? productionOrder.batches.findIndex(b => b.itemBatchId?.toString() === oldFgBatch.itemBatchId.toString())
      : -1;

    if (reconciledFg) {
      if (rootIndex !== -1) {
        productionOrder.batches[rootIndex] = reconciledFg;
      } else {
        productionOrder.batches.push(reconciledFg);
      }

      submission.batches.push(reconciledFg);
    } else if (rootIndex !== -1) {
      productionOrder.batches.splice(rootIndex, 1);
    }

    await checkCompanyStockLevels({
      itemIds: [productionOrder.itemId],
      companyId: productionOrder.companyId,
      docType: MODULE_NAMES.PRODUCTION_ORDER,
      docId: productionOrder._id,
      docNo: productionOrder.productionOrderCode,
      userId,
      session,
    });
  }

  await postBomBasedProductionLedger(productionOrder, companyId, userId, session);
};

const editSubmissionHistory = async (productionOrderId, companyId, submissionId, updateBody, userId) => {
  const { ProductionOrder } = getBooksModels();
  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).session(session);
    if (!productionOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
    }

    if (productionOrder.productionManageMethod !== 'BOM_BASED') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Submission history is only applicable to BOM_BASED production orders');
    }
    if ([PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(productionOrder.status)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot edit a submission on a ${productionOrder.status.toLowerCase()} production order`,
      );
    }

    if (productionOrder.isManuallyCompleted) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot edit a submission on a manually completed production order');
    }
    if (!productionOrder.productionWarehouseId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Production Warehouse not found');
    }
    if (!productionOrder.inventoryInwarehouseId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Finished Goods Warehouse not found');
    }

    const submission = productionOrder.submissionHistory.id(submissionId);
    if (!submission) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Submission not found on this production order');
    }

    const oldFgBatch = submission.batches?.[0] ? { ...submission.batches[0].toObject() } : null;
    const oldScrapEntries = (submission.scrapOut || []).map(sc => sc.toObject());
    const oldFgSubmittedQty = submission.fgSubmittedQty || 0;
    const oldFgRejectedQty = submission.fgRejectedQty || 0;

    await reverseRawMaterialConsumption(productionOrder, submission, companyId, userId, session);

    const baseTotalSubmitted = Math.max(
      roundQty((productionOrder.totalFgSubmittedQty || 0) - (submission.fgSubmittedQty || 0)),
      0,
    );
    const baseTotalRejected = Math.max(roundQty((productionOrder.totalFgRejectedQty || 0) - (submission.fgRejectedQty || 0)), 0);

    const newSubmittedQty = roundQty(updateBody.fgSubmittedQty || 0);
    const newRejectedQty = roundQty(updateBody.fgRejectedQty || 0);

    if (newSubmittedQty === 0 && newRejectedQty === 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Please enter a finished quantity or rejected quantity before submitting. Both quantities cannot be 0.',
      );
    }

    const totalSubmittedQty = roundQty(baseTotalSubmitted + newSubmittedQty);
    const totalRejectedQty = roundQty(baseTotalRejected + newRejectedQty);
    const totalQuantity = totalSubmittedQty + totalRejectedQty;

    if (totalQuantity > productionOrder.quantity) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `The total submitted (${totalSubmittedQty}) and rejected (${totalRejectedQty}) quantity cannot be greater than the production order quantity of ${productionOrder.quantity}. Please adjust the quantities.`,
      );
    }

    await applySubmissionBodyUnits(updateBody, companyId, session);

    if (updateBody.rawMaterials && Array.isArray(updateBody.rawMaterials)) {
      const rmNameById = await getRawMaterialNameMap(updateBody.rawMaterials, session);
      for (const rm of updateBody.rawMaterials) {
        const rmName = rmNameById.get(String(rm.rawMaterialId)) || rm.rawMaterialId;
        const bomRRQty = rm.bomRRQty || 0;
        const rejectQty = rm.rejectQty || 0;
        const returnQty = rm.returnQty || 0;
        const sumRejectReturn = rejectQty + returnQty;

        if (Math.abs(Number(bomRRQty) - Number(sumRejectReturn)) > 1e-5) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `For raw material "${rmName}", the received quantity (${bomRRQty}) must equal the rejected quantity (${rejectQty}) plus the returned quantity (${returnQty}), which is ${sumRejectReturn}. Please check the quantities.`,
          );
        }
      }
    }

    const rawMaterialsWithConsumption = (updateBody.rawMaterials || []).filter(
      rm => (rm.productionOrderSubmittedUnit || 0) + (rm.rejectQty || 0) > 0,
    );
    if (rawMaterialsWithConsumption.length > 0) {
      await checkRawMaterialsStockAvailability({
        warehouseId: productionOrder.productionWarehouseId,
        rawMaterials: rawMaterialsWithConsumption,
        companyId: productionOrder.companyId,
        session,
        includeRejectQty: true,
        strictValidation: false,
      });
    }

    submission.fgSubmittedQty = newSubmittedQty;
    submission.fgRejectedQty = newRejectedQty;
    submission.batches = [];
    submission.manpowerCost = (updateBody.manpowerCost || []).map(mc => ({
      manpowerId: mc.manpowerId,
      workerHours: mc.workerHours,
      workerCost: mc.workerCost,
    }));
    submission.additionalCost = (updateBody.additionalCost || [])
      .filter(cost => cost && (cost.notes || cost.amount))
      .map(cost => ({
        notes: cost.notes || '',
        amount: cost.amount || 0,
      }));
    submission.rawMaterialsConsumed = (updateBody.rawMaterials || []).map(rm => ({
      rawMaterialId: rm.rawMaterialId,
      itemUnitId: rm.itemUnitId,
      productionOrderSubmittedUnit: rm.productionOrderSubmittedUnit,
      bomRRQty: rm.bomRRQty || 0,
      rejectQty: rm.rejectQty || 0,
      returnQty: rm.returnQty || 0,
      batches: [],
    }));
    submission.scrapOut = (updateBody.scrapOut || []).map(sc => ({
      item: sc.item,
      itemUnitId: sc.itemUnitId,
      value: sc.value,
      batches: [],
    }));

    if (updateBody.rawMaterials && Array.isArray(updateBody.rawMaterials)) {
      for (const rmUpdate of updateBody.rawMaterials) {
        const rootRm = findRootRawMaterial(productionOrder, rmUpdate.rawMaterialId, rmUpdate.itemUnitId);
        if (rootRm) {
          rootRm.productionOrderSubmittedUnit =
            (rootRm.productionOrderSubmittedUnit || 0) + (rmUpdate.productionOrderSubmittedUnit || 0);
          rootRm.bomRRQty = (rootRm.bomRRQty || 0) + (rmUpdate.bomRRQty || 0);
          rootRm.rejectQty = (rootRm.rejectQty || 0) + (rmUpdate.rejectQty || 0);
          rootRm.returnQty = (rootRm.returnQty || 0) + (rmUpdate.returnQty || 0);
        } else {
          productionOrder.rawMaterials.push({ ...rmUpdate, batches: [] });
        }
      }
    }

    productionOrder.totalFgSubmittedQty = totalSubmittedQty;
    productionOrder.totalFgRejectedQty = totalRejectedQty;
    productionOrder.status = deriveStatusFromTotals(totalSubmittedQty, totalRejectedQty, productionOrder.quantity);

    logProductionOrderActivity(productionOrder, {
      action: PRODUCTION_ORDER_ACTIVITY_TYPE.FG_SUBMISSION_EDITED,
      description: 'Finished goods submission edited',
      userId,
      submissionId: submission._id,
      metadata: {
        fgSubmittedQty: { from: oldFgSubmittedQty, to: newSubmittedQty },
        fgRejectedQty: { from: oldFgRejectedQty, to: newRejectedQty },
        resultingStatus: productionOrder.status,
      },
    });

    productionOrder.updatedBy = userId;
    await productionOrder.save({ session });

    await applySubmissionEdit({
      productionOrder,
      oldFgBatch,
      oldScrapEntries,
      submission,
      updateBody,
      companyId,
      userId,
      session,
    });
    await productionOrder.save({ session });

    if (productionOrder.salesOrderId) {
      await syncSalesOrderProductionStatus(productionOrder.salesOrderId, productionOrder.companyId, session);
    }

    await flushCompanyStockLevels(session);
    await session.commitTransaction();

    return await ProductionOrder.findById(productionOrderId);
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const removeMultipleItemStocks = async (stockData, session) => {
  const { warehouseId, rawMaterialArray, companyId, referenceNumber, notes, userId, divisionId, branchId, createdAt, _id } =
    stockData;
  const { Item, Warehouse, ItemHistory, ItemInventory } = getBooksCrmModels();
  const { ItemBatch, ProductionOrder } = getBooksModels();

  let shouldEndSession = false;

  if (!session) {
    const connection = await getClientConnection();
    if (!connection) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
    }
    session = await connection.startSession();
    session.startTransaction();
    shouldEndSession = true;
  }

  try {
    for (const rawMaterial of rawMaterialArray) {
      const { rawMaterialId, productionOrderSubmittedUnit, rejectQty } = rawMaterial;

      if (!(await isStockTrackedItem({ itemId: rawMaterialId, companyId, session }))) {
        continue;
      }

      const newProductionOrderSubmittedUnit = productionOrderSubmittedUnit + rejectQty;

      if (newProductionOrderSubmittedUnit <= 0) {
        continue;
      }

      const item = await ItemInventory.findOne({ itemId: rawMaterialId, companyId })
        .populate({
          path: 'itemId',
          select: 'itemName',
        })
        .session(session);

      if (!item) {
        throw new ApiError(httpStatus.NOT_FOUND, `Raw material item not found: ${item?.itemId?.itemName}`);
      }

      const isExist = await Warehouse.findById(warehouseId).session(session);
      if (!isExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Warehouse not found');
      }

      const warehouse = item.warehouses.find(b => b.warehouseId.equals(warehouseId));

      if (!warehouse || warehouse.availableStock < newProductionOrderSubmittedUnit) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Insufficient available stock in warehouse ${isExist.name} for raw material ${item?.itemId?.itemName}`,
        );
      }

      warehouse.availableStock -= newProductionOrderSubmittedUnit;

      const itemPrice = await Item.findById(rawMaterialId).session(session);
      const rawMaterialCost = itemPrice.purchaseInformation?.costPrice || 0;
      const amount = rawMaterialCost * newProductionOrderSubmittedUnit;
      await ItemHistory.create(
        [
          {
            companyId,
            itemId: rawMaterialId,
            warehouseId: warehouseId,
            effectType: 'OUT',
            referenceType: 'ProductionOrder',
            referenceId: _id,
            refNo: referenceNumber,
            rate: rawMaterialCost,
            amount: amount,
            quantity: newProductionOrderSubmittedUnit,
            divisionId: divisionId,
            branchId: branchId,
            date: createdAt,
          },
        ],
        { session },
      );

      item.totalAvailableStock = item.warehouses.reduce((sum, w) => sum + w.availableStock, 0);

      await item.save({ session });
    }

    if (shouldEndSession) {
      await flushCompanyStockLevels(session);
      await session.commitTransaction();
      session.endSession();
    }

    return { success: true, message: 'Raw material stocks successfully reduced' };
  } catch (error) {
    if (shouldEndSession) {
      await session.abortTransaction();
      session.endSession();
    }
    console.error('Error reducing raw material stock:', error);
    throw error;
  }
};

// Parked, not wired up: this was an attempt to replace removeMultipleItemStocks with a single
// conditional $inc on ItemInventory, so the stock check and the decrement happen atomically
// instead of read-then-write. It has never had a caller and is not exported.
//
// It cannot simply be swapped in as it stands: it touches ItemInventory only and writes no
// ItemBatch deductions, so consumption would stop being traceable to a batch and every
// downstream cost that reads batches — production costing, COGS on the finished goods — would
// come out at zero. Kept because the atomicity idea is worth finishing; finish the batch side
// first.
// const OptimizedremoveMultipleItemStocks = async (stockData, session) => {
//   const { warehouseId, rawMaterialArray, companyId, referenceNumber, notes, userId, divisionId, branchId, createdAt, _id } =
//     stockData;
//
//   const { Item, Warehouse, ItemInventory } = getBooksCrmModels();
//
//   let shouldEndSession = false;
//
//   if (!session) {
//     const connection = await getClientConnection();
//     if (!connection) {
//       throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
//     }
//     session = await connection.startSession();
//     await session.startTransaction();
//     shouldEndSession = true;
//   }
//
//   try {
//     const warehouse = await Warehouse.findById(warehouseId).session(session);
//     if (!warehouse) {
//       throw new ApiError(httpStatus.NOT_FOUND, 'Warehouse not found');
//     }
//
//     for (const rawMaterial of rawMaterialArray) {
//       const { rawMaterialId, productionOrderSubmittedUnit = 0, rejectQty = 0 } = rawMaterial;
//
//       if (!(await isStockTrackedItem({ itemId: rawMaterialId, companyId, session }))) {
//         continue;
//       }
//
//       const newProductionOrderSubmittedUnit = productionOrderSubmittedUnit + rejectQty;
//
//       if (newProductionOrderSubmittedUnit <= 0) continue;
//
//       // ✅ ATOMIC stock validation + deduction (NO read-before-write)
//       const updateResult = await ItemInventory.updateOne(
//         {
//           itemId: rawMaterialId,
//           companyId,
//           'warehouses.warehouseId': warehouseId,
//           'warehouses.availableStock': { $gte: newProductionOrderSubmittedUnit },
//         },
//         [
//           {
//             $set: {
//               warehouses: {
//                 $map: {
//                   input: '$warehouses',
//                   as: 'w',
//                   in: {
//                     $cond: [
//                       { $eq: ['$$w.warehouseId', warehouseId] },
//                       {
//                         $mergeObjects: [
//                           '$$w',
//                           {
//                             availableStock: {
//                               $subtract: ['$$w.availableStock', newProductionOrderSubmittedUnit],
//                             },
//                           },
//                         ],
//                       },
//                       '$$w',
//                     ],
//                   },
//                 },
//               },
//             },
//           },
//           {
//             $set: {
//               totalAvailableStock: { $sum: '$warehouses.availableStock' },
//             },
//           },
//         ],
//         { session },
//       );
//
//       // ✅ SAME condition as before, just enforced safely
//       if (updateResult.matchedCount === 0) {
//         throw new ApiError(httpStatus.BAD_REQUEST, `Insufficient available stock in warehouse ${warehouse.name}`);
//       }
//     }
//
//     if (shouldEndSession) {
//       await flushCompanyStockLevels(session);
//       await session.commitTransaction();
//       await session.endSession();
//     }
//
//     return {
//       success: true,
//       message: 'Raw material stocks successfully reduced',
//     };
//   } catch (error) {
//     if (shouldEndSession) {
//       await session.abortTransaction();
//       await session.endSession();
//     }
//     throw error;
//   }
// };

// A PROCESS_ROUTE order is PARTIAL once any process has started, and falls back to PENDING
// if it was PARTIAL and none has. Only touches PENDING / INVENTORY_ISSUED / PARTIAL - COMPLETED,
// ON_HOLD, CLOSED etc. are owned by their own flows.
const syncProcessRouteOrderStatus = productionOrder => {
  const { PENDING, INVENTORY_ISSUED, PARTIAL } = PRODUCTION_ORDER_STATUS;
  if (![PENDING, INVENTORY_ISSUED, PARTIAL].includes(productionOrder.status)) {
    return;
  }
  const anyStarted = (productionOrder.processBased?.processes || []).some(p => p.startDatetime);
  if (anyStarted) {
    productionOrder.status = PARTIAL;
  } else if (productionOrder.status === PARTIAL) {
    productionOrder.status = PENDING;
  }
};

const startProcess = async ({ productionOrderId, processId, companyId }, userId) => {
  const { ProductionOrder } = getBooksModels();
  const productionOrder = await ProductionOrder.findOne({
    _id: productionOrderId,
    'processBased.processes._id': processId,
    companyId,
  });

  if (!productionOrder) {
    throw new ApiError(httpStatus.NOT_FOUND, 'productionOrder or Process not found');
  }

  if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Starting a process is only applicable to PROCESS_ROUTE production orders');
  }

  if (
    [PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.COMPLETED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(
      productionOrder.status,
    )
  ) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot start a process on a ${productionOrder.status.toLowerCase()} production order`,
    );
  }

  const process = productionOrder?.processBased.processes.id(processId);
  if (!process) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Process not found');
  }

  if (process.startDatetime) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This process has already been started and cannot be started again.');
  }

  const isFirstProcess = productionOrder.processBased.processes[0]?._id.toString() === processId;
  if (isFirstProcess) {
    process.processIN = productionOrder.quantity;
  } else if (!process.processIN) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This process cannot be started because the previous process has not produced any output yet. Please complete the previous process first.',
    );
  }

  process.startDatetime = new Date();
  process.startedBy = userId;
  process.status = PROCESS_STATUS.IN_PROGRESS;
  syncProcessRouteOrderStatus(productionOrder);

  logProductionOrderActivity(productionOrder, {
    action: PRODUCTION_ORDER_ACTIVITY_TYPE.PROCESS_STARTED,
    description: `${process.processName || 'Process'} started`,
    userId,
    processId: process._id,
    metadata: { processIN: process.processIN },
  });

  productionOrder.updatedBy = userId;

  await productionOrder.save();

  return productionOrder;
};

const endProcess = async ({ productionOrderId, processId, companyId }, processData, userId) => {
  const { ProductionOrder } = getBooksModels();
  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.withTransaction(async () => {
      const productionOrder = await ProductionOrder.findOne({
        _id: productionOrderId,
        'processBased.processes._id': processId,
        companyId,
      }).session(session);

      if (!productionOrder) {
        throw new ApiError(httpStatus.NOT_FOUND, 'productionOrder or Process not found');
      }

      if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE') {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Ending a process is only applicable to PROCESS_ROUTE production orders');
      }

      if (
        [PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.COMPLETED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(
          productionOrder.status,
        )
      ) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot end a process on a ${productionOrder.status.toLowerCase()} production order`,
        );
      }

      const processes = productionOrder.processBased.processes;
      const process = processes.id(processId);
      if (!process) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Process not found');
      }

      if (process.endDatetime) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Process already completed');
      }

      // Manual completion is allowed from any pre-completion state - PENDING (never started),
      // IN_PROGRESS, or PARTIALLY_COMPLETED - not just after an explicit startProcess call.
      if (!process.startDatetime) {
        process.startDatetime = new Date();
        process.startedBy = userId;
      }

      const currentProcessIndex = processes.findIndex(p => p._id.toString() === processId);
      const previousProcess = currentProcessIndex > 0 ? processes[currentProcessIndex - 1] : null;
      const nextProcess = processes[currentProcessIndex + 1] || null;

      if (previousProcess && !previousProcess.endDatetime) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot end process. Previous process "${previousProcess.processName || `Process ${currentProcessIndex}`}" must be completed first.`,
        );
      }

      process.processIN = currentProcessIndex === 0 ? productionOrder.quantity : previousProcess.processOUT || 0;

      if (process.processIN <= 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot end process. Previous process "${
            previousProcess?.processName || `Process ${currentProcessIndex}`
          }" has not produced any output yet.`,
        );
      }

      const pendingQty =
        Math.round((process.processIN - (process.processOUT || 0) - (process.processRejection || 0)) * 1000) / 1000;
      if (pendingQty <= 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'This process has no remaining input left to complete.');
      }

      if (!process.submissionHistory) {
        process.submissionHistory = [];
      }
      process.submissionHistory.push({
        submissionDate: new Date(),
        submittedBy: userId,
        isManuallyCompleted: true,
        processIN: process.processIN,
        processOUT: 0,
        processRejection: 0,
        totalUsedUnit: 0,
        processRawMaterialInput: [],
        manPower: [],
        scrapOutProcess: [],
        remarks: processData.remarks || 'Process manually completed without submission details',
      });
      const submission = process.submissionHistory[process.submissionHistory.length - 1];

      // Unaccounted pending qty is dropped, not pushed forward - only what was actually
      // submitted as output for this process carries over to the next process's input.
      process.status = PROCESS_STATUS.COMPLETED;
      process.endDatetime = new Date();
      submission.status = process.status;

      if (nextProcess) {
        nextProcess.processIN = process.processOUT || 0;
      }

      logProductionOrderActivity(productionOrder, {
        action: PRODUCTION_ORDER_ACTIVITY_TYPE.PROCESS_COMPLETED,
        description: `${process.processName || 'Process'} manually completed`,
        userId,
        processId: process._id,
        submissionId: submission._id,
        metadata: { pendingQtyDropped: pendingQty },
      });

      productionOrder.updatedBy = userId;

      if (currentProcessIndex === processes.length - 1) {
        productionOrder.status = PRODUCTION_ORDER_STATUS.COMPLETED;
      }
      // Counted even while the order is unfinished, so partial output still becomes stock.
      productionOrder.totalFgSubmittedQty = roundQty(processes[processes.length - 1]?.processOUT);
      productionOrder.totalFgRejectedQty = roundQty(processes.reduce((sum, p) => sum + (p.processRejection || 0), 0));
      // Posted on every process, not only the last: material leaves the warehouse at the first one, so
      // waiting until the order finishes leaves that cost reported nowhere in between.
      await applyProcessRouteCompletionEffects({ productionOrder, userId, session });
      syncProcessRouteOrderStatus(productionOrder);

      await productionOrder.save({ session });

      if (productionOrder.salesOrderId) {
        await syncSalesOrderProductionStatus(productionOrder.salesOrderId, productionOrder.companyId, session);
      }
    });

    await flushCompanyStockLevels(session);
  } catch (error) {
    throw error;
  } finally {
    await session.endSession();
  }
};

const assertSubmissionScrapUnused = async ({ submission, companyId, session }) => {
  const scrapBatchIds = [];
  for (const scrap of submission.scrapOutProcess || []) {
    for (const batchUse of scrap.batches || []) {
      if (batchUse.itemBatchId) scrapBatchIds.push(batchUse.itemBatchId);
    }
  }
  if (!scrapBatchIds.length) return;

  const { ItemBatch, Item } = getBooksCrmModels();
  const batches = await ItemBatch.find({ _id: { $in: scrapBatchIds }, companyId })
    .select('itemId batchNo deductions')
    .session(session)
    .lean();

  const usedBatches = batches.filter(batch => (batch.deductions || []).length > 0);
  if (!usedBatches.length) return;

  const items = await Item.find({ _id: { $in: usedBatches.map(batch => batch.itemId) } })
    .select('itemName')
    .session(session)
    .lean();
  const itemNameById = new Map(items.map(item => [item._id.toString(), item.itemName]));

  const details = usedBatches.map(batch => {
    const issuedQty = Math.round(batch.deductions.reduce((sum, d) => sum + (d.quantityDeducted || 0), 0) * 1000) / 1000;
    const usedIn = [...new Set(batch.deductions.map(d => d.deductedSourceType).filter(Boolean))].join(', ');
    return `${itemNameById.get(batch.itemId.toString()) || 'Item'} (batch #${batch.batchNo}): ${issuedQty} unit(s) already issued${
      usedIn ? ` via ${usedIn}` : ''
    }`;
  });
  throw new ApiError(httpStatus.BAD_REQUEST, `${PRODUCTION_ORDER_MESSAGES.SUBMISSION_SCRAP_IN_USE} ${details.join('; ')}`);
};

const summarizeProcessRouteCost = productionOrder => {
  const batchValue = batches =>
    (batches || []).reduce((sum, batch) => sum + (batch.quantity || 0) * (batch.purchasePrice || 0), 0);
  const materialCostByItem = new Map();
  const scrapValueByItem = new Map();
  let labourCost = 0;
  let overheadCost = 0;

  // Units queue at a process carrying the cost already spent on them. A submission takes the units it
  // handled off the front of that queue, adds its own cost, and passes the survivors to the next
  // process at the new rate. So cost booked in one submission never reaches units a different
  // submission handled, units still waiting keep the cost they arrived with, and what is rejected
  // drops out instead of moving on. Oldest units are taken first, the order they were produced in.
  // Each lot also keeps its cost per unit split by part (each raw material, labour, overhead), only so a
  // rejected unit's cost can be shown per raw material; unitCost stays the figure everything else uses.
  const addCost = (costByPart, part, cost) => costByPart.set(part, (costByPart.get(part) || 0) + cost);

  // Takes the oldest units first and reports what they cost, with whatever is still waiting.
  const takeOldest = (waiting, wanted) => {
    let left = wanted;
    let cost = 0;
    const costByPart = new Map();
    const rest = [];
    for (const lot of waiting) {
      const used = Math.min(lot.qty, left);
      cost += used * lot.unitCost;
      for (const [part, partUnitCost] of lot.unitCostByPart) addCost(costByPart, part, used * partUnitCost);
      left = roundQty(left - used);
      if (lot.qty > used) {
        rest.push({ qty: roundQty(lot.qty - used), unitCost: lot.unitCost, unitCostByPart: lot.unitCostByPart });
      }
    }
    return { cost, costByPart, rest };
  };

  let queue = [];
  let productionLoss = 0;
  const rejectedCostByPart = new Map();
  const rejectedCostByProcess = new Map();

  for (const [index, routeProcess] of (productionOrder.processBased?.processes || []).entries()) {
    // The first process draws on the order's own units, which carry nothing until a submission
    // books cost against them; every later one draws on what the process before it passed out.
    if (index === 0) queue = [{ qty: roundQty(routeProcess.processIN), unitCost: 0, unitCostByPart: new Map() }];

    const passedOn = [];
    // Read per submission, not off the process, so the totals the journal credits and the rates the
    // units are costed at come from one place and cannot drift apart.
    for (const submission of routeProcess.submissionHistory || []) {
      let own = 0;
      const ownCostByPart = new Map();
      for (const input of submission.processRawMaterialInput || []) {
        const cost = batchValue(input.batches);
        if (!cost || !input.item) continue;
        own += cost;
        const key = input.item.toString();
        materialCostByItem.set(key, (materialCostByItem.get(key) || 0) + cost);
        addCost(ownCostByPart, key, cost);
      }
      for (const worker of submission.manPower || []) {
        labourCost += worker.workerCost || 0;
        own += worker.workerCost || 0;
        addCost(ownCostByPart, 'labour', worker.workerCost || 0);
      }
      for (const cost of submission.additionalCost || []) {
        overheadCost += cost.amount || 0;
        own += cost.amount || 0;
        addCost(ownCostByPart, 'overhead', cost.amount || 0);
      }
      for (const scrap of submission.scrapOutProcess || []) {
        const value = batchValue(scrap.batches);
        if (!value || !scrap.item) continue;
        const key = scrap.item.toString();
        scrapValueByItem.set(key, (scrapValueByItem.get(key) || 0) + value);
      }

      const handledQty = roundQty((submission.processOUT || 0) + (submission.processRejection || 0));
      if (handledQty <= 0) continue;

      const taken = takeOldest(queue, handledQty);
      queue = taken.rest;

      // Step 1: what the handled units cost, per part: the cost they arrived with plus this submission's own
      const costByPart = new Map();
      for (const [part, cost] of taken.costByPart) addCost(costByPart, part, cost);
      for (const [part, cost] of ownCostByPart) addCost(costByPart, part, cost);

      // Step 2: rejected units take their share of each part, rounded where it is worked out,
      // so the rejected cost is exactly the sum of its parts
      const rejectedQty = roundQty(submission.processRejection);
      const submissionRejectedCostByPart = new Map();
      let rejectedCost = 0;
      for (const [part, cost] of costByPart) {
        const rejectedPartCost = round2((cost / handledQty) * rejectedQty);
        submissionRejectedCostByPart.set(part, rejectedPartCost);
        rejectedCost += rejectedPartCost;
        if (rejectedPartCost) addCost(rejectedCostByPart, part, rejectedPartCost);
      }
      productionLoss += rejectedCost;
      addCost(rejectedCostByProcess, String(routeProcess._id), rejectedCost);

      // Step 3: the units passed on to the next process carry everything the rejected ones did not
      const passedOnQty = roundQty(submission.processOUT);
      if (passedOnQty <= 0) continue;

      const passedOnUnitCostByPart = new Map();
      for (const [part, cost] of costByPart) {
        passedOnUnitCostByPart.set(part, (cost - submissionRejectedCostByPart.get(part)) / passedOnQty);
      }
      passedOn.push({
        qty: passedOnQty,
        unitCost: (taken.cost + own - rejectedCost) / passedOnQty,
        unitCostByPart: passedOnUnitCostByPart,
        submissionId: submission._id,
      });
    }
    // Anything still queued stays at this process; the journal's balancing line reports it as work
    // in progress, since it is cost that is neither finished nor lost.
    queue = passedOn;
  }

  const carried = queue.reduce((sum, lot) => sum + lot.qty * round2(lot.unitCost), 0);

  // What the rejected cost was spent on, for the Cost Breakdown; it does not feed the journal.
  const rejectedCostSplit = {
    materials: [],
    labourCost: rejectedCostByPart.get('labour') || 0,
    overheadCost: rejectedCostByPart.get('overhead') || 0,
  };
  for (const [part, cost] of rejectedCostByPart) {
    if (part !== 'labour' && part !== 'overhead') rejectedCostSplit.materials.push({ itemId: part, cost });
  }

  return {
    materialCostByItem,
    scrapValueByItem,
    labourCost,
    overheadCost,
    productionLoss,
    finishedGoodsCost: carried,
    finishedLots: queue,
    rejectedCostSplit,
    rejectedCostByProcess,
  };
};

const applyProcessRouteCompletionEffects = async ({ productionOrder, userId, session }) => {
  const { companyId } = productionOrder;

  const cost = summarizeProcessRouteCost(productionOrder);
  const producedQty = roundQty(productionOrder.totalFgSubmittedQty);

  await ledgerService.deleteJournal(
    { companyId, sourceModule: LEDGER_SOURCE_MODULES.PRODUCTION, sourceId: productionOrder._id },
    session,
  );

  // Each last-process submission owns its finished-goods batch (submission.batches, as on BOM), priced
  // at that submission's own cost per unit; submit creates it, edit corrects that same batch.
  const processes = productionOrder.processBased?.processes || [];
  const finishingSubmissions = processes[processes.length - 1]?.submissionHistory || [];
  const finishedGoodsItemDoc = await getBooksCrmModels()
    .Item.findById(productionOrder.itemId)
    .select('itemName itemUnitId unitConversions')
    .session(session)
    .lean();
  for (const submission of finishingSubmissions) {
    const existingBatch = submission.batches?.[0];
    const targetQuantity = roundQty(submission.processOUT);
    const fgFactor = resolveUnitConversion(finishedGoodsItemDoc, productionOrder.itemUnitId);
    // The price handed to the batch is per production-order unit. The stored batch summary is in the main unit
    // (quantity and rate), so the unchanged check compares in the main unit.
    const purchasePrice = round2(cost.finishedLots.find(lot => lot.submissionId?.equals(submission._id))?.unitCost);
    const unchanged = existingBatch
      ? existingBatch.quantity === roundQty(targetQuantity * fgFactor) &&
        Math.abs(existingBatch.purchasePrice - purchasePrice / fgFactor) < 1e-6
      : !targetQuantity;
    if (unchanged) continue;

    if (!productionOrder.inventoryInwarehouseId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Finished Goods Warehouse not found');
    }
    const warehouseDetails = await getWarehouseDetails(productionOrder.inventoryInwarehouseId, session);

    const reconciled = await reconcileSubmissionOutputBatch({
      existingBatch,
      itemId: productionOrder.itemId,
      companyId,
      warehouseId: productionOrder.inventoryInwarehouseId,
      branchId: warehouseDetails?.branchId,
      divisionId: warehouseDetails?.divisionId,
      targetQuantity,
      itemUnitId: productionOrder.itemUnitId,
      purchasePrice,
      sourceType: 'PRODUCTION_ORDER',
      sourceId: productionOrder._id,
      session,
      productionOrder,
      userId,
      submissionId: submission._id,
      events: {
        edited: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_EDITED,
        created: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_POSTED,
        deleted: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_DELETED,
      },
    });

    submission.batches = reconciled ? [reconciled] : [];

    await checkCompanyStockLevels({
      itemIds: [productionOrder.itemId],
      companyId,
      docType: MODULE_NAMES.PRODUCTION_ORDER,
      docId: productionOrder._id,
      docNo: productionOrder.productionOrderCode,
      userId,
      session,
    });
  }
  // The order-level list is every finishing submission's batch.
  productionOrder.batches = finishingSubmissions.flatMap(submission => submission.batches.map(batch => batch.toObject()));

  // The journal carries every unit produced so far, not just this submission's, because it is rebuilt whole each
  // time. Valued at what the batches added to stock; any paisa against the computed cost goes to rounding.
  const finishedGoods =
    producedQty > 0
      ? { itemId: productionOrder.itemId, quantity: producedQty, unitCost: batchCost(productionOrder.batches) / producedQty }
      : null;

  // Dated by the latest submission rather than by when this ran, so re-posting an old order does not
  // drag its cost into the current period. Same rule as the BOM side.
  const latestSubmissionDate = (productionOrder.processBased?.processes || [])
    .flatMap(routeProcess => routeProcess.submissionHistory || [])
    .reduce((latest, sub) => (sub.submissionDate > latest ? sub.submissionDate : latest), null);

  await ledgerService.postProductionJournal(
    {
      companyId,
      sourceId: productionOrder._id,
      postingDate: latestSubmissionDate || new Date(),
      narration: `Production ${productionOrder.productionOrderCode}`,
      finishedGoods,
      rawMaterials: [...cost.materialCostByItem.entries()].map(([itemId, materialCost]) => ({ itemId, cost: materialCost })),
      labourCost: cost.labourCost,
      overheadCost: cost.overheadCost,
      scrap: [...cost.scrapValueByItem.entries()].map(([itemId, value]) => ({ itemId, value })),
      productionLoss: cost.productionLoss,
      isClosedOut: TERMINAL_PRODUCTION_STATUSES.includes(productionOrder.status),
      addedBy: userId,
    },
    session,
  );
};

const submitProcess = async ({ productionOrderId, processId, companyId }, processData, userId) => {
  const { ProductionOrder } = getBooksModels();

  const connection = getClientConnection();

  const session = await connection.startSession();

  try {
    await session.withTransaction(async () => {
      const productionOrder = await ProductionOrder.findOne({
        _id: productionOrderId,
        'processBased.processes._id': processId,
        companyId,
      }).session(session);

      if (!productionOrder) {
        throw new ApiError(httpStatus.NOT_FOUND, 'productionOrder or Process not found');
      }

      await applyProcessBodyUnits(processData, companyId, session);

      if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE') {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Submitting a process is only applicable to PROCESS_ROUTE production orders');
      }

      if (
        [PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.COMPLETED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(
          productionOrder.status,
        )
      ) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot submit a process on a ${productionOrder.status.toLowerCase()} production order`,
        );
      }

      const process = productionOrder?.processBased.processes.id(processId);
      if (!process) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Process not found');
      }

      if (!process.startDatetime) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Process has not been started yet');
      }

      if (process.endDatetime) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Process already completed');
      }

      const processes = productionOrder?.processBased.processes;
      const currentProcessIndex = processes.findIndex(p => p._id.toString() === processId);
      const previousProcess = currentProcessIndex > 0 ? processes[currentProcessIndex - 1] : null;
      const nextProcess = processes[currentProcessIndex + 1] || null;

      if (previousProcess && !previousProcess.startDatetime) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot submit process. Previous process "${
            previousProcess.processName || `Process ${currentProcessIndex}`
          }" has not been started yet.`,
        );
      }

      process.processIN = currentProcessIndex === 0 ? productionOrder.quantity : previousProcess.processOUT || 0;

      const newProcessOut = processData.processOUT || 0;
      const newProcessRejection = processData.processRejection || 0;

      if (newProcessOut === 0 && newProcessRejection === 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Please enter a quantity for either Output or Rejected Quantity. At least one must be greater than 0.',
        );
      }

      const totalOut = roundQty((process.processOUT || 0) + newProcessOut);
      const totalRejection = roundQty((process.processRejection || 0) + newProcessRejection);
      const totalQuantity = totalOut + totalRejection;

      if (totalQuantity > process.processIN) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `The total output (${totalOut}) and rejected quantity (${totalRejection}) cannot be greater than the available process input of ${process.processIN}. Please adjust the quantities.`,
        );
      }

      const additionalCosts = [].concat(processData.additionalCost || []).filter(cost => cost && (cost.notes || cost.amount));

      if (!process.submissionHistory) {
        process.submissionHistory = [];
      }
      process.submissionHistory.push({
        submissionDate: new Date(),
        submittedBy: userId,
        processIN: process.processIN,
        processOUT: newProcessOut,
        processRejection: newProcessRejection,
        totalUsedUnit: processData.totalUsedUnit || 0,
        processRawMaterialInput: (processData.processRawMaterialInput || []).map(input => ({
          item: input.item,
          itemUnitId: input.itemUnitId,
          value: input.value,
          batches: [],
        })),
        manPower: processData.manPower || [],
        scrapOutProcess: (processData.scrapOutProcess || []).map(scrap => ({
          item: scrap.item,
          itemUnitId: scrap.itemUnitId,
          value: scrap.value,
          batches: [],
        })),
        additionalCost: additionalCosts.map(cost => ({
          notes: cost.notes || '',
          amount: cost.amount || 0,
        })),
        remarks: processData.remarks || '',
      });
      const submission = process.submissionHistory[process.submissionHistory.length - 1];

      productionOrder.updatedBy = userId;

      if (!process.processRawMaterialInput) {
        process.processRawMaterialInput = [];
      }
      for (const consumed of processData.processRawMaterialInput || []) {
        if (!consumed.item) continue;
        const existing = process.processRawMaterialInput.find(rm => rm.item?.toString() === consumed.item.toString());
        if (existing) {
          existing.value = (existing.value || 0) + (consumed.value || 0);
        } else {
          process.processRawMaterialInput.push({
            item: consumed.item,
            itemUnitId: consumed.itemUnitId,
            value: consumed.value || 0,
            batches: [],
          });
        }
      }

      if (!process.scrapOutProcess) {
        process.scrapOutProcess = [];
      }
      for (const scrap of submission.scrapOutProcess || []) {
        if (!scrap.item) continue;
        const existing = process.scrapOutProcess.find(s => s.item?.toString() === scrap.item.toString());
        if (existing) {
          existing.value = (existing.value || 0) + (scrap.value || 0);
        } else {
          process.scrapOutProcess.push({ item: scrap.item, itemUnitId: scrap.itemUnitId, value: scrap.value || 0, batches: [] });
        }
      }

      if (!process.manPower) {
        process.manPower = [];
      }
      for (const worker of processData.manPower || []) {
        if (!worker.workerId) continue;
        const existing = process.manPower.find(mp => mp.workerId?.toString() === worker.workerId.toString());
        if (existing) {
          existing.salaryPerHour = worker.salaryPerHour ?? existing.salaryPerHour;
          existing.workerHours = (existing.workerHours || 0) + (worker.workerHours || 0);
          existing.workerCost = (existing.workerCost || 0) + (worker.workerCost || 0);
        } else {
          process.manPower.push({
            workerId: worker.workerId,
            salaryPerHour: worker.salaryPerHour,
            workerHours: worker.workerHours || 0,
            workerCost: worker.workerCost || 0,
          });
        }
      }

      if (additionalCosts.length) {
        if (!process.additionalCost) {
          process.additionalCost = [];
        }
        process.additionalCost.push(
          ...additionalCosts.map(cost => ({
            notes: cost.notes || '',
            amount: cost.amount || 0,
            submissionId: submission._id,
          })),
        );
      }
      process.remarks = processData.remarks || process.remarks;
      process.totalUsedUnit = roundQty((process.totalUsedUnit || 0) + (processData.totalUsedUnit || 0));

      process.processOUT = totalOut;
      process.processRejection = totalRejection;

      if (nextProcess) {
        nextProcess.processIN = totalOut;
      }

      const orderQuantityProduced = totalOut >= productionOrder.quantity;
      const previousProcessDone = currentProcessIndex === 0 || Boolean(previousProcess.endDatetime);
      const willComplete = orderQuantityProduced || (previousProcessDone && totalQuantity >= process.processIN);
      if (willComplete) {
        process.endDatetime = new Date();
        process.status = PROCESS_STATUS.COMPLETED;
      } else {
        process.status = PROCESS_STATUS.PARTIALLY_COMPLETED;
      }
      submission.status = process.status;

      logProductionOrderActivity(productionOrder, {
        action: PRODUCTION_ORDER_ACTIVITY_TYPE.PROCESS_SUBMITTED,
        description: `${process.processName || 'Process'} submitted${willComplete ? '' : ' (partial)'}`,
        userId,
        processId: process._id,
        submissionId: submission._id,
        metadata: {
          processOUT: newProcessOut,
          processRejection: newProcessRejection,
          totalUsedUnit: submission.totalUsedUnit,
          resultingStatus: process.status,
        },
      });

      const rawMaterialsToDeduct = (submission.processRawMaterialInput || []).filter(rm => rm.item && (rm.value || 0) > 0);
      const scrapToAdd = (submission.scrapOutProcess || []).filter(sc => sc.item && (sc.value || 0) > 0);

      if (rawMaterialsToDeduct.length > 0 || scrapToAdd.length > 0) {
        if (!productionOrder.productionWarehouseId) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Production Warehouse not found');
        }
        const warehouseDetails = await getWarehouseDetails(productionOrder.productionWarehouseId, session);

        if (rawMaterialsToDeduct.length > 0) {
          const requiredByItem = new Map();
          for (const rm of rawMaterialsToDeduct) {
            // Keyed by item and unit: the same item entered in two units can't be summed as one quantity.
            const key = `${rm.item}|${rm.itemUnitId || ''}`;
            const entry = requiredByItem.get(key) || { rawMaterialId: rm.item, itemUnitId: rm.itemUnitId, requiredQty: 0 };
            entry.requiredQty += rm.value;
            requiredByItem.set(key, entry);
          }

          const rawMaterialsToCheck = [...requiredByItem.values()].map(({ rawMaterialId, itemUnitId, requiredQty }) => ({
            rawMaterialId,
            itemUnitId,
            productionOrderRequiredUnit: Math.round(requiredQty * 1000) / 1000,
          }));

          await checkRawMaterialsStockAvailability({
            warehouseId: productionOrder.productionWarehouseId,
            rawMaterials: rawMaterialsToCheck,
            companyId: productionOrder.companyId,
            session,
            includeRejectQty: false,
            strictValidation: false,
          });

          const touchedRawMaterialItemIds = [];
          for (const rm of rawMaterialsToDeduct) {
            let rmRunningStock = await getItemWarehouseStock(
              rm.item,
              productionOrder.productionWarehouseId,
              productionOrder.companyId,
              session,
            );

            const deductionSummary = await handleWarehouseStock({
              action: 'deductStock',
              stockData: {
                itemId: rm.item,
                companyId: productionOrder.companyId,
                branchId: warehouseDetails?.branchId,
                warehouseId: productionOrder.productionWarehouseId,
                quantity: rm.value,
                itemUnitId: rm.itemUnitId,
                deductedSourceType: 'PRODUCTION_ORDER',
                deductedSourceId: productionOrder._id,
              },
              session,
            });

            for (const deducted of deductionSummary) {
              const rmStockBefore = rmRunningStock;
              const rmStockAfter = roundQty(rmStockBefore - deducted.quantity);
              rmRunningStock = rmStockAfter;
              logInventoryImpact(productionOrder, {
                event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.RAW_MATERIAL_CONSUMED,
                item: rm.item,
                itemBatchId: deducted.itemBatchId,
                warehouseId: deducted.warehouseId || productionOrder.productionWarehouseId,
                stockBefore: rmStockBefore,
                change: -deducted.quantity,
                stockAfter: rmStockAfter,
                userId,
                processId: process._id,
                submissionId: submission._id,
              });
            }

            rm.batches.push(...deductionSummary);
            const processRawMaterial = process.processRawMaterialInput.find(p => p.item?.toString() === rm.item.toString());
            if (processRawMaterial) {
              processRawMaterial.batches.push(...deductionSummary);
            }
            touchedRawMaterialItemIds.push(rm.item);
          }

          await checkCompanyStockLevels({
            itemIds: touchedRawMaterialItemIds,
            companyId: productionOrder.companyId,
            docType: MODULE_NAMES.PRODUCTION_ORDER,
            docId: productionOrder._id,
            docNo: productionOrder.productionOrderCode,
            userId,
            session,
          });
        }

        if (scrapToAdd.length > 0) {
          const { Item } = getBooksCrmModels();
          const touchedScrapItemIds = [];
          for (const scrap of scrapToAdd) {
            const scrapItem = await Item.findById(scrap.item).session(session);
            if (!scrapItem) continue;

            const batchSummary = await handleWarehouseStock({
              action: 'addStock',
              stockData: {
                itemId: scrap.item,
                companyId: productionOrder.companyId,
                branchId: warehouseDetails?.branchId,
                divisionId: warehouseDetails?.divisionId,
                warehouseId: productionOrder.productionWarehouseId,
                quantity: scrap.value,
                itemUnitId: scrap.itemUnitId,
                purchasePrice: scrapItem.purchaseInformation?.costPrice || 0,
                rateIsBase: true,
                sourceType: 'PRODUCTION_ORDER',
                sourceId: productionOrder._id,
              },
              session,
            });

            if (batchSummary && !batchSummary.skipped) {
              const scrapBatchEntry = {
                batchNo: batchSummary.batchNo,
                quantity: batchSummary.quantity,
                purchasePrice: batchSummary.purchasePrice,
                warehouseId: productionOrder.productionWarehouseId,
                itemBatchId: batchSummary?._id,
              };
              scrap.batches.push(scrapBatchEntry);
              const processScrap = process.scrapOutProcess.find(s => s.item?.toString() === scrap.item.toString());
              if (processScrap) {
                processScrap.batches.push(scrapBatchEntry);
              }

              const scrapStockAfter = await getItemWarehouseStock(
                scrap.item,
                productionOrder.productionWarehouseId,
                productionOrder.companyId,
                session,
              );
              logInventoryImpact(productionOrder, {
                event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_BOOKED,
                item: scrap.item,
                itemBatchId: batchSummary._id,
                warehouseId: productionOrder.productionWarehouseId,
                stockBefore: roundQty(scrapStockAfter - batchSummary.quantity),
                change: batchSummary.quantity,
                stockAfter: scrapStockAfter,
                userId,
                processId: process._id,
                submissionId: submission._id,
              });

              touchedScrapItemIds.push(scrap.item);
            }
          }

          if (touchedScrapItemIds.length > 0) {
            await checkCompanyStockLevels({
              itemIds: touchedScrapItemIds,
              companyId: productionOrder.companyId,
              docType: MODULE_NAMES.PRODUCTION_ORDER,
              docId: productionOrder._id,
              docNo: productionOrder.productionOrderCode,
              userId,
              session,
            });
          }
        }
      }

      if (willComplete && currentProcessIndex === processes.length - 1) {
        productionOrder.status = PRODUCTION_ORDER_STATUS.COMPLETED;
      }
      productionOrder.totalFgSubmittedQty = roundQty(processes[processes.length - 1]?.processOUT);
      productionOrder.totalFgRejectedQty = roundQty(processes.reduce((sum, p) => sum + (p.processRejection || 0), 0));
      await applyProcessRouteCompletionEffects({ productionOrder, userId, session });
      syncProcessRouteOrderStatus(productionOrder);

      await productionOrder.save({ session });

      if (productionOrder.salesOrderId) {
        await syncSalesOrderProductionStatus(productionOrder.salesOrderId, productionOrder.companyId, session);
      }
    });

    await flushCompanyStockLevels(session);
  } catch (error) {
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteProcessSubmission = async ({ productionOrderId, processId, submissionId, companyId }, userId) => {
  const { ProductionOrder } = getBooksModels();
  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.withTransaction(async () => {
      const productionOrder = await ProductionOrder.findOne({
        _id: productionOrderId,
        'processBased.processes._id': processId,
        companyId,
      }).session(session);

      if (!productionOrder) {
        throw new ApiError(httpStatus.NOT_FOUND, 'productionOrder or Process not found');
      }

      if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE') {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Submission history is only applicable to PROCESS_ROUTE production orders');
      }

      if ([PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(productionOrder.status)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot delete a submission on a ${productionOrder.status.toLowerCase()} production order`,
        );
      }

      if (productionOrder.isManuallyCompleted) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete a submission on a manually completed production order');
      }

      const processes = productionOrder.processBased.processes;
      const process = processes.id(processId);
      if (!process) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Process not found');
      }

      const submission = process.submissionHistory.id(submissionId);
      if (!submission) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Submission not found on this process');
      }

      const currentProcessIndex = processes.findIndex(p => p._id.toString() === processId);
      const nextProcess = currentProcessIndex < processes.length - 1 ? processes[currentProcessIndex + 1] : null;

      if (
        nextProcess &&
        (submission.processOUT || 0) > 0 &&
        ((nextProcess.processOUT || 0) > 0 ||
          (nextProcess.processRejection || 0) > 0 ||
          (nextProcess.submissionHistory || []).length > 0)
      ) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `This submission cannot be deleted because the next process "${
            nextProcess.processName || 'the next process'
          }" already has submissions (OUT: ${nextProcess.processOUT || 0}). Delete the next process's submissions first.`,
        );
      }

      await assertSubmissionScrapUnused({ submission, companyId, session });

      const processOutAfterRemoval = Math.max(roundQty((process.processOUT || 0) - (submission.processOUT || 0)), 0);
      if (nextProcess) {
        const nextConsumed = roundQty((nextProcess.processOUT || 0) + (nextProcess.processRejection || 0));
        if (nextConsumed > processOutAfterRemoval) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `This submission cannot be deleted because the next process has already consumed ${nextConsumed} unit(s). Please reduce or delete the related submission from process "${
              nextProcess.processName || 'the next process'
            }" first.`,
          );
        }
      }

      process.processOUT = processOutAfterRemoval;
      if (nextProcess) {
        nextProcess.processIN = processOutAfterRemoval;
        // Next process has produced nothing yet (guarded above), so it goes back to untouched.
        if (!(nextProcess.processOUT || 0) && nextProcess.status !== PROCESS_STATUS.COMPLETED) {
          nextProcess.status = PROCESS_STATUS.PENDING;
          nextProcess.startDatetime = undefined;
          nextProcess.startedBy = undefined;
        }
      }
      process.processRejection = Math.max(roundQty((process.processRejection || 0) - (submission.processRejection || 0)), 0);
      process.totalUsedUnit = Math.max(roundQty((process.totalUsedUnit || 0) - (submission.totalUsedUnit || 0)), 0);

      for (const rm of submission.processRawMaterialInput || []) {
        for (const batchUse of rm.batches || []) {
          if (!batchUse.itemBatchId || !batchUse.quantity) continue;

          const reversed = await reverseDeductionByBatch({
            stockData: {
              itemId: rm.item,
              companyId,
              warehouseId: batchUse.warehouseId || productionOrder.productionWarehouseId,
              itemBatchId: batchUse.itemBatchId,
              quantity: batchUse.quantity,
              deductedSourceType: 'PRODUCTION_ORDER',
              deductedSourceId: productionOrder._id,
            },
            session,
          });

          if (reversed.remainingQty != null) {
            const rmReverseWarehouseId = batchUse.warehouseId || productionOrder.productionWarehouseId;
            const rmStockAfter = await getItemWarehouseStock(rm.item, rmReverseWarehouseId, companyId, session);
            logInventoryImpact(productionOrder, {
              event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.RAW_MATERIAL_CONSUMPTION_DELETED,
              item: rm.item,
              itemBatchId: batchUse.itemBatchId,
              warehouseId: rmReverseWarehouseId,
              stockBefore: roundQty(rmStockAfter - batchUse.quantity),
              change: batchUse.quantity,
              stockAfter: rmStockAfter,
              userId,
              processId: process._id,
              submissionId,
            });
          }

          const processRawMaterial = process.processRawMaterialInput.find(p => p.item?.toString() === rm.item?.toString());
          if (processRawMaterial) {
            const batchIndex = processRawMaterial.batches.findIndex(
              b => b.itemBatchId?.toString() === batchUse.itemBatchId?.toString() && b.quantity === batchUse.quantity,
            );
            if (batchIndex !== -1) processRawMaterial.batches.splice(batchIndex, 1);
          }
        }
      }

      for (const scrap of submission.scrapOutProcess || []) {
        for (const batchUse of scrap.batches || []) {
          if (!batchUse.itemBatchId) continue;

          const deleted = await deleteStockByBatchId({
            stockData: {
              itemId: scrap.item,
              companyId,
              warehouseId: batchUse.warehouseId || productionOrder.productionWarehouseId,
              itemBatchId: batchUse.itemBatchId,
            },
            session,
          });

          if (deleted.removedStock > 0) {
            const scrapDeleteWarehouseId = batchUse.warehouseId || productionOrder.productionWarehouseId;
            const scrapStockAfter = await getItemWarehouseStock(scrap.item, scrapDeleteWarehouseId, companyId, session);
            logInventoryImpact(productionOrder, {
              event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_DELETED,
              item: scrap.item,
              itemBatchId: batchUse.itemBatchId,
              warehouseId: scrapDeleteWarehouseId,
              stockBefore: roundQty(scrapStockAfter + deleted.removedStock),
              change: -deleted.removedStock,
              stockAfter: scrapStockAfter,
              userId,
              processId: process._id,
              submissionId,
            });
          }

          const processScrap = process.scrapOutProcess.find(s => s.item?.toString() === scrap.item?.toString());
          if (processScrap) {
            const batchIndex = processScrap.batches.findIndex(
              b => b.itemBatchId?.toString() === batchUse.itemBatchId?.toString(),
            );
            if (batchIndex !== -1) processScrap.batches.splice(batchIndex, 1);
          }
        }
      }

      // The finished-goods batch this submission produced (last process only) leaves stock with it.
      for (const batchUse of submission.batches || []) {
        await reconcileSubmissionOutputBatch({
          existingBatch: batchUse,
          itemId: productionOrder.itemId,
          companyId,
          warehouseId: productionOrder.inventoryInwarehouseId,
          targetQuantity: 0,
          session,
          productionOrder,
          userId,
          submissionId,
          events: {
            edited: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_EDITED,
            created: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_POSTED,
            deleted: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.FINISHED_GOODS_DELETED,
          },
        });
      }

      for (const consumed of submission.processRawMaterialInput || []) {
        if (!consumed.item) continue;
        const existing = process.processRawMaterialInput.find(rm => rm.item?.toString() === consumed.item.toString());
        if (existing) {
          existing.value = Math.max((existing.value || 0) - (consumed.value || 0), 0);
        }
      }
      process.processRawMaterialInput = (process.processRawMaterialInput || []).filter(rm => (rm.value || 0) > 0);

      for (const scrap of submission.scrapOutProcess || []) {
        if (!scrap.item) continue;
        const existing = process.scrapOutProcess.find(s => s.item?.toString() === scrap.item.toString());
        if (existing) {
          existing.value = Math.max((existing.value || 0) - (scrap.value || 0), 0);
        }
      }
      process.scrapOutProcess = (process.scrapOutProcess || []).filter(s => (s.value || 0) > 0);

      for (const worker of submission.manPower || []) {
        if (!worker.workerId) continue;
        const existing = process.manPower.find(mp => mp.workerId?.toString() === worker.workerId.toString());
        if (existing) {
          existing.workerHours = Math.max((existing.workerHours || 0) - (worker.workerHours || 0), 0);
          existing.workerCost = Math.max((existing.workerCost || 0) - (worker.workerCost || 0), 0);
        }
      }
      process.manPower = (process.manPower || []).filter(mp => (mp.workerHours || 0) > 0 || (mp.workerCost || 0) > 0);

      process.additionalCost = (process.additionalCost || []).filter(
        cost => cost.submissionId?.toString() !== submissionId.toString(),
      );

      process.submissionHistory.pull({ _id: submissionId });

      logProductionOrderActivity(productionOrder, {
        action: PRODUCTION_ORDER_ACTIVITY_TYPE.PROCESS_SUBMISSION_DELETED,
        description: `Submission deleted from ${process.processName || 'process'}`,
        userId,
        processId: process._id,
        submissionId,
        metadata: {
          reversedProcessOUT: submission.processOUT || 0,
          reversedProcessRejection: submission.processRejection || 0,
        },
      });

      const totalQuantity = roundQty((process.processOUT || 0) + (process.processRejection || 0));
      const previousProcess = currentProcessIndex > 0 ? processes[currentProcessIndex - 1] : null;
      const previousProcessDone = currentProcessIndex === 0 || Boolean(previousProcess?.endDatetime);

      if (previousProcessDone && process.processIN && totalQuantity >= process.processIN) {
        process.status = PROCESS_STATUS.COMPLETED;
        if (!process.endDatetime) {
          process.endDatetime = new Date();
        }
      } else {
        if (process.submissionHistory.length) {
          process.status = PROCESS_STATUS.PARTIALLY_COMPLETED;
        } else {
          // Last submission removed - the process is back to its untouched state, so it can be started again.
          process.status = PROCESS_STATUS.PENDING;
          process.startDatetime = undefined;
          process.startedBy = undefined;
        }
        process.endDatetime = undefined;
      }

      const allEnded = processes.length > 0 && processes.every(p => p.endDatetime);
      if (allEnded) {
        productionOrder.status = PRODUCTION_ORDER_STATUS.COMPLETED;
      } else if (productionOrder.status === PRODUCTION_ORDER_STATUS.COMPLETED) {
        productionOrder.status = PRODUCTION_ORDER_STATUS.PARTIAL;
      }
      productionOrder.totalFgSubmittedQty = roundQty(processes[processes.length - 1]?.processOUT);
      productionOrder.totalFgRejectedQty = roundQty(processes.reduce((sum, p) => sum + (p.processRejection || 0), 0));

      // Rebuilds the journal, and the finished-goods batch when the order still has output, from
      // whatever the order holds afterwards; it reverses the previous posting itself.
      await applyProcessRouteCompletionEffects({ productionOrder, userId, session });
      syncProcessRouteOrderStatus(productionOrder);

      productionOrder.updatedBy = userId;
      await productionOrder.save({ session });

      if (productionOrder.salesOrderId) {
        await syncSalesOrderProductionStatus(productionOrder.salesOrderId, productionOrder.companyId, session);
      }
    });

    await flushCompanyStockLevels(session);
  } catch (error) {
    throw error;
  } finally {
    await session.endSession();
  }
};

const editProcessSubmission = async ({ productionOrderId, processId, submissionId, companyId }, processData, userId) => {
  const { ProductionOrder } = getBooksModels();
  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.withTransaction(async () => {
      //mention code step vise and make sure it should be implemented using session and transaction
      // 1. load the production order, process and submission being edited
      const productionOrder = await ProductionOrder.findOne({
        _id: productionOrderId,
        'processBased.processes._id': processId,
        companyId,
      }).session(session);

      if (!productionOrder) {
        throw new ApiError(httpStatus.NOT_FOUND, 'productionOrder or Process not found');
      }

      await applyProcessBodyUnits(processData, companyId, session);

      if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE') {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Editing a process submission is only applicable to PROCESS_ROUTE production orders',
        );
      }

      if ([PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(productionOrder.status)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot edit a submission on a ${productionOrder.status.toLowerCase()} production order`,
        );
      }

      if (productionOrder.isManuallyCompleted) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot edit a submission on a manually completed production order');
      }

      const processes = productionOrder.processBased.processes;
      const process = processes.id(processId);
      if (!process) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Process not found');
      }

      const submission = process.submissionHistory.id(submissionId);
      if (!submission) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Submission not found on this process');
      }

      const oldProcessOUT = submission.processOUT || 0;
      const oldProcessRejection = submission.processRejection || 0;
      const oldTotalUsedUnit = submission.totalUsedUnit || 0;

      // 2. compare old and new raw material and scrap quantities
      // Raw material needs no per-item comparison - its old effect is reversed in full using the
      // batches stored on the submission when it was added, then the new amounts are deducted
      // fresh (step 3/4). Only scrap needs a before/after per item, to know which items to check
      // for prior usage in step 2.
      const oldScrap = submission.scrapOutProcess || [];
      const newScrap = (processData.scrapOutProcess || []).filter(scrap => scrap.item);

      // The same scrap item can be on several lines (different units), each owning its own batch, so lines are
      // handled as slots: a submitted line paired with the old line of the same item + unit (then any left of the
      // same item), plus one slot per old line that is no longer submitted. A slot's edited quantity is new - old:
      // positive adds to stock, negative reverses some, and a slot with no new quantity is removed.
      const unpairedOldScrap = [...oldScrap];
      const pairedOldScrap = new Array(newScrap.length).fill(null);
      for (const sameUnitOnly of [true, false]) {
        newScrap.forEach((scrap, index) => {
          if (pairedOldScrap[index]) return;
          const old = unpairedOldScrap.find(
            candidate =>
              candidate.item.toString() === scrap.item.toString() &&
              (!sameUnitOnly || String(candidate.itemUnitId ?? '') === String(scrap.itemUnitId ?? '')),
          );
          if (!old) return;
          unpairedOldScrap.splice(unpairedOldScrap.indexOf(old), 1);
          pairedOldScrap[index] = old;
        });
      }
      const scrapSlots = [
        ...newScrap.map((scrap, index) => ({
          itemId: scrap.item.toString(),
          unitId: scrap.itemUnitId,
          newQty: scrap.value || 0,
          oldLine: pairedOldScrap[index],
        })),
        ...unpairedOldScrap.map(old => ({ itemId: old.item.toString(), unitId: old.itemUnitId, newQty: 0, oldLine: old })),
      ];

      // 3. validate before touching any stock
      const newProcessOut = processData.processOUT || 0;
      const newProcessRejection = processData.processRejection || 0;
      if (newProcessOut === 0 && newProcessRejection === 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Please enter a quantity for either Output or Rejected Quantity. At least one must be greater than 0.',
        );
      }

      const currentProcessIndex = processes.findIndex(p => p._id.toString() === processId);
      const nextProcess = currentProcessIndex < processes.length - 1 ? processes[currentProcessIndex + 1] : null;

      // The next process has already consumed part of this process's output (its OUT + rejection),
      // so the edit may reduce this process's total output only down to that consumed amount.
      if (nextProcess) {
        const nextConsumed = roundQty((nextProcess.processOUT || 0) + (nextProcess.processRejection || 0));
        const processOutAfterEdit = roundQty((process.processOUT || 0) - (submission.processOUT || 0) + newProcessOut);
        if (roundQty(processOutAfterEdit) < roundQty(nextConsumed)) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Cannot edit this submission: process "${
              nextProcess.processName || 'the next process'
            }" has already consumed ${nextConsumed} unit(s) from this output. Output of this process cannot be less than ${nextConsumed}.`,
          );
        }
      }

      // Every OTHER submission's total, plus the new values, must still fit inside the process input.
      const otherSubmissionsTotal = process.submissionHistory
        .filter(existing => existing._id.toString() !== submissionId.toString())
        .reduce((sum, existing) => roundQty(sum + (existing.processOUT || 0) + (existing.processRejection || 0)), 0);

      const newTotal = roundQty(otherSubmissionsTotal + newProcessOut + newProcessRejection);
      if (newTotal > process.processIN) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Total quantity cannot be greater than the available process input of ${process.processIN}. Please adjust the quantity.`,
        );
      }

      // 4. check if the scrap item has been used in any other process or submission, if yes then throw error it should be check in item batch collection
      // Only items that already have a batch from this submission are handled here - a brand new
      // scrap item (no old batch yet) has nothing to check or adjust, so it's left for step 6.
      for (const slot of scrapSlots) {
        const { itemId, oldLine, newQty } = slot;
        const qtyChange = newQty - (oldLine?.value || 0);
        if (!qtyChange) continue; // unchanged, nothing to do for this line

        const oldBatch = oldLine?.batches?.[0];
        if (!oldBatch?.itemBatchId) continue;

        const warehouseId = oldBatch.warehouseId || productionOrder.productionWarehouseId;

        if (newQty > 0) {
          // Increased: adjustStockByBatchId just adds the extra quantity onto the existing batch,
          // deductions untouched. Decreased (but not to zero): adjustStockByBatchId throws if the
          // new quantity would go below what's already deducted from this batch (quantity - remainingQty).
          await adjustStockByBatchId({
            stockData: {
              itemId,
              companyId,
              warehouseId,
              itemBatchId: oldBatch.itemBatchId,
              newQuantity: newQty,
              itemUnitId: slot.unitId,
            },
            session,
          });

          const scrapEditedStockAfter = await getItemWarehouseStock(itemId, warehouseId, companyId, session);
          logInventoryImpact(productionOrder, {
            event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_EDITED,
            item: itemId,
            itemBatchId: oldBatch.itemBatchId,
            warehouseId,
            stockBefore: roundQty(scrapEditedStockAfter - qtyChange),
            change: qtyChange,
            stockAfter: scrapEditedStockAfter,
            userId,
            processId: process._id,
            submissionId,
          });
        } else {
          // Removed entirely: deleteStockByBatchId itself throws if any deduction exists on this batch.
          const deleted = await deleteStockByBatchId({
            stockData: { itemId, companyId, warehouseId, itemBatchId: oldBatch.itemBatchId },
            session,
          });

          if (deleted.removedStock > 0) {
            const scrapDeletedStockAfter = await getItemWarehouseStock(itemId, warehouseId, companyId, session);
            logInventoryImpact(productionOrder, {
              event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_DELETED,
              item: itemId,
              itemBatchId: oldBatch.itemBatchId,
              warehouseId,
              stockBefore: roundQty(scrapDeletedStockAfter + deleted.removedStock),
              change: -deleted.removedStock,
              stockAfter: scrapDeletedStockAfter,
              userId,
              processId: process._id,
              submissionId,
            });
          }
        }
      }

      // 5. reverse the old raw material quantities from stock (scrap already handled in step 4)
      // Safe to reverse in full, unlike scrap - nothing downstream depends on getting back these
      // exact units, so there's no "already used elsewhere" floor to check first.
      for (const rawMaterial of submission.processRawMaterialInput || []) {
        for (const batchUse of rawMaterial.batches || []) {
          if (!batchUse.itemBatchId || !batchUse.quantity) continue;

          const reversed = await reverseDeductionByBatch({
            stockData: {
              itemId: rawMaterial.item,
              companyId,
              warehouseId: batchUse.warehouseId || productionOrder.productionWarehouseId,
              itemBatchId: batchUse.itemBatchId,
              quantity: batchUse.quantity,
              deductedSourceType: 'PRODUCTION_ORDER',
              deductedSourceId: productionOrder._id,
            },
            session,
          });

          if (reversed.remainingQty != null) {
            const rmReverseWarehouseId = batchUse.warehouseId || productionOrder.productionWarehouseId;
            const rmStockAfter = await getItemWarehouseStock(rawMaterial.item, rmReverseWarehouseId, companyId, session);
            logInventoryImpact(productionOrder, {
              event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.RAW_MATERIAL_CONSUMPTION_DELETED,
              item: rawMaterial.item,
              itemBatchId: batchUse.itemBatchId,
              warehouseId: rmReverseWarehouseId,
              stockBefore: roundQty(rmStockAfter - batchUse.quantity),
              change: batchUse.quantity,
              stockAfter: rmStockAfter,
              userId,
              processId: process._id,
              submissionId,
            });
          }
        }
      }

      // 6. deduct the new raw material and scrap quantities from stock
      const warehouseDetails = await getWarehouseDetails(productionOrder.productionWarehouseId, session);

      // Raw material: fresh deduction for the new amounts, exactly like a brand-new submission -
      // step 5 already gave everything back, so this is a clean deduction, not a delta.
      const newRawMaterialInput = [];
      const rawMaterialsToDeduct = (processData.processRawMaterialInput || []).filter(
        rawMaterial => rawMaterial.item && (rawMaterial.value || 0) > 0,
      );

      if (rawMaterialsToDeduct.length > 0) {
        if (!productionOrder.productionWarehouseId) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Production Warehouse not found');
        }

        await checkRawMaterialsStockAvailability({
          warehouseId: productionOrder.productionWarehouseId,
          companyId,
          session,
          includeRejectQty: false,
          strictValidation: false,
          rawMaterials: rawMaterialsToDeduct.map(rawMaterial => ({
            rawMaterialId: rawMaterial.item,
            itemUnitId: rawMaterial.itemUnitId,
            productionOrderRequiredUnit: Math.round((rawMaterial.value || 0) * 1000) / 1000,
          })),
        });

        const touchedRawMaterialItemIds = [];
        for (const rawMaterial of rawMaterialsToDeduct) {
          let rmRunningStock = await getItemWarehouseStock(
            rawMaterial.item,
            productionOrder.productionWarehouseId,
            companyId,
            session,
          );

          const batches = await handleWarehouseStock({
            action: 'deductStock',
            stockData: {
              itemId: rawMaterial.item,
              companyId,
              branchId: warehouseDetails?.branchId,
              warehouseId: productionOrder.productionWarehouseId,
              quantity: rawMaterial.value,
              itemUnitId: rawMaterial.itemUnitId,
              deductedSourceType: 'PRODUCTION_ORDER',
              deductedSourceId: productionOrder._id,
            },
            session,
          });

          for (const deducted of batches) {
            const rmStockBefore = rmRunningStock;
            const rmStockAfter = roundQty(rmStockBefore - deducted.quantity);
            rmRunningStock = rmStockAfter;
            logInventoryImpact(productionOrder, {
              event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.RAW_MATERIAL_CONSUMED,
              item: rawMaterial.item,
              itemBatchId: deducted.itemBatchId,
              warehouseId: deducted.warehouseId || productionOrder.productionWarehouseId,
              stockBefore: rmStockBefore,
              change: -deducted.quantity,
              stockAfter: rmStockAfter,
              userId,
              processId: process._id,
              submissionId,
            });
          }

          newRawMaterialInput.push({ item: rawMaterial.item, value: rawMaterial.value, batches });
          touchedRawMaterialItemIds.push(rawMaterial.item);
        }

        await checkCompanyStockLevels({
          itemIds: touchedRawMaterialItemIds,
          companyId,
          docType: MODULE_NAMES.PRODUCTION_ORDER,
          docId: productionOrder._id,
          docNo: productionOrder.productionOrderCode,
          userId,
          session,
        });
      }

      // Scrap: add a fresh batch only for items that had no existing batch in step 4 - those are
      // the brand-new scrap items on this submission, nothing to adjust for them yet.
      const newScrapBatchBySlot = new Map();
      const { Item } = getBooksCrmModels();

      for (const slot of scrapSlots) {
        const { itemId, oldLine, newQty } = slot;
        if (newQty <= 0) continue;

        if (oldLine?.batches?.[0]?.itemBatchId) continue; // already handled in step 4

        const scrapItem = await Item.findById(itemId).session(session);
        if (!scrapItem) continue;

        const batchSummary = await handleWarehouseStock({
          action: 'addStock',
          stockData: {
            itemId,
            companyId,
            branchId: warehouseDetails?.branchId,
            divisionId: warehouseDetails?.divisionId,
            warehouseId: productionOrder.productionWarehouseId,
            quantity: newQty,
            itemUnitId: slot.unitId,
            purchasePrice: scrapItem.purchaseInformation?.costPrice || 0,
            rateIsBase: true,
            sourceType: 'PRODUCTION_ORDER',
            sourceId: productionOrder._id,
          },
          session,
        });

        if (batchSummary && !batchSummary.skipped) {
          newScrapBatchBySlot.set(slot, {
            batchNo: batchSummary.batchNo,
            quantity: batchSummary.quantity,
            purchasePrice: batchSummary.purchasePrice,
            warehouseId: productionOrder.productionWarehouseId,
            itemBatchId: batchSummary._id,
          });

          const newScrapStockAfter = await getItemWarehouseStock(
            itemId,
            productionOrder.productionWarehouseId,
            companyId,
            session,
          );
          logInventoryImpact(productionOrder, {
            event: PRODUCTION_ORDER_INVENTORY_EVENT_TYPE.SCRAP_BOOKED,
            item: itemId,
            itemBatchId: batchSummary._id,
            warehouseId: productionOrder.productionWarehouseId,
            stockBefore: roundQty(newScrapStockAfter - batchSummary.quantity),
            change: batchSummary.quantity,
            stockAfter: newScrapStockAfter,
            userId,
            processId: process._id,
            submissionId,
          });
        }
      }

      if (newScrapBatchBySlot.size > 0) {
        await checkCompanyStockLevels({
          itemIds: [...new Set([...newScrapBatchBySlot.keys()].map(slot => slot.itemId))],
          companyId,
          docType: MODULE_NAMES.PRODUCTION_ORDER,
          docId: productionOrder._id,
          docNo: productionOrder.productionOrderCode,
          userId,
          session,
        });
      }

      // 7. update the submission with new data
      // Rebuild the final scrap list: adjusted items keep their existing batch (step 4 only ever
      // changes its quantity, never its batchNo/purchasePrice, since we never pass a
      // newPurchasePrice), new items use the batch step 6 just created, removed items (newQty 0)
      // are left out entirely.
      const finalScrapOutProcess = [];
      for (const slot of scrapSlots) {
        const { itemId, oldLine, newQty } = slot;
        if (newQty <= 0) continue;

        const oldBatch = oldLine?.batches?.[0];

        if (oldBatch?.itemBatchId) {
          const scrapItem = await Item.findById(itemId).select('itemName itemUnitId unitConversions').session(session).lean();
          finalScrapOutProcess.push({
            item: itemId,
            itemUnitId: slot.unitId,
            value: newQty,
            batches: [
              {
                batchNo: oldBatch.batchNo,
                quantity: roundQty(newQty * resolveUnitConversion(scrapItem, slot.unitId)),
                purchasePrice: oldBatch.purchasePrice,
                warehouseId: oldBatch.warehouseId,
                itemBatchId: oldBatch.itemBatchId,
              },
            ],
          });
        } else if (newScrapBatchBySlot.has(slot)) {
          finalScrapOutProcess.push({
            item: itemId,
            itemUnitId: slot.unitId,
            value: newQty,
            batches: [newScrapBatchBySlot.get(slot)],
          });
        }
      }

      submission.processOUT = newProcessOut;
      submission.processRejection = newProcessRejection;
      submission.totalUsedUnit = processData.totalUsedUnit || 0;
      submission.manPower = processData.manPower || [];
      submission.remarks = processData.remarks || '';
      submission.processRawMaterialInput = newRawMaterialInput;
      submission.scrapOutProcess = finalScrapOutProcess;

      // 8. update the process with new data
      // Rebuild every process-level running total by summing across all of this process's
      // submissions - the edited one already holds its new values from step 7. A fresh sum is
      // simpler and less error-prone than patching the old numbers by hand.
      let processTotalOut = 0;
      let processTotalRejection = 0;
      let processTotalUsedUnit = 0;
      const processRawMaterialInput = [];
      const processScrapOutProcess = [];
      const processManPower = [];

      for (const existingSubmission of process.submissionHistory) {
        processTotalOut = roundQty(processTotalOut + (existingSubmission.processOUT || 0));
        processTotalRejection = roundQty(processTotalRejection + (existingSubmission.processRejection || 0));
        processTotalUsedUnit = roundQty(processTotalUsedUnit + (existingSubmission.totalUsedUnit || 0));

        for (const rawMaterial of existingSubmission.processRawMaterialInput || []) {
          if (!rawMaterial.item) continue;
          const existing = processRawMaterialInput.find(entry => entry.item?.toString() === rawMaterial.item.toString());
          if (existing) {
            existing.value = (existing.value || 0) + (rawMaterial.value || 0);
            existing.batches.push(...(rawMaterial.batches || []));
          } else {
            processRawMaterialInput.push({
              item: rawMaterial.item,
              itemUnitId: rawMaterial.itemUnitId,
              value: rawMaterial.value || 0,
              batches: [...(rawMaterial.batches || [])],
            });
          }
        }

        for (const scrap of existingSubmission.scrapOutProcess || []) {
          if (!scrap.item) continue;
          const existing = processScrapOutProcess.find(entry => entry.item?.toString() === scrap.item.toString());
          if (existing) {
            existing.value = (existing.value || 0) + (scrap.value || 0);
            existing.batches.push(...(scrap.batches || []));
          } else {
            processScrapOutProcess.push({
              item: scrap.item,
              itemUnitId: scrap.itemUnitId,
              value: scrap.value || 0,
              batches: [...(scrap.batches || [])],
            });
          }
        }

        for (const worker of existingSubmission.manPower || []) {
          if (!worker.workerId) continue;
          const existing = processManPower.find(entry => entry.workerId?.toString() === worker.workerId.toString());
          if (existing) {
            existing.salaryPerHour = worker.salaryPerHour ?? existing.salaryPerHour;
            existing.workerHours = (existing.workerHours || 0) + (worker.workerHours || 0);
            existing.workerCost = (existing.workerCost || 0) + (worker.workerCost || 0);
          } else {
            processManPower.push({
              workerId: worker.workerId,
              salaryPerHour: worker.salaryPerHour,
              workerHours: worker.workerHours || 0,
              workerCost: worker.workerCost || 0,
            });
          }
        }
      }

      process.processOUT = processTotalOut;
      process.processRejection = processTotalRejection;
      process.totalUsedUnit = processTotalUsedUnit;
      process.processRawMaterialInput = processRawMaterialInput;
      process.scrapOutProcess = processScrapOutProcess;
      process.manPower = processManPower;
      process.remarks = processData.remarks || process.remarks;

      // Replace this submission's additional-cost rows with the new ones.
      process.additionalCost = (process.additionalCost || []).filter(
        cost => cost.submissionId?.toString() !== submissionId.toString(),
      );
      const newAdditionalCosts = [].concat(processData.additionalCost || []).filter(cost => cost && (cost.notes || cost.amount));
      for (const cost of newAdditionalCosts) {
        process.additionalCost.push({ notes: cost.notes || '', amount: cost.amount || 0, submissionId: submission._id });
      }

      // Recompute this process's status/completion from scratch - an edit can move it either
      // way, unlike a plain submission which only ever moves a process toward completion.
      const totalQuantity = roundQty((process.processOUT || 0) + (process.processRejection || 0));
      const previousProcess = currentProcessIndex > 0 ? processes[currentProcessIndex - 1] : null;
      const previousProcessDone = currentProcessIndex === 0 || Boolean(previousProcess?.endDatetime);

      if (previousProcessDone && process.processIN && totalQuantity >= process.processIN) {
        process.status = PROCESS_STATUS.COMPLETED;
        if (!process.endDatetime) process.endDatetime = new Date();
      } else {
        process.status = process.submissionHistory.length ? PROCESS_STATUS.PARTIALLY_COMPLETED : PROCESS_STATUS.IN_PROGRESS;
        process.endDatetime = undefined;
      }
      submission.status = process.status;

      logProductionOrderActivity(productionOrder, {
        action: PRODUCTION_ORDER_ACTIVITY_TYPE.PROCESS_SUBMISSION_EDITED,
        description: `Submission edited on ${process.processName || 'process'}`,
        userId,
        processId: process._id,
        submissionId: submission._id,
        metadata: {
          processOUT: { from: oldProcessOUT, to: submission.processOUT },
          processRejection: { from: oldProcessRejection, to: submission.processRejection },
          totalUsedUnit: { from: oldTotalUsedUnit, to: submission.totalUsedUnit },
          resultingStatus: process.status,
        },
      });

      if (nextProcess) {
        nextProcess.processIN = process.processOUT;
      }

      // 9. update the production order with new data

      // Recompute the order's produced totals/status from scratch - same reasoning as the
      // process above, since this edit may have un-completed (or re-completed) the order.
      const allProcessesEnded = processes.length > 0 && processes.every(p => p.endDatetime);

      if (allProcessesEnded) {
        productionOrder.status = PRODUCTION_ORDER_STATUS.COMPLETED;
      } else if (productionOrder.status === PRODUCTION_ORDER_STATUS.COMPLETED) {
        productionOrder.status = PRODUCTION_ORDER_STATUS.PARTIAL;
      }
      productionOrder.totalFgSubmittedQty = roundQty(processes[processes.length - 1]?.processOUT);
      productionOrder.totalFgRejectedQty = roundQty(processes.reduce((sum, p) => sum + (p.processRejection || 0), 0));

      // Rebuilds the journal, and the finished-goods batch when the order still has output, from
      // whatever the order holds afterwards; it reverses the previous posting itself.
      await applyProcessRouteCompletionEffects({ productionOrder, userId, session });
      syncProcessRouteOrderStatus(productionOrder);

      productionOrder.updatedBy = userId;
      await productionOrder.save({ session });

      if (productionOrder.salesOrderId) {
        await syncSalesOrderProductionStatus(productionOrder.salesOrderId, productionOrder.companyId, session);
      }
    });

    await flushCompanyStockLevels(session);
  } catch (error) {
    throw error;
  } finally {
    await session.endSession();
  }
};

const getSalesOrdersForDropdown = async filter => {
  const { SalesOrder, Customer, Item, ItemUnit } = getBooksCrmModels();

  // Fetch pending sales orders (not closed, cancelled, or fully completed)
  const salesOrders = await SalesOrder.find({
    companyId: filter.companyId,
    status: { $nin: [SALES_ORDER_STATUS.CLOSED, SALES_ORDER_STATUS.CANCELLED, SALES_ORDER_STATUS.DRAFT] },
    productionOrderStatus: { $ne: PRODUCTION_ORDER_STATUS.COMPLETED },
  })
    .select('orderId customerId items.itemId items.quantity items.itemUnitId')
    .lean();

  if (salesOrders.length === 0) return [];

  const uniqueCustomerIds = [...new Set(salesOrders.map(o => o.customerId?.toString()).filter(Boolean))];
  const uniqueItemIds = [...new Set(salesOrders.flatMap(o => (o.items || []).map(i => i.itemId?.toString()).filter(Boolean)))];
  const uniqueUnitIds = [
    ...new Set(salesOrders.flatMap(o => (o.items || []).map(i => i.itemUnitId?.toString()).filter(Boolean))),
  ];

  // Fetch customers, items, line units, and each line's pending production quantity in parallel
  const [customers, itemDocs, itemUnits, pendingBySalesOrder] = await Promise.all([
    Customer.find({ _id: { $in: uniqueCustomerIds } })
      .select('customerDisplayName')
      .lean(),
    Item.find({ _id: { $in: uniqueItemIds } })
      .select('itemName itemCategory.isService trackInventory')
      .lean(),
    ItemUnit.find({ _id: { $in: uniqueUnitIds } })
      .select('name')
      .lean(),
    getPendingProductionByLine(salesOrders),
  ]);

  const customerMap = new Map(customers.map(c => [c._id.toString(), c.customerDisplayName || '']));
  const unitMap = new Map(itemUnits.map(u => [u._id.toString(), { _id: u._id, name: u.name }]));
  const itemMetaMap = new Map(
    itemDocs.map(i => [
      i._id.toString(),
      { itemName: i.itemName || '', isService: i?.itemCategory?.isService, trackInventory: i?.trackInventory },
    ]),
  );
  const filteredOrders = [];
  for (const order of salesOrders) {
    // Merge duplicate items in the same SO and sum their pending quantities. Pending quantity is in the
    // line's own unit, so lines of one item only merge when they share a unit.
    const pendingLines = pendingBySalesOrder.get(order._id.toString());
    const soItemMap = new Map();
    (order.items || []).forEach((item, index) => {
      if (!item.itemId) return;
      const idStr = item.itemId.toString();
      const key = `${idStr}:${item.itemUnitId?.toString() || ''}`;
      if (!soItemMap.has(key)) soItemMap.set(key, { itemId: item.itemId, itemUnitId: item.itemUnitId, pendingQty: 0 });
      soItemMap.get(key).pendingQty += pendingLines[index];
    });

    const filteredItems = [];
    for (const { itemId, itemUnitId, pendingQty } of soItemMap.values()) {
      const itemMeta = itemMetaMap.get(itemId.toString());
      // Production turns stock into stock. A service has none, and an item with tracking off was
      // expensed when bought, so neither can be produced — the same rule isStockTrackedItem applies
      // wherever stock actually moves. Offering them here leads to an order that cannot be run.
      if (itemMeta?.isService === true || itemMeta?.trackInventory === false) {
        continue;
      }
      const remaining = roundQty(pendingQty);
      if (remaining > 0) {
        filteredItems.push({
          itemId,
          itemName: itemMeta?.itemName || '',
          itemUnitId: (itemUnitId && unitMap.get(itemUnitId.toString())) || itemUnitId || null,
          quantity: remaining,
        });
      }
    }

    if (filteredItems.length > 0) {
      filteredOrders.push({
        _id: order._id,
        orderId: order.orderId,
        customerName: customerMap.get(order.customerId?.toString()) || '',
        items: filteredItems,
      });
    }
  }

  return filteredOrders;
};

const syncSalesOrderProductionStatus = async (salesOrderId, companyId, session) => {
  const { SalesOrder } = getBooksCrmModels();
  const { ProductionOrder } = getBooksModels();

  const salesOrderFilter = { _id: salesOrderId };
  if (companyId) {
    salesOrderFilter.companyId = companyId;
  }

  const salesOrder = await SalesOrder.findOne(salesOrderFilter).session(session).lean();
  if (!salesOrder || !Array.isArray(salesOrder.items) || salesOrder.items.length === 0) {
    return null;
  }

  const productionOrders = await ProductionOrder.find({ salesOrderId: salesOrder._id })
    .select('itemId quantity status')
    .session(session)
    .lean();

  let allItemsCompleted = true;

  for (const item of salesOrder.items) {
    const completedQty = productionOrders
      .filter(
        po =>
          po.itemId &&
          item.itemId &&
          po.itemId.toString() === item.itemId.toString() &&
          po.status === PRODUCTION_ORDER_STATUS.COMPLETED,
      )
      .reduce((sum, po) => sum + (po.quantity || 0), 0);

    if (completedQty < item.quantity) {
      allItemsCompleted = false;
    }
  }

  let newStatus;
  if (productionOrders.length === 0) {
    newStatus = PRODUCTION_ORDER_STATUS.PENDING;
  } else if (allItemsCompleted) {
    newStatus = PRODUCTION_ORDER_STATUS.COMPLETED;
  } else {
    newStatus = PRODUCTION_ORDER_STATUS.PARTIAL;
  }

  const updatedSalesOrder = await SalesOrder.findByIdAndUpdate(
    salesOrder._id,
    { productionOrderStatus: newStatus },
    { new: true, session },
  );

  return updatedSalesOrder;
};

// Resolves every activityLog entry's performedBy ObjectId into the same
// { _id, firstName, lastName, name } shape used for createdBy, via one batch User lookup -
// shared by the three getters below since each already spreads the raw activityLog through
// `order.toObject()` into populatedOrder and only needs performedBy turned into a display name.
const attachActivityLogUsers = async (order, populatedOrder, User) => {
  if (!order.activityLog?.length) return;

  const userIds = [...new Set(order.activityLog.filter(entry => entry.performedBy).map(entry => entry.performedBy.toString()))];
  if (!userIds.length) return;

  const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName');
  const userMap = new Map(users.map(user => [user._id.toString(), user]));

  populatedOrder.activityLog = populatedOrder.activityLog.map(entry => {
    const user = entry.performedBy ? userMap.get(entry.performedBy.toString()) : null;
    if (!user) return entry;
    return {
      ...entry,
      performedBy: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: [user.firstName, user.lastName].filter(Boolean).join(' '),
      },
    };
  });
};

// Resolves every inventoryImpactLog entry's item/itemBatchId/warehouseId/performedBy references
// into display-friendly objects via batched lookups, same pattern (and same three callers) as
// attachActivityLogUsers - backs the "Inventory Impact" tab's Item/Batch/Warehouse/User columns.
// Swaps itemUnitId for { _id, name } on the order, its raw materials and its scrap, plus (process-based)
// each process's raw material input / scrap rows and those of its submissions, BOM submission rows, and the
// inventory impact log.
// extraRows: other objects carrying an itemUnitId that are returned next to the order (e.g. inventory transfer raw materials).
const populateItemUnits = async (populatedOrder, extraRows = []) => {
  const { ItemUnit } = getBooksCrmModels();
  const processRows = (populatedOrder.processBased?.processes || []).flatMap(proc => [
    ...(proc.processRawMaterialInput || []),
    ...(proc.scrapOutProcess || []),
    ...(proc.submissionHistory || []).flatMap(submission => [
      ...(submission.processRawMaterialInput || []),
      ...(submission.scrapOutProcess || []),
    ]),
  ]);
  const rows = [
    populatedOrder,
    ...(populatedOrder.rawMaterials || []),
    ...(populatedOrder.scrapOut || []),
    ...(populatedOrder.submissionHistory || []).flatMap(submission => [
      ...(submission.rawMaterialsConsumed || []),
      ...(submission.scrapOut || []),
    ]),
    ...processRows,
    ...(populatedOrder.inventoryImpactLog || []),
    ...extraRows,
  ];
  const unitIds = [...new Set(rows.map(row => row.itemUnitId?.toString()).filter(Boolean))];
  if (!unitIds.length) return;

  const units = await ItemUnit.find({ _id: { $in: unitIds } })
    .select('name')
    .lean();
  const unitMap = new Map(units.map(unit => [unit._id.toString(), unit]));
  rows.forEach(row => {
    if (row.itemUnitId) row.itemUnitId = unitMap.get(row.itemUnitId.toString()) || row.itemUnitId;
  });
};

const attachInventoryImpactLogDetails = async (order, populatedOrder, { Item, ItemBatch, Warehouse, User }) => {
  if (!order.inventoryImpactLog?.length) return;

  const itemIds = new Set();
  const itemBatchIds = new Set();
  const warehouseIds = new Set();
  const userIds = new Set();
  order.inventoryImpactLog.forEach(entry => {
    if (entry.item) itemIds.add(entry.item.toString());
    if (entry.itemBatchId) itemBatchIds.add(entry.itemBatchId.toString());
    if (entry.warehouseId) warehouseIds.add(entry.warehouseId.toString());
    if (entry.performedBy) userIds.add(entry.performedBy.toString());
  });

  const [items, batches, warehouses, users] = await Promise.all([
    itemIds.size ? Item.find({ _id: { $in: [...itemIds] } }).select('itemName itemNo itemUnit') : [],
    itemBatchIds.size ? ItemBatch.find({ _id: { $in: [...itemBatchIds] } }).select('batchNo') : [],
    warehouseIds.size ? Warehouse.find({ _id: { $in: [...warehouseIds] } }).select('name') : [],
    userIds.size ? User.find({ _id: { $in: [...userIds] } }).select('firstName lastName') : [],
  ]);

  const itemMap = new Map(items.map(i => [i._id.toString(), i]));
  const batchMap = new Map(batches.map(b => [b._id.toString(), b]));
  const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w]));
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  populatedOrder.inventoryImpactLog = populatedOrder.inventoryImpactLog.map(entry => {
    const item = entry.item ? itemMap.get(entry.item.toString()) : null;
    const batch = entry.itemBatchId ? batchMap.get(entry.itemBatchId.toString()) : null;
    const warehouse = entry.warehouseId ? warehouseMap.get(entry.warehouseId.toString()) : null;
    const user = entry.performedBy ? userMap.get(entry.performedBy.toString()) : null;

    return {
      ...entry,
      ...(item && { item: { _id: item._id, itemName: item.itemName, itemNo: item.itemNo, itemUnit: item.itemUnit } }),
      ...(batch && { itemBatchId: { _id: batch._id, batchNo: batch.batchNo } }),
      ...(warehouse && { warehouseId: { _id: warehouse._id, name: warehouse.name } }),
      ...(user && {
        performedBy: {
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          name: [user.firstName, user.lastName].filter(Boolean).join(' '),
        },
      }),
    };
  });
};

// The log entries don't store a unit and the batches hold the item's main unit, so the unit each entry was
// entered in is taken from the order's own row for that item (raw material -> rawMaterialsConsumed/rawMaterials,
// scrap -> scrapOut, finished goods -> the order). Names are populated afterwards by populateItemUnits.
const attachInventoryImpactLogUnits = (order, populatedOrder) => {
  if (!populatedOrder.inventoryImpactLog?.length) return;

  const sameId = (a, b) => a && b && a.toString() === b.toString();
  const findUnit = (rows, itemKey, itemId) => rows?.find(row => sameId(row[itemKey], itemId))?.itemUnitId;

  populatedOrder.inventoryImpactLog = populatedOrder.inventoryImpactLog.map(entry => {
    const itemId = entry.item?._id || entry.item;
    const submission = order.submissionHistory?.find(sub => sameId(sub._id, entry.submissionId));
    let unitId;
    if (entry.event?.startsWith('RAW_MATERIAL')) {
      unitId =
        findUnit(submission?.rawMaterialsConsumed, 'rawMaterialId', itemId) ||
        findUnit(order.rawMaterials, 'rawMaterialId', itemId);
    } else if (entry.event?.startsWith('SCRAP')) {
      unitId = findUnit(submission?.scrapOut, 'item', itemId) || findUnit(order.scrapOut, 'item', itemId);
    } else if (sameId(order.itemId, itemId)) {
      unitId = order.itemUnitId;
    }
    return unitId ? { ...entry, itemUnitId: unitId } : entry;
  });
};

const getProductionOrdersById = async (id, companyId) => {
  const { ProductionOrder, ManPower, InventoryTransferRequest } = getBooksModels();
  const { Item, SalesOrder, Division, Branch, Warehouse, ItemInventory, ItemBatch } = getBooksCrmModels();
  const { User } = getCommonModels();

  const order = await ProductionOrder.findOne({ _id: id, companyId });
  if (!order) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
  }

  // Collect all related IDs
  const itemIds = new Set();
  const salesOrderIds = new Set();
  const divisionIds = new Set();
  const branchIds = new Set();
  const warehouseIds = new Set();
  const dispatchWarehouseIds = new Set();
  const inStockWarehouseIds = new Set();
  const productionWarehouseIds = new Set();
  const inventoryInwarehouseIds = new Set();
  const rawMaterialIds = new Set();
  const workerIds = new Set();
  const nestedItemIds = new Set();
  const productionOwnerIds = new Set();
  const manpowerCostIds = new Set();

  if (order.itemId) itemIds.add(order.itemId);

  if (order.salesOrderId) salesOrderIds.add(order.salesOrderId);

  if (order.divisionId) divisionIds.add(order.divisionId);

  if (order.branchId) branchIds.add(order.branchId);

  if (order.warehouseId) warehouseIds.add(order.warehouseId);

  if (order.dispatchWarehouseId) dispatchWarehouseIds.add(order.dispatchWarehouseId);

  if (order.inStockWarehouseId) inStockWarehouseIds.add(order.inStockWarehouseId);

  if (order.productionWarehouseId) productionWarehouseIds.add(order.productionWarehouseId);

  if (order.inventoryInwarehouseId) inventoryInwarehouseIds.add(order.inventoryInwarehouseId);
  if (order.productionOwnerIds) productionOwnerIds.add(order.productionOwnerId);

  order.rawMaterials?.forEach(rm => {
    if (rm.rawMaterialId) rawMaterialIds.add(rm.rawMaterialId);
  });

  // Collect raw material IDs from submission history
  order.submissionHistory?.forEach(submission => {
    submission.rawMaterialsConsumed?.forEach(rm => {
      if (rm.rawMaterialId) rawMaterialIds.add(rm.rawMaterialId);
    });
    // Collect scrap-out item IDs from submission history (BOM_BASED) - shares the raw material
    // lookup/map below since both are just Item references needing the same itemName/itemNo/itemUnit.
    submission.scrapOut?.forEach(sc => {
      if (sc.item) rawMaterialIds.add(sc.item);
    });
    // Collect manpowerCost IDs from submission history
    submission.manpowerCost?.forEach(mc => {
      if (mc.manpowerId) manpowerCostIds.add(mc.manpowerId);
    });
  });

  order.processBased?.processes?.forEach(proc => {
    proc.manPower?.forEach(mp => {
      if (mp.workerId) workerIds.add(mp.workerId);
    });
    proc.processRawMaterialInput?.forEach(input => {
      if (input.item) nestedItemIds.add(input.item);
    });
    proc.scrapOutProcess?.forEach(scrap => {
      if (scrap.item) nestedItemIds.add(scrap.item);
    });
    if (order.productionOwner && Array.isArray(order.productionOwner)) {
      order.productionOwner.forEach(element => {
        if (element) productionOwnerIds.add(element);
      });
    }
  });

  const [
    items,
    salesOrders,
    divisions,
    branches,
    warehouses,
    dispatchWarehouses,
    inStockWarehouses,
    productionWarehouses,
    inventoryINWarehouses,
    rawMaterials,
    workers,
    nestedItems,
    productionOwner,
    manpowerCostWorkers,
    createdByUser,
  ] = await Promise.all([
    Item.find({ _id: { $in: Array.from(itemIds) } }).select('itemName itemNo'),
    SalesOrder.find({ _id: { $in: Array.from(salesOrderIds) } }).select('orderId'),
    Division.find({ _id: { $in: Array.from(divisionIds) } }).select('name'),
    Branch.find({ _id: { $in: Array.from(branchIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(warehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(dispatchWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inStockWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(productionWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inventoryInwarehouseIds) } }).select('name'),
    Item.find({ _id: { $in: Array.from(rawMaterialIds) } }).select('itemName itemNo itemUnit'),
    ManPower.find({ _id: { $in: Array.from(workerIds) } }).select('workerName'),
    Item.find({ _id: { $in: Array.from(nestedItemIds) } }).select('itemName'),
    ManPower.find({ _id: { $in: Array.from(productionOwnerIds) } }).select('workerName'),
    ManPower.find({ _id: { $in: Array.from(manpowerCostIds) } }).select('workerName'),
    order.createdBy ? User.findById(order.createdBy).select('firstName lastName') : Promise.resolve(null),
  ]);

  // Create Maps
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));
  const salesOrderMap = new Map(salesOrders.map(so => [so._id.toString(), so]));
  const divisionMap = new Map(divisions.map(d => [d._id.toString(), d]));
  const branchMap = new Map(branches.map(b => [b._id.toString(), b]));
  const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w]));
  const dispatchWarehouseMap = new Map(dispatchWarehouses.map(wh => [wh._id.toString(), wh]));
  const inStockWarehouseMap = new Map(inStockWarehouses.map(wh => [wh._id.toString(), wh]));
  const productionWarehouseMap = new Map(productionWarehouses.map(wh => [wh._id.toString(), wh]));
  const inventoryINWarehouseMap = new Map(inventoryINWarehouses.map(wh => [wh._id.toString(), wh]));
  const rawMaterialMap = new Map(rawMaterials.map(rm => [rm._id.toString(), rm]));
  const workerMap = new Map(workers.map(w => [w._id.toString(), w]));
  const nestedItemMap = new Map(nestedItems.map(i => [i._id.toString(), i]));
  const productionOwnerMap = new Map(productionOwner.map(pq => [pq._id.toString(), pq]));
  const manpowerCostMap = new Map(manpowerCostWorkers.map(mp => [mp._id.toString(), mp]));

  // Raw material stock hasn't been transferred to the production warehouse until the
  // inventory transfer request is approved (INVENTORY_ISSUED/PARTIAL/COMPLETED/CLOSED) -
  // before that it still sits in inStockWarehouseId, so check availableStock there instead.
  const PRE_TRANSFER_STATUSES = [
    PRODUCTION_ORDER_STATUS.PENDING,
    PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL,
    PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED,
  ];
  const isPreTransfer = PRE_TRANSFER_STATUSES.includes(order.status);
  const stockCheckWarehouseId = isPreTransfer ? order.inStockWarehouseId : order.productionWarehouseId;
  const stockCheckWarehouseIdStr = stockCheckWarehouseId?.toString();
  const stockCheckWarehouse = stockCheckWarehouseIdStr
    ? (isPreTransfer ? inStockWarehouseMap : productionWarehouseMap).get(stockCheckWarehouseIdStr)
    : null;
  const rawMaterialInventories = rawMaterialIds.size
    ? await ItemInventory.find({ itemId: { $in: Array.from(rawMaterialIds) }, companyId })
        .select('itemId warehouses')
        .lean()
    : [];
  const rawMaterialStockMap = new Map();
  rawMaterialInventories.forEach(inv => {
    const warehouse = (inv.warehouses || []).find(w => w.warehouseId?.toString() === stockCheckWarehouseIdStr);
    rawMaterialStockMap.set(inv.itemId.toString(), warehouse?.availableStock ?? 0);
  });

  // Populate
  const populatedOrder = order.toObject();

  if (order.itemId) {
    const item = itemMap.get(order.itemId.toString());
    if (item) {
      populatedOrder.itemId = {
        _id: item._id,
        itemName: item.itemName,
        itemNo: item.itemNo,
      };
    }
  }

  if (order.salesOrderId) {
    const salesOrder = salesOrderMap.get(order.salesOrderId.toString());
    if (salesOrder) {
      populatedOrder.salesOrderId = {
        _id: salesOrder._id,
        orderId: salesOrder.orderId,
      };
    }
  }

  if (order.divisionId) {
    const division = divisionMap.get(order.divisionId.toString());
    if (division) {
      populatedOrder.divisionId = {
        _id: division._id,
        name: division.name,
      };
    }
  }

  if (order.branchId) {
    const branch = branchMap.get(order.branchId.toString());
    if (branch) {
      populatedOrder.branchId = {
        _id: branch._id,
        name: branch.name,
      };
    }
  }

  if (order.warehouseId) {
    const warehouse = warehouseMap.get(order.warehouseId.toString());
    if (warehouse) {
      populatedOrder.warehouseId = {
        _id: warehouse._id,
        name: warehouse.name,
      };
    }
  }

  if (order.dispatchWarehouseId) {
    const dispatchWarehouse = dispatchWarehouseMap.get(order.dispatchWarehouseId.toString());
    if (dispatchWarehouse) {
      populatedOrder.dispatchWarehouseId = {
        _id: dispatchWarehouse._id,
        name: dispatchWarehouse.name,
      };
    }
  }

  if (order.inStockWarehouseId) {
    const inStockWarehouse = inStockWarehouseMap.get(order.inStockWarehouseId.toString());
    if (inStockWarehouse) {
      populatedOrder.inStockWarehouseId = {
        _id: inStockWarehouse._id,
        name: inStockWarehouse.name,
      };
    }
  }

  if (order.productionWarehouseId) {
    const productionWarehouse = productionWarehouseMap.get(order.productionWarehouseId.toString());
    if (productionWarehouse) {
      populatedOrder.productionWarehouseId = {
        _id: productionWarehouse._id,
        name: productionWarehouse.name,
      };
    }
  }

  if (order.inventoryInwarehouseId) {
    const inventoryINWarehouse = inventoryINWarehouseMap.get(order.inventoryInwarehouseId.toString());
    if (inventoryINWarehouse) {
      populatedOrder.inventoryInwarehouseId = {
        _id: inventoryINWarehouse._id,
        name: inventoryINWarehouse.name,
      };
    }
  }

  // A material issue = stock currently available in stockCheckWarehouse can't cover what's
  // still left to consume for this raw material (productionOrderRequiredUnit - consumed - BOM RR).
  let materialIssuesCount = 0;
  if (order.rawMaterials) {
    populatedOrder.rawMaterials = order.rawMaterials.map(rm => {
      const populatedRm = {
        ...rm.toObject(),
      };
      if (rm.rawMaterialId) {
        const rawMaterial = rawMaterialMap.get(rm.rawMaterialId.toString());
        if (rawMaterial) {
          populatedRm.rawMaterialId = {
            _id: rawMaterial._id,
            itemName: rawMaterial.itemName,
            itemNo: rawMaterial.itemNo,
          };
        }
        const availableStock = rawMaterialStockMap.get(rm.rawMaterialId.toString()) ?? 0;
        const remainingQty = Math.max(
          roundQty((rm.productionOrderRequiredUnit || 0) - (rm.productionOrderSubmittedUnit || 0) - (rm.bomRRQty || 0)),
          0,
        );
        const hasMaterialIssue = remainingQty > 0 && availableStock < remainingQty;

        populatedRm.remainingQty = remainingQty;
        populatedRm.availableStock = availableStock;
        populatedRm.availableStockWarehouse = stockCheckWarehouse
          ? { _id: stockCheckWarehouse._id, name: stockCheckWarehouse.name }
          : null;
        populatedRm.hasMaterialIssue = hasMaterialIssue;

        if (hasMaterialIssue) materialIssuesCount += 1;
      }
      return populatedRm;
    });
  }

  populatedOrder.summary = {
    planned: order.quantity || 0,
    produced: order.totalFgSubmittedQty || 0,
    pending: Math.max(roundQty((order.quantity || 0) - (order.totalFgSubmittedQty || 0) - (order.totalFgRejectedQty || 0)), 0),
    submissions: order.submissionHistory?.length || 0,
    fgBatches: order.batches?.length || 0,
    // Count of raw materials that don't have enough stock available to cover what's still owed
    materialIssues: materialIssuesCount,
  };

  // Populate rawMaterialsConsumed in submissionHistory
  if (order.submissionHistory) {
    populatedOrder.submissionHistory = order.submissionHistory.map(submission => {
      const populatedSubmission = {
        ...submission.toObject(),
      };
      if (submission.rawMaterialsConsumed) {
        populatedSubmission.rawMaterialsConsumed = submission.rawMaterialsConsumed.map(rm => {
          const populatedRm = {
            ...rm.toObject(),
          };
          if (rm.rawMaterialId) {
            const rawMaterial = rawMaterialMap.get(rm.rawMaterialId.toString());
            if (rawMaterial) {
              populatedRm.rawMaterialId = {
                _id: rawMaterial._id,
                itemName: rawMaterial.itemName,
                itemNo: rawMaterial.itemNo,
                itemUnit: rawMaterial.itemUnit,
              };
            }
          }
          return populatedRm;
        });
      }
      // Populate scrapOut.item in submissionHistory (BOM_BASED)
      if (submission.scrapOut) {
        populatedSubmission.scrapOut = submission.scrapOut.map(sc => {
          const populatedScrap = {
            ...sc.toObject(),
          };
          if (sc.item) {
            const scrapItem = rawMaterialMap.get(sc.item.toString());
            if (scrapItem) {
              populatedScrap.item = {
                _id: scrapItem._id,
                itemName: scrapItem.itemName,
                itemNo: scrapItem.itemNo,
                itemUnit: scrapItem.itemUnit,
              };
            }
          }
          return populatedScrap;
        });
      }
      // Populate manpowerCost in submissionHistory
      if (submission.manpowerCost) {
        populatedSubmission.manpowerCost = submission.manpowerCost.map(mc => {
          const populatedMc = {
            ...mc.toObject(),
          };
          if (mc.manpowerId) {
            const worker = manpowerCostMap.get(mc.manpowerId.toString());
            if (worker) {
              populatedMc.manpowerId = {
                _id: worker._id,
                workerName: worker.workerName,
              };
            }
          }
          return populatedMc;
        });
      }
      return populatedSubmission;
    });
  }

  populatedOrder?.processBased?.processes?.forEach(proc => {
    proc.manPower = proc.manPower?.map(mp => {
      const populatedMp = {
        ...mp,
      };
      if (mp.workerId) {
        const worker = workerMap.get(mp.workerId.toString());
        if (worker) {
          populatedMp.workerId = {
            _id: worker._id,
            workerName: worker.workerName,
          };
        }
      }
      return populatedMp;
    });

    // --- Populate productionOwner ---
    if (order.productionOwner) {
      populatedOrder.productionOwner = order.productionOwner.map(mpId => {
        const mp = productionOwnerMap.get(mpId.toString());
        if (mp) {
          return { _id: mp._id, workerName: mp.workerName };
        }
        return mpId;
      });
    }

    proc.processRawMaterialInput = proc.processRawMaterialInput?.map(input => {
      const populatedInput = {
        ...input,
      };
      if (input.item) {
        const nestedItem = nestedItemMap.get(input.item.toString());
        if (nestedItem) {
          populatedInput.item = {
            _id: nestedItem._id,
            itemName: nestedItem.itemName,
          };
        }
      }
      return populatedInput;
    });

    proc.scrapOutProcess = proc.scrapOutProcess?.map(scrap => {
      const populatedScrap = {
        ...scrap,
      };
      if (scrap.item) {
        const nestedItem = nestedItemMap.get(scrap.item.toString());
        if (nestedItem) {
          populatedScrap.item = {
            _id: nestedItem._id,
            itemName: nestedItem.itemName,
          };
        }
      }
      return populatedScrap;
    });
  });

  // Populate manPower_inventoryTransfer
  if (order.manPower_inventoryTransfer) {
    populatedOrder.manPower_inventoryTransfer = order.manPower_inventoryTransfer.map(mpId => {
      const mp = workerMap.get(mpId.toString());
      if (mp) {
        return { _id: mp._id, workerName: mp.workerName };
      }
      return mpId;
    });
  }

  if (createdByUser) {
    populatedOrder.createdBy = {
      _id: createdByUser._id,
      firstName: createdByUser.firstName,
      lastName: createdByUser.lastName,
      name: [createdByUser.firstName, createdByUser.lastName].filter(Boolean).join(' '),
    };
  }

  await attachActivityLogUsers(order, populatedOrder, User);
  await attachInventoryImpactLogDetails(order, populatedOrder, { Item, ItemBatch, Warehouse, User });

  const transferRequests = await InventoryTransferRequest.find({ productionOrderId: order._id, companyId })
    .select('transferId status fromWarehouseId toWarehouseId quantity notes referenceNumber rawMaterials createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const transferWarehouseIds = new Set();
  const transferItemIds = new Set();
  transferRequests.forEach(transfer => {
    if (transfer.fromWarehouseId) transferWarehouseIds.add(String(transfer.fromWarehouseId));
    if (transfer.toWarehouseId) transferWarehouseIds.add(String(transfer.toWarehouseId));
    transfer.rawMaterials?.forEach(rm => {
      if (rm.rawMaterialId) transferItemIds.add(String(rm.rawMaterialId));
    });
  });

  const [transferWarehouses, transferItems] = await Promise.all([
    transferWarehouseIds.size
      ? Warehouse.find({ _id: { $in: [...transferWarehouseIds] } })
          .select('name')
          .lean()
      : [],
    transferItemIds.size
      ? Item.find({ _id: { $in: [...transferItemIds] } })
          .select('itemName itemNo')
          .lean()
      : [],
  ]);
  const transferWarehouseMap = new Map(transferWarehouses.map(warehouse => [String(warehouse._id), warehouse.name]));
  const transferItemMap = new Map(transferItems.map(item => [String(item._id), item]));

  const inventoryTransfers = transferRequests.map(transfer => ({
    ...transfer,
    fromWarehouseName: transfer.fromWarehouseId ? transferWarehouseMap.get(String(transfer.fromWarehouseId)) || null : null,
    toWarehouseName: transfer.toWarehouseId ? transferWarehouseMap.get(String(transfer.toWarehouseId)) || null : null,
    rawMaterials: (transfer.rawMaterials || []).map(rm => {
      const rmItem = rm.rawMaterialId ? transferItemMap.get(String(rm.rawMaterialId)) : null;
      return { ...rm, rawMaterialName: rmItem?.itemName || null, itemNo: rmItem?.itemNo || null };
    }),
  }));

  await populateItemUnits(
    populatedOrder,
    inventoryTransfers.flatMap(transfer => transfer.rawMaterials),
  );

  return {
    ...populatedOrder,
    id: order._id,
    inventoryTransfers,
  };
};

const getBomBasedProductionOrderById = async (id, companyId) => {
  const { ProductionOrder, ManPower, InventoryTransferRequest } = getBooksModels();
  const { Item, SalesOrder, Division, Branch, Warehouse, ItemInventory, ItemBatch } = getBooksCrmModels();
  const { User } = getCommonModels();

  const order = await ProductionOrder.findOne({ _id: id, companyId });
  if (!order) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
  }

  if (order.productionManageMethod !== 'BOM_BASED') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This production order is not a BOM_BASED production order');
  }

  // Collect all related IDs
  const itemIds = new Set();
  const salesOrderIds = new Set();
  const divisionIds = new Set();
  const branchIds = new Set();
  const warehouseIds = new Set();
  const dispatchWarehouseIds = new Set();
  const inStockWarehouseIds = new Set();
  const productionWarehouseIds = new Set();
  const inventoryInwarehouseIds = new Set();
  const rawMaterialIds = new Set();
  const workerIds = new Set();
  const productionOwnerIds = new Set();
  const manpowerCostIds = new Set();
  const submittedByIds = new Set();

  if (order.scrapOut) {
    order.scrapOut.forEach(sc => {
      if (sc.item) rawMaterialIds.add(sc.item);
    });
  }

  if (order.itemId) itemIds.add(order.itemId);

  if (order.salesOrderId) salesOrderIds.add(order.salesOrderId);

  if (order.divisionId) divisionIds.add(order.divisionId);

  if (order.branchId) branchIds.add(order.branchId);

  if (order.warehouseId) warehouseIds.add(order.warehouseId);

  if (order.dispatchWarehouseId) dispatchWarehouseIds.add(order.dispatchWarehouseId);

  if (order.inStockWarehouseId) inStockWarehouseIds.add(order.inStockWarehouseId);

  if (order.productionWarehouseId) productionWarehouseIds.add(order.productionWarehouseId);

  if (order.inventoryInwarehouseId) inventoryInwarehouseIds.add(order.inventoryInwarehouseId);
  if (order.productionOwnerIds) productionOwnerIds.add(order.productionOwnerId);

  order.rawMaterials?.forEach(rm => {
    if (rm.rawMaterialId) rawMaterialIds.add(rm.rawMaterialId);
  });

  // Collect raw material IDs from submission history
  order.submissionHistory?.forEach(submission => {
    if (submission.submittedBy) submittedByIds.add(submission.submittedBy);
    submission.rawMaterialsConsumed?.forEach(rm => {
      if (rm.rawMaterialId) rawMaterialIds.add(rm.rawMaterialId);
    });
    // Collect scrap-out item IDs from submission history (BOM_BASED) - shares the raw material
    // lookup/map below since both are just Item references needing the same itemName/itemNo/itemUnit.
    submission.scrapOut?.forEach(sc => {
      if (sc.item) rawMaterialIds.add(sc.item);
    });
    // Collect manpowerCost IDs from submission history
    submission.manpowerCost?.forEach(mc => {
      if (mc.manpowerId) manpowerCostIds.add(mc.manpowerId);
    });
  });

  // Collect manPower_inventoryTransfer IDs
  order.manPower_inventoryTransfer?.forEach(manPowerId => {
    if (manPowerId) workerIds.add(manPowerId);
  });

  if (order.productionOwner && Array.isArray(order.productionOwner)) {
    order.productionOwner.forEach(element => {
      if (element) productionOwnerIds.add(element);
    });
  }

  const [
    items,
    salesOrders,
    divisions,
    branches,
    warehouses,
    dispatchWarehouses,
    inStockWarehouses,
    productionWarehouses,
    inventoryINWarehouses,
    rawMaterials,
    workers,
    productionOwner,
    manpowerCostWorkers,
    createdByUser,
    submittedByUsers,
  ] = await Promise.all([
    Item.find({ _id: { $in: Array.from(itemIds) } }).select('itemName itemNo itemUnit'),
    SalesOrder.find({ _id: { $in: Array.from(salesOrderIds) } }).select('orderId'),
    Division.find({ _id: { $in: Array.from(divisionIds) } }).select('name'),
    Branch.find({ _id: { $in: Array.from(branchIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(warehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(dispatchWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inStockWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(productionWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inventoryInwarehouseIds) } }).select('name'),
    Item.find({ _id: { $in: Array.from(rawMaterialIds) } }).select('itemName itemNo itemUnit'),
    ManPower.find({ _id: { $in: Array.from(workerIds) } }).select('workerName'),
    ManPower.find({ _id: { $in: Array.from(productionOwnerIds) } }).select('workerName'),
    ManPower.find({ _id: { $in: Array.from(manpowerCostIds) } }).select('workerName'),
    order.createdBy ? User.findById(order.createdBy).select('firstName lastName') : Promise.resolve(null),
    User.find({ _id: { $in: Array.from(submittedByIds) } }).select('firstName lastName'),
  ]);

  // Create Maps
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));
  const salesOrderMap = new Map(salesOrders.map(so => [so._id.toString(), so]));
  const divisionMap = new Map(divisions.map(d => [d._id.toString(), d]));
  const branchMap = new Map(branches.map(b => [b._id.toString(), b]));
  const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w]));
  const dispatchWarehouseMap = new Map(dispatchWarehouses.map(wh => [wh._id.toString(), wh]));
  const inStockWarehouseMap = new Map(inStockWarehouses.map(wh => [wh._id.toString(), wh]));
  const productionWarehouseMap = new Map(productionWarehouses.map(wh => [wh._id.toString(), wh]));
  const inventoryINWarehouseMap = new Map(inventoryINWarehouses.map(wh => [wh._id.toString(), wh]));
  const rawMaterialMap = new Map(rawMaterials.map(rm => [rm._id.toString(), rm]));
  const workerMap = new Map(workers.map(w => [w._id.toString(), w]));
  const productionOwnerMap = new Map(productionOwner.map(pq => [pq._id.toString(), pq]));
  const manpowerCostMap = new Map(manpowerCostWorkers.map(mp => [mp._id.toString(), mp]));
  const submittedByMap = new Map(submittedByUsers.map(u => [u._id.toString(), u]));

  // Same shape as createdBy; falls back to the raw id if the user no longer exists.
  const populateSubmittedBy = userId => {
    if (!userId) return userId;
    const user = submittedByMap.get(userId.toString());
    if (!user) return userId;
    return {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    };
  };

  // Raw material stock hasn't been transferred to the production warehouse until the
  // inventory transfer request is approved (INVENTORY_ISSUED/PARTIAL/COMPLETED/CLOSED) -
  // before that it still sits in inStockWarehouseId, so check availableStock there instead.
  const PRE_TRANSFER_STATUSES = [
    PRODUCTION_ORDER_STATUS.PENDING,
    PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL,
    PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED,
  ];
  const isPreTransfer = PRE_TRANSFER_STATUSES.includes(order.status);
  const stockCheckWarehouseId = isPreTransfer ? order.inStockWarehouseId : order.productionWarehouseId;
  const stockCheckWarehouseIdStr = stockCheckWarehouseId?.toString();
  const stockCheckWarehouse = stockCheckWarehouseIdStr
    ? (isPreTransfer ? inStockWarehouseMap : productionWarehouseMap).get(stockCheckWarehouseIdStr)
    : null;
  const rawMaterialInventories = rawMaterialIds.size
    ? await ItemInventory.find({ itemId: { $in: Array.from(rawMaterialIds) }, companyId })
        .select('itemId warehouses')
        .lean()
    : [];
  const rawMaterialStockMap = new Map();
  rawMaterialInventories.forEach(inv => {
    const warehouse = (inv.warehouses || []).find(w => w.warehouseId?.toString() === stockCheckWarehouseIdStr);
    rawMaterialStockMap.set(inv.itemId.toString(), warehouse?.availableStock ?? 0);
  });

  // Populate
  const populatedOrder = order.toObject();

  if (order.itemId) {
    const item = itemMap.get(order.itemId.toString());
    if (item) {
      populatedOrder.itemId = {
        _id: item._id,
        itemName: item.itemName,
        itemNo: item.itemNo,
        itemUnit: item.itemUnit,
      };
    }
  }

  if (order.salesOrderId) {
    const salesOrder = salesOrderMap.get(order.salesOrderId.toString());
    if (salesOrder) {
      populatedOrder.salesOrderId = {
        _id: salesOrder._id,
        orderId: salesOrder.orderId,
      };
    }
  }

  if (order.divisionId) {
    const division = divisionMap.get(order.divisionId.toString());
    if (division) {
      populatedOrder.divisionId = {
        _id: division._id,
        name: division.name,
      };
    }
  }

  if (order.branchId) {
    const branch = branchMap.get(order.branchId.toString());
    if (branch) {
      populatedOrder.branchId = {
        _id: branch._id,
        name: branch.name,
      };
    }
  }

  if (order.warehouseId) {
    const warehouse = warehouseMap.get(order.warehouseId.toString());
    if (warehouse) {
      populatedOrder.warehouseId = {
        _id: warehouse._id,
        name: warehouse.name,
      };
    }
  }

  if (order.dispatchWarehouseId) {
    const dispatchWarehouse = dispatchWarehouseMap.get(order.dispatchWarehouseId.toString());
    if (dispatchWarehouse) {
      populatedOrder.dispatchWarehouseId = {
        _id: dispatchWarehouse._id,
        name: dispatchWarehouse.name,
      };
    }
  }

  if (order.inStockWarehouseId) {
    const inStockWarehouse = inStockWarehouseMap.get(order.inStockWarehouseId.toString());
    if (inStockWarehouse) {
      populatedOrder.inStockWarehouseId = {
        _id: inStockWarehouse._id,
        name: inStockWarehouse.name,
      };
    }
  }

  if (order.productionWarehouseId) {
    const productionWarehouse = productionWarehouseMap.get(order.productionWarehouseId.toString());
    if (productionWarehouse) {
      populatedOrder.productionWarehouseId = {
        _id: productionWarehouse._id,
        name: productionWarehouse.name,
      };
    }
  }

  if (order.inventoryInwarehouseId) {
    const inventoryINWarehouse = inventoryINWarehouseMap.get(order.inventoryInwarehouseId.toString());
    if (inventoryINWarehouse) {
      populatedOrder.inventoryInwarehouseId = {
        _id: inventoryINWarehouse._id,
        name: inventoryINWarehouse.name,
      };
    }
  }

  // A material issue = stock currently available in stockCheckWarehouse can't cover what's
  // still left to consume for this raw material (productionOrderRequiredUnit - consumed - BOM RR).
  let materialIssuesCount = 0;
  if (order.rawMaterials) {
    populatedOrder.rawMaterials = order.rawMaterials.map(rm => {
      const populatedRm = {
        ...rm.toObject(),
      };
      if (rm.rawMaterialId) {
        const rawMaterial = rawMaterialMap.get(rm.rawMaterialId.toString());
        if (rawMaterial) {
          populatedRm.rawMaterialId = {
            _id: rawMaterial._id,
            itemName: rawMaterial.itemName,
            itemNo: rawMaterial.itemNo,
            itemUnit: rawMaterial.itemUnit,
          };
        }
        const availableStock = rawMaterialStockMap.get(rm.rawMaterialId.toString()) ?? 0;
        const remainingQty = Math.max(
          roundQty((rm.productionOrderRequiredUnit || 0) - (rm.productionOrderSubmittedUnit || 0) - (rm.bomRRQty || 0)),
          0,
        );
        const hasMaterialIssue = remainingQty > 0 && availableStock < remainingQty;

        populatedRm.remainingQty = remainingQty;
        populatedRm.availableStock = availableStock;
        populatedRm.availableStockWarehouse = stockCheckWarehouse
          ? { _id: stockCheckWarehouse._id, name: stockCheckWarehouse.name }
          : null;
        populatedRm.hasMaterialIssue = hasMaterialIssue;

        if (hasMaterialIssue) materialIssuesCount += 1;
      }
      return populatedRm;
    });
  }

  // Populate the order-level scrapOut rollup (BOM_BASED)
  if (order.scrapOut) {
    populatedOrder.scrapOut = order.scrapOut.map(sc => {
      const populatedScrap = {
        ...sc.toObject(),
      };
      if (sc.item) {
        const scrapItem = rawMaterialMap.get(sc.item.toString());
        if (scrapItem) {
          populatedScrap.item = {
            _id: scrapItem._id,
            itemName: scrapItem.itemName,
            itemNo: scrapItem.itemNo,
            itemUnit: scrapItem.itemUnit,
          };
        }
      }
      return populatedScrap;
    });
  }

  // Quantities are rounded to 3 decimals, same as the warehouse batch service, so float drift never reaches the client.
  populatedOrder.summary = {
    planned: roundQty(order.quantity || 0),
    produced: roundQty(order.totalFgSubmittedQty || 0),
    pending: Math.max(roundQty((order.quantity || 0) - (order.totalFgSubmittedQty || 0) - (order.totalFgRejectedQty || 0)), 0),
    submissions: order.submissionHistory?.length || 0,
    fgBatches: order.batches?.length || 0,
    // Count of raw materials that don't have enough stock available to cover what's still owed
    materialIssues: materialIssuesCount,
    totalScrap: roundQty((order.scrapOut || []).reduce((sum, sc) => sum + (sc.totalScrapOutQty || 0), 0)),
  };

  // Populate rawMaterialsConsumed in submissionHistory
  if (order.submissionHistory) {
    populatedOrder.submissionHistory = order.submissionHistory.map(submission => {
      const submissionCost = computeBomSubmissionCost(submission);
      const populatedSubmission = {
        ...submission.toObject(),
        submittedBy: populateSubmittedBy(submission.submittedBy),
        rejectedCost: submissionCost.rejectedCost,
      };
      if (submission.rawMaterialsConsumed) {
        populatedSubmission.rawMaterialsConsumed = submission.rawMaterialsConsumed.map((rm, rmIndex) => {
          const populatedRm = {
            ...rm.toObject(),
            rejectedValue: submissionCost.rejectedMaterials[rmIndex].cost,
          };
          if (rm.rawMaterialId) {
            const rawMaterial = rawMaterialMap.get(rm.rawMaterialId.toString());
            if (rawMaterial) {
              populatedRm.rawMaterialId = {
                _id: rawMaterial._id,
                itemName: rawMaterial.itemName,
                itemNo: rawMaterial.itemNo,
                itemUnit: rawMaterial.itemUnit,
              };
            }
          }
          return populatedRm;
        });
      }
      // Populate scrapOut.item in submissionHistory (BOM_BASED)
      if (submission.scrapOut) {
        populatedSubmission.scrapOut = submission.scrapOut.map(sc => {
          const populatedScrap = {
            ...sc.toObject(),
          };
          if (sc.item) {
            const scrapItem = rawMaterialMap.get(sc.item.toString());
            if (scrapItem) {
              populatedScrap.item = {
                _id: scrapItem._id,
                itemName: scrapItem.itemName,
                itemNo: scrapItem.itemNo,
                itemUnit: scrapItem.itemUnit,
              };
            }
          }
          return populatedScrap;
        });
      }
      // Populate manpowerCost in submissionHistory
      if (submission.manpowerCost) {
        populatedSubmission.manpowerCost = submission.manpowerCost.map(mc => {
          const populatedMc = {
            ...mc.toObject(),
          };
          if (mc.manpowerId) {
            const worker = manpowerCostMap.get(mc.manpowerId.toString());
            if (worker) {
              populatedMc.manpowerId = {
                _id: worker._id,
                workerName: worker.workerName,
              };
            }
          }
          return populatedMc;
        });
      }
      return populatedSubmission;
    });
  }

  // --- Populate productionOwner ---
  if (order.productionOwner) {
    populatedOrder.productionOwner = order.productionOwner.map(mpId => {
      const mp = productionOwnerMap.get(mpId.toString());
      if (mp) {
        return { _id: mp._id, workerName: mp.workerName };
      }
      return mpId;
    });
  }

  // Populate manPower_inventoryTransfer
  if (order.manPower_inventoryTransfer) {
    populatedOrder.manPower_inventoryTransfer = order.manPower_inventoryTransfer.map(mpId => {
      const mp = workerMap.get(mpId.toString());
      if (mp) {
        return { _id: mp._id, workerName: mp.workerName };
      }
      return mpId;
    });
  }

  if (createdByUser) {
    populatedOrder.createdBy = {
      _id: createdByUser._id,
      firstName: createdByUser.firstName,
      lastName: createdByUser.lastName,
      name: [createdByUser.firstName, createdByUser.lastName].filter(Boolean).join(' '),
    };
  }

  await attachActivityLogUsers(order, populatedOrder, User);
  await attachInventoryImpactLogDetails(order, populatedOrder, { Item, ItemBatch, Warehouse, User });
  attachInventoryImpactLogUnits(order, populatedOrder);

  const transferRequests = await InventoryTransferRequest.find({ productionOrderId: order._id, companyId })
    .select('transferId status fromWarehouseId toWarehouseId quantity notes referenceNumber rawMaterials createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const transferWarehouseIds = new Set();
  const transferItemIds = new Set();
  transferRequests.forEach(transfer => {
    if (transfer.fromWarehouseId) transferWarehouseIds.add(String(transfer.fromWarehouseId));
    if (transfer.toWarehouseId) transferWarehouseIds.add(String(transfer.toWarehouseId));
    transfer.rawMaterials?.forEach(rm => {
      if (rm.rawMaterialId) transferItemIds.add(String(rm.rawMaterialId));
    });
  });

  const [transferWarehouses, transferItems] = await Promise.all([
    transferWarehouseIds.size
      ? Warehouse.find({ _id: { $in: [...transferWarehouseIds] } })
          .select('name')
          .lean()
      : [],
    transferItemIds.size
      ? Item.find({ _id: { $in: [...transferItemIds] } })
          .select('itemName itemNo')
          .lean()
      : [],
  ]);
  const transferWarehouseMap = new Map(transferWarehouses.map(warehouse => [String(warehouse._id), warehouse.name]));
  const transferItemMap = new Map(transferItems.map(item => [String(item._id), item]));

  // Batches created in the destination warehouse by the transfer: sourceId = transfer request _id
  const transferBatches = transferRequests.length
    ? await ItemBatch.find({
        companyId,
        sourceType: 'PRODUCTIONORDER_STOCK_TRANSFER',
        sourceId: { $in: transferRequests.map(transfer => transfer._id) },
        ...(transferItemIds.size ? { itemId: { $in: [...transferItemIds] } } : {}),
      })
        .select(
          'itemId warehouseId batchNo userBatchNo vendorBatchNo vendorBatchExpiry quantity remainingQty purchasePrice sourceId referenceBatches',
        )
        .sort({ batchNo: 1 })
        .lean()
    : [];
  const transferBatchMap = new Map();
  transferBatches.forEach(batch => {
    const key = `${batch.sourceId}_${batch.itemId}`;
    if (!transferBatchMap.has(key)) transferBatchMap.set(key, []);
    transferBatchMap.get(key).push({
      _id: batch._id,
      batchNo: batch.batchNo,
      userBatchNo: batch.userBatchNo,
      vendorBatchNo: batch.vendorBatchNo,
      vendorBatchExpiry: batch.vendorBatchExpiry,
      quantity: batch.quantity,
      remainingQty: batch.remainingQty,
      purchasePrice: batch.purchasePrice,
      referenceBatches: batch.referenceBatches || [],
    });
  });

  const inventoryTransfers = transferRequests.map(transfer => ({
    ...transfer,
    fromWarehouseName: transfer.fromWarehouseId ? transferWarehouseMap.get(String(transfer.fromWarehouseId)) || null : null,
    toWarehouseName: transfer.toWarehouseId ? transferWarehouseMap.get(String(transfer.toWarehouseId)) || null : null,
    rawMaterials: (transfer.rawMaterials || []).map(rm => {
      const rmItem = rm.rawMaterialId ? transferItemMap.get(String(rm.rawMaterialId)) : null;
      return {
        ...rm,
        rawMaterialName: rmItem?.itemName || null,
        itemNo: rmItem?.itemNo || null,
        batches: transferBatchMap.get(`${transfer._id}_${rm.rawMaterialId}`) || [],
      };
    }),
  }));

  await populateItemUnits(
    populatedOrder,
    inventoryTransfers.flatMap(transfer => transfer.rawMaterials),
  );

  return {
    ...populatedOrder,
    id: order._id,
    inventoryTransfers,
  };
};

const getProcessBasedProductionOrderById = async (id, companyId) => {
  const { ProductionOrder, ManPower, Recipe } = getBooksModels();
  const { Item, SalesOrder, Division, Branch, Warehouse, ItemBatch } = getBooksCrmModels();
  const { User } = getCommonModels();

  const order = await ProductionOrder.findOne({ _id: id, companyId });
  if (!order) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
  }

  if (order.productionManageMethod !== 'PROCESS_ROUTE') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This production order is not a PROCESS_ROUTE production order');
  }

  // Collect all related IDs
  const itemIds = new Set();
  const salesOrderIds = new Set();
  const divisionIds = new Set();
  const branchIds = new Set();
  const warehouseIds = new Set();
  const dispatchWarehouseIds = new Set();
  const inStockWarehouseIds = new Set();
  const productionWarehouseIds = new Set();
  const inventoryInwarehouseIds = new Set();
  const workerIds = new Set();
  const nestedItemIds = new Set();
  const productionOwnerIds = new Set();

  if (order.itemId) itemIds.add(order.itemId);

  if (order.salesOrderId) salesOrderIds.add(order.salesOrderId);

  if (order.divisionId) divisionIds.add(order.divisionId);

  if (order.branchId) branchIds.add(order.branchId);

  if (order.warehouseId) warehouseIds.add(order.warehouseId);

  if (order.dispatchWarehouseId) dispatchWarehouseIds.add(order.dispatchWarehouseId);

  if (order.inStockWarehouseId) inStockWarehouseIds.add(order.inStockWarehouseId);

  if (order.productionWarehouseId) productionWarehouseIds.add(order.productionWarehouseId);

  if (order.inventoryInwarehouseId) inventoryInwarehouseIds.add(order.inventoryInwarehouseId);

  // Collect manPower_inventoryTransfer IDs
  order.manPower_inventoryTransfer?.forEach(manPowerId => {
    if (manPowerId) workerIds.add(manPowerId);
  });

  if (order.productionOwner && Array.isArray(order.productionOwner)) {
    order.productionOwner.forEach(element => {
      if (element) productionOwnerIds.add(element);
    });
  }

  // Users who started a process (proc.startedBy) or submitted against it (submission.submittedBy)
  const processUserIds = new Set();

  // Collect worker/item IDs used by each process, both its cumulative totals and its
  // per-submission entries (submitProcess rolls each submission into the process totals
  // but keeps the individual submissions too, under process.submissionHistory).
  order.processBased?.processes?.forEach(proc => {
    if (proc.startedBy) processUserIds.add(proc.startedBy);
    proc.manPower?.forEach(mp => {
      if (mp.workerId) workerIds.add(mp.workerId);
    });
    proc.processRawMaterialInput?.forEach(input => {
      if (input.item) nestedItemIds.add(input.item);
    });
    proc.scrapOutProcess?.forEach(scrap => {
      if (scrap.item) nestedItemIds.add(scrap.item);
    });
    proc.submissionHistory?.forEach(submission => {
      if (submission.submittedBy) processUserIds.add(submission.submittedBy);
      submission.manPower?.forEach(mp => {
        if (mp.workerId) workerIds.add(mp.workerId);
      });
      submission.processRawMaterialInput?.forEach(input => {
        if (input.item) nestedItemIds.add(input.item);
      });
      submission.scrapOutProcess?.forEach(scrap => {
        if (scrap.item) nestedItemIds.add(scrap.item);
      });
    });
  });

  const [
    items,
    salesOrders,
    divisions,
    branches,
    warehouses,
    dispatchWarehouses,
    inStockWarehouses,
    productionWarehouses,
    inventoryINWarehouses,
    workers,
    nestedItems,
    productionOwner,
    createdByUser,
    processUsers,
    recipe,
  ] = await Promise.all([
    Item.find({ _id: { $in: Array.from(itemIds) } }).select('itemName itemNo itemUnit'),
    SalesOrder.find({ _id: { $in: Array.from(salesOrderIds) } }).select('orderId'),
    Division.find({ _id: { $in: Array.from(divisionIds) } }).select('name'),
    Branch.find({ _id: { $in: Array.from(branchIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(warehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(dispatchWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inStockWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(productionWarehouseIds) } }).select('name'),
    Warehouse.find({ _id: { $in: Array.from(inventoryInwarehouseIds) } }).select('name'),
    ManPower.find({ _id: { $in: Array.from(workerIds) } }).select('workerName'),
    Item.find({ _id: { $in: Array.from(nestedItemIds) } }).select('itemName itemNo itemUnit'),
    ManPower.find({ _id: { $in: Array.from(productionOwnerIds) } }).select('workerName'),
    order.createdBy ? User.findById(order.createdBy).select('firstName lastName') : Promise.resolve(null),
    User.find({ _id: { $in: Array.from(processUserIds) } }).select('firstName lastName'),
    order.processBased?.recipeId ? Recipe.findById(order.processBased.recipeId).select('recipeId name') : Promise.resolve(null),
  ]);

  // Create Maps
  const itemMap = new Map(items.map(i => [i._id.toString(), i]));
  const salesOrderMap = new Map(salesOrders.map(so => [so._id.toString(), so]));
  const divisionMap = new Map(divisions.map(d => [d._id.toString(), d]));
  const branchMap = new Map(branches.map(b => [b._id.toString(), b]));
  const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w]));
  const dispatchWarehouseMap = new Map(dispatchWarehouses.map(wh => [wh._id.toString(), wh]));
  const inStockWarehouseMap = new Map(inStockWarehouses.map(wh => [wh._id.toString(), wh]));
  const productionWarehouseMap = new Map(productionWarehouses.map(wh => [wh._id.toString(), wh]));
  const inventoryINWarehouseMap = new Map(inventoryINWarehouses.map(wh => [wh._id.toString(), wh]));
  const workerMap = new Map(workers.map(w => [w._id.toString(), w]));
  const nestedItemMap = new Map(nestedItems.map(i => [i._id.toString(), i]));
  const productionOwnerMap = new Map(productionOwner.map(pq => [pq._id.toString(), pq]));

  // Populate
  const populatedOrder = order.toObject();

  if (order.itemId) {
    const item = itemMap.get(order.itemId.toString());
    if (item) {
      populatedOrder.itemId = {
        _id: item._id,
        itemName: item.itemName,
        itemNo: item.itemNo,
        itemUnit: item.itemUnit,
      };
    }
  }

  if (order.salesOrderId) {
    const salesOrder = salesOrderMap.get(order.salesOrderId.toString());
    if (salesOrder) {
      populatedOrder.salesOrderId = {
        _id: salesOrder._id,
        orderId: salesOrder.orderId,
      };
    }
  }

  if (order.divisionId) {
    const division = divisionMap.get(order.divisionId.toString());
    if (division) {
      populatedOrder.divisionId = {
        _id: division._id,
        name: division.name,
      };
    }
  }

  if (order.branchId) {
    const branch = branchMap.get(order.branchId.toString());
    if (branch) {
      populatedOrder.branchId = {
        _id: branch._id,
        name: branch.name,
      };
    }
  }

  if (order.warehouseId) {
    const warehouse = warehouseMap.get(order.warehouseId.toString());
    if (warehouse) {
      populatedOrder.warehouseId = {
        _id: warehouse._id,
        name: warehouse.name,
      };
    }
  }

  if (order.dispatchWarehouseId) {
    const dispatchWarehouse = dispatchWarehouseMap.get(order.dispatchWarehouseId.toString());
    if (dispatchWarehouse) {
      populatedOrder.dispatchWarehouseId = {
        _id: dispatchWarehouse._id,
        name: dispatchWarehouse.name,
      };
    }
  }

  if (order.inStockWarehouseId) {
    const inStockWarehouse = inStockWarehouseMap.get(order.inStockWarehouseId.toString());
    if (inStockWarehouse) {
      populatedOrder.inStockWarehouseId = {
        _id: inStockWarehouse._id,
        name: inStockWarehouse.name,
      };
    }
  }

  if (order.productionWarehouseId) {
    const productionWarehouse = productionWarehouseMap.get(order.productionWarehouseId.toString());
    if (productionWarehouse) {
      populatedOrder.productionWarehouseId = {
        _id: productionWarehouse._id,
        name: productionWarehouse.name,
      };
    }
  }

  if (order.inventoryInwarehouseId) {
    const inventoryINWarehouse = inventoryINWarehouseMap.get(order.inventoryInwarehouseId.toString());
    if (inventoryINWarehouse) {
      populatedOrder.inventoryInwarehouseId = {
        _id: inventoryINWarehouse._id,
        name: inventoryINWarehouse.name,
      };
    }
  }

  // PROCESS_ROUTE orders have no top-level rawMaterials/submissionHistory (those belong to the
  // BOM_BASED submission flow) - progress is tracked per-process instead, so the summary is
  // built off the route's processes rather than raw-material stock coverage.
  const processes = order.processBased?.processes || [];

  // Each process's processRawMaterialInput/scrapOutProcess already holds the cumulative total of all its
  // submissions, so summing those (not submissionHistory as well) avoids counting a submission twice.
  const sumItemValues = itemList => (itemList || []).reduce((sum, entry) => sum + (entry.value || 0), 0);

  populatedOrder.summary = {
    planned: order.quantity || 0,
    produced: order.totalFgSubmittedQty || 0,
    pending: Math.max(roundQty((order.quantity || 0) - (order.totalFgSubmittedQty || 0) - (order.totalFgRejectedQty || 0)), 0),
    totalProcesses: processes.length,
    completedProcesses: processes.filter(proc => proc.status === PROCESS_STATUS.COMPLETED).length,
    totalRawMaterialQty: roundQty(processes.reduce((sum, proc) => sum + sumItemValues(proc.processRawMaterialInput), 0)),
    totalScrap: roundQty(processes.reduce((sum, proc) => sum + sumItemValues(proc.scrapOutProcess), 0)),
  };

  // populatedOrder came from order.toObject(), so everything nested under processBased is
  // already a plain object/array here - no need to re-derive from the original mongoose doc.
  const processUserMap = new Map(processUsers.map(u => [u._id.toString(), u]));

  // Same shape as createdBy; falls back to the raw id if the user no longer exists.
  const populateUser = userId => {
    if (!userId) return userId;
    const user = processUserMap.get(userId.toString());
    if (!user) return userId;
    return {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    };
  };

  const populateManPower = manPowerList =>
    (manPowerList || []).map(mp => {
      const populatedMp = { ...mp };
      if (mp.workerId) {
        const worker = workerMap.get(mp.workerId.toString());
        if (worker) {
          populatedMp.workerId = { _id: worker._id, workerName: worker.workerName };
        }
      }
      return populatedMp;
    });

  // A raw-material deduction can span several FIFO batches; a row's batchNo is the distinct batch
  // numbers it drew from (or, for scrap, the batch it created), in order. Per-batch detail stays in `batches`.
  const toBatchNoLabel = batches =>
    [...new Set((batches || []).map(b => b?.batchNo).filter(n => n !== undefined && n !== null))].join(', ');

  const populateNestedItems = itemList =>
    (itemList || []).map(entry => {
      const populatedEntry = { ...entry, batchNo: toBatchNoLabel(entry.batches) };
      if (entry.item) {
        const nestedItem = nestedItemMap.get(entry.item.toString());
        if (nestedItem) {
          populatedEntry.item = {
            _id: nestedItem._id,
            itemName: nestedItem.itemName,
            itemNo: nestedItem.itemNo,
            itemUnit: nestedItem.itemUnit,
          };
        }
      }
      return populatedEntry;
    });

  // processBased.recipeId is an ObjectId ref; recipeName is already snapshotted on the order, so the
  // populated form only adds the recipe's own readable code alongside its current name.
  if (recipe) {
    populatedOrder.processBased.recipeId = {
      _id: recipe._id,
      recipeId: recipe.recipeId,
      name: recipe.name,
    };
  }

  if (populatedOrder.processBased?.processes) {
    // Resolve each process to its Process master by processNo (the master's own processId code).
    const { Process } = getBooksModels();
    const processNos = [...new Set(populatedOrder.processBased.processes.map(proc => proc.processNo).filter(Boolean))];
    const processMasters = processNos.length
      ? await Process.find({ companyId, processId: { $in: processNos } })
          .select('name processId')
          .lean()
      : [];
    const processMasterMap = new Map(processMasters.map(proc => [proc.processId, proc]));

    populatedOrder.processBased.processes = populatedOrder.processBased.processes.map(proc => ({
      ...proc,
      processId: processMasterMap.get(proc.processNo)?._id || null,
      // Input the process has received that is neither out nor rejected yet.
      pendingQty: Math.max(
        Math.round(((proc.processIN || 0) - (proc.processOUT || 0) - (proc.processRejection || 0)) * 1000) / 1000,
        0,
      ),
      startedBy: populateUser(proc.startedBy),
      manPower: populateManPower(proc.manPower),
      processRawMaterialInput: populateNestedItems(proc.processRawMaterialInput),
      scrapOutProcess: populateNestedItems(proc.scrapOutProcess),
      submissionHistory: (proc.submissionHistory || []).map(submission => ({
        ...submission,
        submittedBy: populateUser(submission.submittedBy),
        manPower: populateManPower(submission.manPower),
        processRawMaterialInput: populateNestedItems(submission.processRawMaterialInput),
        scrapOutProcess: populateNestedItems(submission.scrapOutProcess),
      })),
    }));
  }

  // Populate productionOwner
  if (order.productionOwner) {
    populatedOrder.productionOwner = order.productionOwner.map(mpId => {
      const mp = productionOwnerMap.get(mpId.toString());
      if (mp) {
        return { _id: mp._id, workerName: mp.workerName };
      }
      return mpId;
    });
  }

  // Populate manPower_inventoryTransfer
  if (order.manPower_inventoryTransfer) {
    populatedOrder.manPower_inventoryTransfer = order.manPower_inventoryTransfer.map(mpId => {
      const mp = workerMap.get(mpId.toString());
      if (mp) {
        return { _id: mp._id, workerName: mp.workerName };
      }
      return mpId;
    });
  }

  if (createdByUser) {
    populatedOrder.createdBy = {
      _id: createdByUser._id,
      firstName: createdByUser.firstName,
      lastName: createdByUser.lastName,
      name: [createdByUser.firstName, createdByUser.lastName].filter(Boolean).join(' '),
    };
  }

  await attachActivityLogUsers(order, populatedOrder, User);
  await attachInventoryImpactLogDetails(order, populatedOrder, { Item, ItemBatch, Warehouse, User });
  await populateItemUnits(populatedOrder);

  return {
    ...populatedOrder,
    id: order._id,
  };
};

const updateProductionOrderStatus = async (productionOrderId, companyId, status, isManuallyCompleted, userId) => {
  const { ProductionOrder, InventoryTransferRequest } = getBooksModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).session(session);
    if (!productionOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Production order not found');
    }

    const isUnhold = status === PRODUCTION_ORDER_STATUS_ACTION.UNHOLD;
    const isRevertManualCompletion = status === PRODUCTION_ORDER_STATUS_ACTION.REVERT_MANUAL_COMPLETION;
    let resolvedStatus = status;
    let resolvedIsManuallyCompleted = isManuallyCompleted;

    if (isUnhold) {
      if (![PRODUCTION_ORDER_STATUS.ON_HOLD, PRODUCTION_ORDER_STATUS.CLOSED].includes(productionOrder.status)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Production order is not on hold or closed');
      }

      resolvedStatus = await getStatusBeforeHold(productionOrder, session);
      resolvedIsManuallyCompleted = productionOrder.isManuallyCompleted;

      // Closing rejects a pending transfer request, so reopening raises a fresh one.
      if (
        productionOrder.status === PRODUCTION_ORDER_STATUS.CLOSED &&
        resolvedStatus === PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED
      ) {
        await raiseTransferRequest(productionOrder, userId, session);
        resolvedStatus = PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL;
      }
    } else if (isRevertManualCompletion) {
      if (productionOrder.status !== PRODUCTION_ORDER_STATUS.COMPLETED || !productionOrder.isManuallyCompleted) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Production order is not manually completed');
      }

      resolvedStatus = await deriveStatusFromOrderData(productionOrder, session);
      resolvedIsManuallyCompleted = false;
    } else if (status === PRODUCTION_ORDER_STATUS.ON_HOLD) {
      // Holding must not clear the manual-completion flag, since unhold derives COMPLETED from it.
      resolvedIsManuallyCompleted = productionOrder.isManuallyCompleted;
    }

    if (resolvedStatus === PRODUCTION_ORDER_STATUS.CLOSED) {
      if (!ALLOWED_STATUSES_FOR_CLOSE.includes(productionOrder.status)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Production order can be marked as closed only when status is ${ALLOWED_STATUSES_FOR_CLOSE.join(', ')}`,
        );
      }

      // When closing while the transfer is still pending, reject it so it can no longer be approved.
      if (productionOrder.status === PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL) {
        await InventoryTransferRequest.updateMany(
          { productionOrderId, status: INVENTORY_TRANSFER_REQUEST.PENDING },
          {
            $set: { status: INVENTORY_TRANSFER_REQUEST.REJECTED, updatedAt: new Date(), updatedBy: userId },
          },
          { session },
        );
      }
    }

    const previousStatus = productionOrder.status;
    productionOrder.status = resolvedStatus;
    productionOrder.isManuallyCompleted = resolvedIsManuallyCompleted;

    const isManualCompletion = resolvedStatus === PRODUCTION_ORDER_STATUS.COMPLETED && resolvedIsManuallyCompleted;

    logProductionOrderActivity(productionOrder, {
      action: PRODUCTION_ORDER_ACTIVITY_TYPE.STATUS_CHANGED,
      description: isUnhold
        ? `Status changed from ${previousStatus} to ${resolvedStatus} (${previousStatus === PRODUCTION_ORDER_STATUS.CLOSED ? 'reopened' : 'unhold'})`
        : isRevertManualCompletion
          ? `Status changed from ${previousStatus} to ${resolvedStatus} (manual completion reverted)`
          : isManualCompletion
            ? `Status changed from ${previousStatus} to ${resolvedStatus} (marked as completed manually)`
            : `Status changed from ${previousStatus} to ${resolvedStatus}`,
      userId,
      metadata: { previousStatus, newStatus: resolvedStatus, isManuallyCompleted: resolvedIsManuallyCompleted },
    });

    productionOrder.updatedBy = userId;

    // Crossing into or out of a terminal status moves where the order's unaccounted cost belongs -
    // work in progress while it is still running, a loss once it is closed - so the journal is
    // rebuilt whenever the status crosses that line.
    if (TERMINAL_PRODUCTION_STATUSES.includes(resolvedStatus) !== TERMINAL_PRODUCTION_STATUSES.includes(previousStatus)) {
      if (productionOrder.productionManageMethod === 'BOM_BASED') {
        await postBomBasedProductionLedger(productionOrder, productionOrder.companyId, userId, session);
      } else {
        await applyProcessRouteCompletionEffects({ productionOrder, userId, session });
      }
    }

    await productionOrder.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return productionOrder;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const reorderProcesses = async (productionOrderId, companyId, processOrder, isLocked, userId) => {
  const { ProductionOrder } = getBooksModels();
  const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId });

  if (!productionOrder) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
  }

  if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE' || !productionOrder.processBased) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Process sequence can only be rearranged for PROCESS_ROUTE production orders');
  }

  // A closed, completed or on-hold order is finished (or paused) - its process sequence is final.
  if (
    [PRODUCTION_ORDER_STATUS.CLOSED, PRODUCTION_ORDER_STATUS.COMPLETED, PRODUCTION_ORDER_STATUS.ON_HOLD].includes(
      productionOrder.status,
    )
  ) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot rearrange the process sequence on a ${productionOrder.status.toLowerCase()} production order`,
    );
  }

  const { processes } = productionOrder.processBased;

  if (processes.some(process => process.startDatetime)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Process sequence cannot be rearranged once a process has started');
  }

  const currentProcessIds = processes.map(process => process._id.toString());
  const requestedProcessIds = processOrder.map(id => id.toString());

  const isSameSet =
    currentProcessIds.length === requestedProcessIds.length &&
    currentProcessIds.every(id => requestedProcessIds.includes(id)) &&
    new Set(requestedProcessIds).size === requestedProcessIds.length;

  if (!isSameSet) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Reordered processes must exactly match the processes already on this production order',
    );
  }

  const desiredIndexByProcessId = new Map(requestedProcessIds.map((id, index) => [id, index]));

  const sequenceChanged = currentProcessIds.some((id, index) => id !== requestedProcessIds[index]);
  const wasLocked = productionOrder.isLocked;

  productionOrder.isLocked = isLocked;
  processes.sort((a, b) => desiredIndexByProcessId.get(a._id.toString()) - desiredIndexByProcessId.get(b._id.toString()));
  productionOrder.markModified('processBased.processes');

  if (sequenceChanged) {
    logProductionOrderActivity(productionOrder, {
      action: PRODUCTION_ORDER_ACTIVITY_TYPE.SEQUENCE_REARRANGED,
      description: `Process sequence rearranged: ${processes.map(p => p.processName).join(' → ')}`,
      userId,
      metadata: {
        previousOrder: currentProcessIds,
        newOrder: requestedProcessIds,
        processNames: processes.map(p => ({ processId: p._id, processName: p.processName })),
      },
    });
  }

  if (wasLocked !== isLocked) {
    logProductionOrderActivity(productionOrder, {
      action: isLocked ? PRODUCTION_ORDER_ACTIVITY_TYPE.SEQUENCE_LOCKED : PRODUCTION_ORDER_ACTIVITY_TYPE.SEQUENCE_UNLOCKED,
      description: isLocked ? 'Process sequence locked for this order' : 'Process sequence unlocked for this order',
      userId,
    });
  }

  productionOrder.updatedBy = userId;

  await productionOrder.save();

  return productionOrder;
};

/**
 * Re-raise an inventory transfer request for a production order that was rejected.
 * The existing rejected ITR is preserved for audit; a fresh PENDING ITR is created
 * and the production order status reverts to WAITING_FOR_INVENTORY_APPROVAL.
 */
// Raises a fresh PENDING transfer request with the order's raw materials and warehouses.
const raiseTransferRequest = async (productionOrder, userId, session) => {
  const { InventoryTransferRequest } = getBooksModels();
  const { companyId } = productionOrder;

  // Determine next transfer number
  const latestITR = await InventoryTransferRequest.findOne({ companyId }, { transferId: 1 }, { sort: { createdAt: -1 } }).session(
    session,
  );

  let nextTransferNumber = 1;
  if (latestITR?.transferId) {
    const match = latestITR.transferId.match(/TRF(\d+)/);
    if (match) nextTransferNumber = parseInt(match[1], 10) + 1;
  }

  await InventoryTransferRequest.create(
    [
      {
        transferId: `TRF${nextTransferNumber}`,
        companyId,
        itemId: productionOrder.itemId,
        fromWarehouseId: productionOrder.inStockWarehouseId,
        toWarehouseId: productionOrder.productionWarehouseId,
        quantity: productionOrder.quantity,
        rawMaterials: productionOrder.rawMaterials.map(rm => ({
          rawMaterialId: rm.rawMaterialId,
          perItemRequiredUnit: rm.perItemRequiredUnit,
          productionOrderRequiredUnit: rm.productionOrderRequiredUnit,
        })),
        isProductionOrderReq: true,
        productionOrderId: productionOrder._id,
        referenceNumber: productionOrder.productionOrderCode,
        addedBy: userId,
        updatedBy: userId,
        date: new Date(),
      },
    ],
    { session },
  );

  logProductionOrderActivity(productionOrder, {
    action: PRODUCTION_ORDER_ACTIVITY_TYPE.TRANSFER_REQUEST_RERAISED,
    description: `Inventory transfer request re-raised (TRF${nextTransferNumber})`,
    userId,
    metadata: { transferId: `TRF${nextTransferNumber}` },
  });
};

const reRaiseTransferRequest = async (productionOrderId, companyId, userId) => {
  const { ProductionOrder } = getBooksModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).session(session);
    if (!productionOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Production order not found');
    }

    if (productionOrder.status !== PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Transfer request can only be re-raised when production order status is INVENTORY_REJECTED',
      );
    }

    if (productionOrder.productionManageMethod !== 'BOM_BASED') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Re-raise is only applicable to BOM_BASED production orders');
    }

    await raiseTransferRequest(productionOrder, userId, session);

    // Revert production order to waiting for approval
    productionOrder.status = PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL;

    productionOrder.updatedBy = userId;
    await productionOrder.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return productionOrder;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteProductionOrderById = async (productionOrderId, companyId, userId) => {
  const { ProductionOrder, InventoryTransferRequest } = getBooksModels();
  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).session(session);
    if (!productionOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, PRODUCTION_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const noActionTakenOnOrder =
      [PRODUCTION_ORDER_STATUS.PENDING, PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL].includes(
        productionOrder.status,
      ) &&
      !productionOrder.submissionHistory?.length &&
      (productionOrder.totalFgSubmittedQty || 0) === 0 &&
      (productionOrder.totalFgRejectedQty || 0) === 0 &&
      !productionOrder.processBased?.processes?.some(process => process.startDatetime);

    if (!noActionTakenOnOrder) {
      throw new ApiError(httpStatus.BAD_REQUEST, PRODUCTION_ORDER_MESSAGES.DELETE_NOT_ALLOWED);
    }

    const relatedTransferRequests = await InventoryTransferRequest.find({ productionOrderId }).session(session);
    const allTransferRequestsPending = relatedTransferRequests.every(itr => itr.status === INVENTORY_TRANSFER_REQUEST.PENDING);

    if (!allTransferRequestsPending) {
      throw new ApiError(httpStatus.BAD_REQUEST, PRODUCTION_ORDER_MESSAGES.DELETE_NOT_ALLOWED);
    }

    if (relatedTransferRequests.length) {
      await InventoryTransferRequest.deleteMany({ productionOrderId }, { session });
    }

    await ProductionOrder.deleteOne({ _id: productionOrderId, companyId }, { session });

    if (productionOrder.salesOrderId) {
      await syncSalesOrderProductionStatus(productionOrder.salesOrderId, companyId, session);
    }

    await session.commitTransaction();
    return productionOrder;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getProcessRouteMaterialConsumption = async (productionOrderId, companyId) => {
  const { ProductionOrder } = getBooksModels();
  const { Item, Warehouse, ItemInventory } = getBooksCrmModels();

  const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).lean();
  if (!productionOrder) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
  }

  if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Material consumption is only applicable to PROCESS_ROUTE production orders');
  }

  const processes = productionOrder.processBased?.processes || [];

  // Flatten every process's raw-material lines into rows, keeping the process each one belongs to.
  const rows = [];
  const itemIds = new Set();
  const warehouseIds = new Set();

  for (const process of processes) {
    for (const rawMaterial of process.processRawMaterialInput || []) {
      if (!rawMaterial.item) continue;

      const batches = rawMaterial.batches || [];
      const warehouseId = batches[0]?.warehouseId || productionOrder.productionWarehouseId;
      const batchNumbers = [
        ...new Set(batches.map(batch => batch.batchNo).filter(batchNo => batchNo !== undefined && batchNo !== null)),
      ];

      itemIds.add(rawMaterial.item.toString());
      if (warehouseId) warehouseIds.add(warehouseId.toString());

      rows.push({
        processNo: process.processNo,
        processName: process.processName,
        processId: process._id,
        item: rawMaterial.item,
        consumed: rawMaterial.value || 0,
        batches: toBatchRefs(batches),
        batchNumbers,
        warehouseId,
      });
    }
  }

  const [items, warehouses, itemInventories] = await Promise.all([
    Item.find({ _id: { $in: [...itemIds] } })
      .select('itemName itemNo itemUnit')
      .lean(),
    Warehouse.find({ _id: { $in: [...warehouseIds] } })
      .select('name')
      .lean(),
    ItemInventory.find({ itemId: { $in: [...itemIds] }, companyId }).lean(),
  ]);

  const itemById = new Map(items.map(item => [item._id.toString(), item]));
  const warehouseById = new Map(warehouses.map(warehouse => [warehouse._id.toString(), warehouse]));
  const inventoryByItemId = new Map(itemInventories.map(inventory => [inventory.itemId.toString(), inventory]));

  return rows.map(row => {
    const item = itemById.get(row.item.toString());
    const warehouse = row.warehouseId ? warehouseById.get(row.warehouseId.toString()) : null;
    const inventory = inventoryByItemId.get(row.item.toString());
    const warehouseStock = inventory?.warehouses?.find(w => w.warehouseId?.toString() === row.warehouseId?.toString());

    return {
      processNo: row.processNo,
      processId: row.processId,
      processName: row.processName,
      itemId: item,
      itemName: item?.itemName || '-',
      itemNo: item?.itemNo || '-',
      itemUnit: item?.itemUnit || '-',
      batches: row.batches,
      batchNo: row.batchNumbers.length ? row.batchNumbers.join(', ') : '-',
      warehouseName: warehouse?.name || '-',
      consumed: row.consumed,
      availableStock: warehouseStock?.availableStock || 0,
    };
  });
};

// Distinct batches as [{ batchNo, batchId }], so callers don't have to split comma-joined strings.
const toBatchRefs = (batches = []) => {
  const seen = new Set();
  const refs = [];
  for (const batch of batches) {
    const batchId = batch?.itemBatchId?.toString();
    const batchNo = batch?.batchNo ?? null;
    if (!batchId && batchNo === null) continue;
    const key = batchId || `no:${batchNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ batchNo, itemBatchId: batchId || null });
  }
  return refs;
};

const getProcessRouteScrapAndRejection = async (productionOrderId, companyId) => {
  const { ProductionOrder } = getBooksModels();
  const { Item, Warehouse } = getBooksCrmModels();

  const productionOrder = await ProductionOrder.findOne({ _id: productionOrderId, companyId }).lean();
  if (!productionOrder) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Production Order not found');
  }

  if (productionOrder.productionManageMethod !== 'PROCESS_ROUTE') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Scrap and rejection is only applicable to PROCESS_ROUTE production orders');
  }

  const processes = productionOrder.processBased?.processes || [];

  const scrapRows = [];
  const rejectionRows = [];
  const itemIds = new Set();
  const warehouseIds = new Set();

  // processRejection has no batch/warehouse of its own — it is rejected output of the
  // order's finished good, so it's located the same way as that item.
  if (productionOrder.itemId) itemIds.add(productionOrder.itemId.toString());
  if (productionOrder.inventoryInwarehouseId) warehouseIds.add(productionOrder.inventoryInwarehouseId.toString());

  for (const process of processes) {
    for (const scrap of process.scrapOutProcess || []) {
      if (!scrap.item) continue;

      const batches = scrap.batches || [];
      const warehouseId = batches[0]?.warehouseId;
      const value = batches.reduce((sum, batch) => sum + (batch.quantity || 0) * (batch.purchasePrice || 0), 0);

      itemIds.add(scrap.item.toString());
      if (warehouseId) warehouseIds.add(warehouseId.toString());

      scrapRows.push({
        processNo: process.processNo,
        processName: process.processName,
        processId: process._id,
        item: scrap.item,
        quantity: scrap.value || 0,
        batches: toBatchRefs(batches),
        warehouseId,
        value: Math.round(value * 100) / 100,
      });
    }

    if (process.processRejection) {
      rejectionRows.push({
        processNo: process.processNo,
        processName: process.processName,
        processId: process._id,
        item: productionOrder.itemId,
        quantity: process.processRejection,
        warehouseId: productionOrder.inventoryInwarehouseId,
      });
    }
  }

  const [items, warehouses] = await Promise.all([
    Item.find({ _id: { $in: [...itemIds] } })
      .select('itemName itemNo itemUnit purchaseInformation.costPrice')
      .lean(),
    Warehouse.find({ _id: { $in: [...warehouseIds] } })
      .select('name')
      .lean(),
  ]);

  const itemById = new Map(items.map(item => [item._id.toString(), item]));
  const warehouseById = new Map(warehouses.map(warehouse => [warehouse._id.toString(), warehouse]));

  const scrap = scrapRows.map(row => {
    const item = itemById.get(row.item.toString());
    const warehouse = row.warehouseId ? warehouseById.get(row.warehouseId.toString()) : null;

    return {
      processNo: row.processNo,
      processId: row.processId,
      processName: row.processName,
      itemId: item,
      itemName: item?.itemName || '-',
      itemNo: item?.itemNo || '-',
      itemUnit: item?.itemUnit || '-',
      quantity: row.quantity,
      batches: row.batches,
      warehouseName: warehouse?.name || '-',
      value: row.value,
    };
  });

  // Rejected units never go into stock, so they have no batch; their value is the same rejected cost the
  // Cost Breakdown and the journal use. Older orders whose submissions carry no cost show 0.
  const { rejectedCostByProcess } = summarizeProcessRouteCost(productionOrder);

  const rejection = rejectionRows.map(row => {
    const item = row.item ? itemById.get(row.item.toString()) : null;
    const warehouse = row.warehouseId ? warehouseById.get(row.warehouseId.toString()) : null;
    const value = rejectedCostByProcess.get(String(row.processId)) || 0;

    return {
      processNo: row.processNo,
      processId: row.processId,
      processName: row.processName,
      itemId: item,
      itemName: item?.itemName || '-',
      itemNo: item?.itemNo || '-',
      itemUnit: item?.itemUnit || '-',
      quantity: row.quantity,
      batches: [],
      warehouseName: warehouse?.name || '-',
      value: Math.round(value * 100) / 100,
    };
  });

  return { scrap, rejection };
};

module.exports = {
  getItemProductionData,
  createProductionOrder: withTransientRetry(createProductionOrder),
  queryProductionOrders,
  removeMultipleItemStocks,
  submitProductionOrderrById,
  startProcess,
  endProcess,
  submitProcess,
  deleteProcessSubmission,
  editProcessSubmission,
  getSalesOrdersForDropdown,
  syncSalesOrderProductionStatus,
  getProductionOrdersById,
  getBomBasedProductionOrderById,
  getProcessBasedProductionOrderById,
  getProcessRouteMaterialConsumption,
  getProcessRouteScrapAndRejection,
  summarizeProcessRouteCost,
  computeBomBasedCostToDate,
  computeBomSubmissionCost,
  postBomBasedProductionLedger,
  applyProcessRouteCompletionEffects,
  updateProductionOrderStatus,
  reRaiseTransferRequest,
  deleteProductionOrderById,
  reorderProcesses,
  editSubmissionHistory,
  deleteSubmissionHistory,
};
