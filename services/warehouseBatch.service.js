const mongoose = require('mongoose');
const { getBooksCrmModels, getBooksModels } = require('./model.service');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');
const logger = require('../config/logger');
const { STOCK_STATUS } = require('../utils/enum');
const { emitNotificationToUser } = require('../socket/handlers/notification.handler');
const { buildEnvelope, publishRealtimeEvent } = require('./realtimeEvent.publisher');
const {
  NOTIFICATION_TYPE,
  NOTIFICATION_ACTOR_TYPE,
  DEVICE_USER_TYPE,
  MODULE_NAMES,
} = require('@smit9313/abss-models-core/src/utils/enum');

const STOCK_ALERT_CONTENT = {
  [STOCK_STATUS.BELOW_MINIMUM]: {
    title: 'Stock Below Minimum',
    body: (itemName, itemNo) => `${itemName} (${itemNo}) stock has fallen below the minimum level.`,
  },
  [STOCK_STATUS.ABOVE_MAXIMUM]: {
    title: 'Stock Above Maximum',
    body: (itemName, itemNo) => `${itemName} (${itemNo}) stock has exceeded the maximum level.`,
  },
};

const VALUE_GUARD_EPSILON = 0.01;

function roundQty(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

// Every price stored on a batch or on one of its deductions is kept to 2 decimals.
function roundPrice(value) {
  return Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

/**
 * Stock only moves for an item whose quantity and value we keep: a service has no
 * stock at all, and an item with inventory tracking turned off is expensed when
 * bought instead of being held as an asset. An item that has not been migrated yet
 * has no trackInventory flag and keeps its existing behaviour.
 */
async function isStockTrackedItem({ itemId, companyId, session }) {
  if (!itemId || !companyId) return true;
  const { Item } = getBooksCrmModels();
  const item = await Item.findOne({ _id: itemId, companyId })
    .select('itemCategory.isService trackInventory')
    .session(session || null)
    .lean();
  return item?.itemCategory?.isService !== true && item?.trackInventory !== false;
}

async function getUntrackedProductionItems({ itemIds, companyId, session }) {
  const uniqueIds = [...new Set((itemIds || []).filter(Boolean).map(String))];
  if (!uniqueIds.length) return [];

  const { Item } = getBooksCrmModels();
  return Item.find({
    _id: { $in: uniqueIds },
    companyId,
    trackInventory: false,
    'itemCategory.isService': { $ne: true },
  })
    .select('itemName')
    .session(session || null)
    .lean();
}

async function handleWarehouseStock({ action, stockData, session }) {
  let result;
  if (!(await isStockTrackedItem({ itemId: stockData?.itemId, companyId: stockData?.companyId, session }))) {
    if (action === 'deductStock' || action === 'inventoryTransferDeduction') {
      return [];
    }
    if (action === 'addStock' || action === 'addOpeningStockBatch' || action === 'updateGrpoAndBillBatchQty') {
      return {
        skipped: true,
        reason: 'STOCK_NOT_TRACKED',
        action,
      };
    }
    return {
      success: true,
      skipped: true,
      reason: 'STOCK_NOT_TRACKED',
      action,
      deductedValue: 0,
      deductedQty: 0,
      qtyReversed: 0,
    };
  }

  switch (action) {
    case 'addStock':
      result = await addStock({ stockData, session });
      break;

    case 'addOpeningStockBatch':
      result = await addOpeningStockBatch({ stockData, session });
      break;

    case 'deductStock':
      result = await deductStock({ stockData, session });
      break;

    case 'inventoryTransferDeduction':
      result = await inventoryTransferDeduction({ stockData, session });
      break;

    case 'reverseDeduction':
      result = await reverseDeduction({ stockData, session });
      break;

    case 'deleteStock':
      result = await deleteStockBySource({ stockData, session });
      break;

    case 'handleNegativeAdjustment':
      result = await deductStockQuantityWithoutSourceID({ stockData, session });
      break;

    case 'updateGrpoAndBillBatchQty':
      result = await updateGrpoAndBillBatchQty({ stockData, session });
      break;

    default:
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid action type');
  }

  return result;
}

// Batches are stored in the item's base unit, so the batch carries the item's itemUnitId.
async function resolveItemUnitId(itemId, itemUnitId, session) {
  if (itemUnitId) return itemUnitId;
  const { Item } = getBooksCrmModels();
  const item = await Item.findById(itemId)
    .select('itemUnitId')
    .session(session || null)
    .lean();
  return item?.itemUnitId || null;
}

// Document quantities arrive in the unit the row was entered in (itemUnitId on the item row).
// unitConversions holds baseQty main units per qty of that unit; no unit or the main unit → factor 1.
function resolveUnitConversion(item, docUnitId) {
  if (!docUnitId || String(docUnitId) === String(item?.itemUnitId)) return 1;
  const conversion = (item?.unitConversions || []).find(c => String(c.itemUnitId) === String(docUnitId));
  if (!conversion || !conversion.qty) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Selected unit is not configured for item: ${item?.itemName}`);
  }
  return conversion.baseQty / conversion.qty;
}

// Stock valuation is kept in the item's base unit. A batch's purchasePrice is per its purchase unit and
// conversionFactor is base units per purchase unit, so the base-unit rate is purchasePrice / conversionFactor
// (e.g. 1 pc = 0.01 box, 100 pcs @ 20 -> 1 box @ 2000; value = 1 x 2000 = 100 x 20).
function toBaseRate(rate, conversionFactor) {
  return (rate || 0) / (conversionFactor || 1);
}

function batchBaseRate(batch) {
  return toBaseRate(batch?.purchasePrice, batch?.conversionFactor);
}

// Batch entries copied onto documents (items[].batches[]) pair a main-unit quantity with a price, and every
// cost/ledger consumer multiplies the two. So what we hand back carries the per-main-unit price, while the
// stored batch keeps the price as entered.
function toBatchSummary(batch) {
  const plain = typeof batch.toObject === 'function' ? batch.toObject() : { ...batch };
  return { ...plain, purchasePrice: batchBaseRate(batch) };
}

// Item master rates recorded on the batch as documentUnitRate: purchaseInformation.costPrice on
// the batch, salesInformation.sellingPrice on its deductions.
async function getItemMasterRates(itemId, session) {
  const { Item } = getBooksCrmModels();
  const item = await Item.findById(itemId)
    .select('purchaseInformation.costPrice salesInformation.sellingPrice')
    .session(session || null)
    .lean();
  return {
    costPrice: roundPrice(item?.purchaseInformation?.costPrice),
    sellingPrice: roundPrice(item?.salesInformation?.sellingPrice),
  };
}

async function addStock({ stockData, session }) {
  const {
    itemId,
    companyId,
    divisionId,
    branchId,
    warehouseId,
    quantity: purchaseQty,
    purchasePrice: purchaseRate,
    vendorBatchNo,
    userBatchNo,
    vendorBatchExpiry,
    sourceType,
    sourceId,
    addedBy,
    referenceBatches,
    itemUnitId: purchaseUnitId,
    baseQuantity,
    rateIsBase,
  } = stockData;

  const { ItemBatch, Item } = getBooksCrmModels();

  // Batches are kept in the item main unit: only the quantity is converted, the rate is stored as entered.
  const item = await Item.findById(itemId)
    .select('itemName itemUnitId unitConversions purchaseInformation.costPrice')
    .session(session || null)
    .lean();
  const conversionFactor = resolveUnitConversion(item, purchaseUnitId);
  // baseQuantity: caller already holds the exact main-unit quantity (e.g. a transfer re-adding what it deducted).
  const quantity = baseQuantity ?? roundQty(purchaseQty * conversionFactor);
  // rateIsBase: the caller's rate is a cost per main unit, so it is stored per the given unit like any other rate.
  const purchasePrice = roundPrice(rateIsBase ? purchaseRate * conversionFactor : purchaseRate);

  /**
   * 1️⃣ Get last batch number for this item + warehouse
   * (keeps batch numbers sequential per location)
   */
  const lastBatch = await ItemBatch.findOne(
    {
      itemId,
      companyId,
      warehouseId,
    },
    { batchNo: 1 },
    { session },
  )
    .sort({ batchNo: -1 })
    .lean();

  const batchNo = lastBatch ? lastBatch.batchNo + 1 : 1;

  /**
   * 2️⃣ Create new batch document
   */
  const batch = await ItemBatch.create(
    [
      {
        itemId,
        companyId,
        divisionId,
        branchId,
        warehouseId,
        batchNo,
        quantity: roundQty(quantity),
        remainingQty: roundQty(quantity),
        purchasePrice,
        documentUnitRate: roundPrice(item?.purchaseInformation?.costPrice),
        vendorBatchNo: vendorBatchNo || null,
        userBatchNo: userBatchNo || null,
        vendorBatchExpiry: vendorBatchExpiry || null,
        sourceType,
        sourceId,
        deductions: [],
        referenceBatches: referenceBatches || [],
        itemUnitId: item?.itemUnitId || null,
        purchaseUnitId: purchaseUnitId || item?.itemUnitId || null,
        purchaseQuantity: roundQty(purchaseQty),
        conversionFactor,
        addedBy,
      },
    ],
    session ? { session } : {},
  );

  await updateWarehouseInventory({
    itemId,
    companyId,
    warehouseId,
    branchId,
    divisionId,
    stockDelta: quantity,
    valueDelta: quantity * toBaseRate(purchasePrice, conversionFactor),
    session,
  });

  return toBatchSummary(batch[0]);
}
async function addOpeningStockBatch({ stockData, session }) {
  const {
    itemId,
    companyId,
    divisionId,
    branchId,
    warehouseId,
    quantity,
    purchasePrice,
    vendorBatchNo,
    userBatchNo,
    vendorBatchExpiry,
    sourceType,
    sourceId,
    addedBy,
    itemUnitId,
  } = stockData;

  const { ItemBatch } = getBooksCrmModels();

  /**
   * 1️⃣ Get last batch number for this item + warehouse
   * (keeps batch numbers sequential per location)
   */
  const lastBatch = await ItemBatch.findOne(
    {
      itemId,
      companyId,
      warehouseId,
    },
    { batchNo: 1 },
    { session },
  )
    .sort({ batchNo: -1 })
    .lean();

  const batchNo = lastBatch ? lastBatch.batchNo + 1 : 1;

  /**
   * 2️⃣ Create new batch document
   */
  // Opening stock is always entered in the item's main unit: purchase unit is the main unit, factor 1.
  const mainUnitId = await resolveItemUnitId(itemId, itemUnitId, session);
  const { costPrice } = await getItemMasterRates(itemId, session);
  const batch = await ItemBatch.create(
    [
      {
        itemId,
        companyId,
        divisionId,
        branchId,
        warehouseId,
        batchNo,
        quantity,
        remainingQty: roundQty(quantity),
        purchasePrice: roundPrice(purchasePrice),
        documentUnitRate: costPrice,
        vendorBatchNo: vendorBatchNo || null,
        userBatchNo: userBatchNo || null,
        vendorBatchExpiry: vendorBatchExpiry || null,
        sourceType,
        sourceId,
        deductions: [],
        itemUnitId: mainUnitId,
        purchaseUnitId: mainUnitId,
        purchaseQuantity: roundQty(quantity),
        conversionFactor: 1,
        addedBy,
      },
    ],
    session ? { session } : {},
  );

  return batch[0];
}

async function deductStock({ stockData, session }) {
  const {
    itemId,
    companyId,
    branchId,
    warehouseId,
    quantity: sellingQty,
    deductedSourceType,
    deductedSourceId,
    sellingPrice,
    itemUnitId: sellingUnitId,
  } = stockData;

  const { ItemBatch, Item, Warehouse } = getBooksCrmModels();

  // Fetch item details and available batches in parallel
  const [item, warehouse, batches] = await Promise.all([
    Item.findById(itemId)
      .select('itemName itemUnitId unitConversions salesInformation.sellingPrice')
      .session(session || null)
      .lean(),
    Warehouse.findById(warehouseId).select('name').lean(),
    ItemBatch.find({ itemId, companyId, warehouseId, remainingQty: { $gt: 0 } }, null, session ? { session } : {}).sort({
      batchNo: 1,
    }), // FIFO
  ]);

  if (!batches.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Insufficient stock in warehosue ${warehouse?.name} for item: ${item?.itemName}`);
  }

  // Batches hold the item's main unit. The document quantity arrives in the unit it was
  // sold in (itemUnitId on the item row); convert it to main unit via unitConversions
  // (baseQty main units per qty selling units). No unit, or the main unit → factor 1.
  const conversionFactor = resolveUnitConversion(item, sellingUnitId);
  const quantity = roundQty(sellingQty * conversionFactor);

  let qtyToDeduct = quantity;
  const deductionSummary = [];
  let totalInventoryValueDeducted = 0;

  // Deduct stock batch by batch (must be sequential — each batch affects the next)
  for (const batch of batches) {
    if (qtyToDeduct <= 0) break;

    const deductQty = roundQty(Math.min(batch.remainingQty, qtyToDeduct));
    // sellingPrice is per selling unit; the fallback is the batch cost expressed in that same unit.
    const effectiveSellingPrice = roundPrice(sellingPrice ?? batchBaseRate(batch) * conversionFactor);

    batch.deductions.push({
      deductedSourceType,
      deductedSourceId,
      quantityDeducted: deductQty,
      deductedAt: new Date(),
      sellingPrice: effectiveSellingPrice,
      documentUnitRate: roundPrice(item?.salesInformation?.sellingPrice),
      sellingUnitId: sellingUnitId || item?.itemUnitId || null,
      sellingQuantity: roundQty(deductQty / conversionFactor),
      conversionFactor,
    });

    batch.remainingQty = roundQty(batch.remainingQty - deductQty);
    qtyToDeduct = roundQty(qtyToDeduct - deductQty);
    totalInventoryValueDeducted += deductQty * batchBaseRate(batch);

    deductionSummary.push({
      batchNo: batch.batchNo,
      quantity: deductQty,
      purchasePrice: batchBaseRate(batch),
      warehouseId: batch?.warehouseId,
      itemBatchId: batch?._id,
      sellingPrice: effectiveSellingPrice,
      remainingQty: batch.remainingQty,
    });

    await batch.save(session ? { session } : {});
  }

  if (qtyToDeduct > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Insufficient stock to complete deduction for item: ${item?.itemName}`);
  }

  const totalQtyDeducted = quantity;

  await updateWarehouseInventory({
    itemId,
    companyId,
    warehouseId,
    stockDelta: -totalQtyDeducted,
    valueDelta: -totalInventoryValueDeducted,
    session,
  });

  return deductionSummary;
}

async function inventoryTransferDeduction({ stockData, session }) {
  const {
    itemId,
    companyId,
    branchId,
    warehouseId,
    quantity: sellingQty,
    deductedSourceType,
    deductedSourceId,
    itemUnitId: sellingUnitId,
  } = stockData;

  const { ItemBatch, Item, Warehouse } = getBooksCrmModels();

  const [item, warehouse, batches] = await Promise.all([
    Item.findById(itemId)
      .select('itemName itemUnitId unitConversions salesInformation.sellingPrice')
      .session(session || null)
      .lean(),
    Warehouse.findById(warehouseId).select('name').lean(),
    ItemBatch.find({ itemId, companyId, warehouseId, remainingQty: { $gt: 0 } }, null, session ? { session } : {}).sort({
      batchNo: 1,
    }),
  ]);

  if (!batches.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Insufficient stock in warehosue ${warehouse?.name} for item: ${item?.itemName}`);
  }

  // Batches hold the item's main unit; the transfer quantity arrives in the unit it was requested in.
  const conversionFactor = resolveUnitConversion(item, sellingUnitId);
  const quantity = roundQty(sellingQty * conversionFactor);

  let qtyToDeduct = quantity;
  const deductionSummary = [];
  let totalInventoryValueDeducted = 0;

  for (const batch of batches) {
    if (qtyToDeduct <= 0) break;

    const deductQty = roundQty(Math.min(batch.remainingQty, qtyToDeduct));
    // Transfers move stock at cost: the batch cost per selling unit, matching sellingQuantity below.
    const sellingPrice = roundPrice(batchBaseRate(batch) * conversionFactor);
    const sellingQuantity = roundQty(deductQty / conversionFactor);

    batch.deductions.push({
      deductedSourceType,
      deductedSourceId,
      quantityDeducted: deductQty,
      deductedAt: new Date(),
      sellingPrice,
      documentUnitRate: roundPrice(item?.salesInformation?.sellingPrice),
      sellingUnitId: sellingUnitId || item?.itemUnitId || null,
      sellingQuantity,
      conversionFactor,
    });

    batch.remainingQty = roundQty(batch.remainingQty - deductQty);
    qtyToDeduct = roundQty(qtyToDeduct - deductQty);
    totalInventoryValueDeducted += deductQty * batchBaseRate(batch);

    deductionSummary.push({
      batchNo: batch.batchNo,
      quantity: deductQty,
      purchasePrice: batchBaseRate(batch),
      warehouseId: batch?.warehouseId,
      itemBatchId: batch?._id,
      sellingPrice,
      sellingQuantity,
    });

    await batch.save(session ? { session } : {});
  }

  if (qtyToDeduct > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Insufficient stock to complete deduction for item: ${item?.itemName}`);
  }

  const totalQtyDeducted = quantity;

  await updateWarehouseInventory({
    itemId,
    companyId,
    warehouseId,
    stockDelta: -totalQtyDeducted,
    valueDelta: -totalInventoryValueDeducted,
    session,
  });

  return deductionSummary;
}

async function reverseDeduction({ stockData, session }) {
  const { deductedSourceType, deductedSourceId, itemId, companyId, branchId, warehouseId } = stockData;

  const { ItemBatch } = getBooksCrmModels();

  const reversalSummary = [];
  let reversedTotal = 0;
  let inventoryValueUpdate = 0;

  /**
   * 1️⃣ Find all batches where this deduction exists
   */
  const batches = await ItemBatch.find(
    {
      itemId,
      companyId,
      warehouseId,
      'deductions.deductedSourceType': deductedSourceType,
      'deductions.deductedSourceId': deductedSourceId,
    },
    null,
    session ? { session } : {},
  ).sort({ batchNo: 1 }); // FIFO

  /**
   * 2️⃣ Reverse deduction per batch
   */
  for (const batch of batches) {
    const relatedDeductions = batch.deductions.filter(
      d => d.deductedSourceType === deductedSourceType && d.deductedSourceId?.toString() === deductedSourceId.toString(),
    );

    if (!relatedDeductions.length) continue;

    const qtyToReturn = relatedDeductions.reduce((sum, d) => sum + d.quantityDeducted, 0);

    reversedTotal += qtyToReturn;
    inventoryValueUpdate += qtyToReturn * batchBaseRate(batch);

    reversalSummary.push({
      batchNo: batch.batchNo,
      quantityReversed: qtyToReturn,
      purchasePrice: batchBaseRate(batch),
      vendorBatchNo: batch.vendorBatchNo,
      vendorBatchExpiry: batch.vendorBatchExpiry,
    });

    /**
     * 3️⃣ Restore stock
     */
    batch.remainingQty = roundQty(batch.remainingQty + qtyToReturn);

    /**
     * 4️⃣ Remove reversed deductions
     */
    batch.deductions = batch.deductions.filter(
      d => !(d.deductedSourceType === deductedSourceType && d.deductedSourceId?.toString() === deductedSourceId.toString()),
    );

    await batch.save(session ? { session } : {});
  }

  await updateWarehouseInventory({
    itemId,
    companyId,
    warehouseId,
    stockDelta: reversedTotal,
    valueDelta: inventoryValueUpdate,
    session,
  });

  return {
    success: true,
    message: 'Deduction reversed successfully.',
    qtyReversed: reversedTotal,
    reversalSummary,
  };
}

async function deleteStockBySource({ stockData, session }) {
  const { deductedSourceType, deductedSourceId, itemId, warehouseId, companyId } = stockData;

  const { ItemBatch } = getBooksCrmModels();

  const usedBatch = await ItemBatch.findOne(
    {
      companyId,
      itemId,
      warehouseId,
      sourceType: deductedSourceType,
      sourceId: deductedSourceId,
      'deductions.0': { $exists: true },
    },
    null,
    session ? { session } : {},
  );

  if (usedBatch) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Cannot delete stock: some batches from this source have already been used in deductions',
    );
  }

  const batches = await ItemBatch.find(
    {
      companyId,
      itemId,
      warehouseId,
      sourceType: deductedSourceType,
      sourceId: deductedSourceId,
    },
    null,
    session ? { session } : {},
  );

  if (!batches.length) {
    return {
      success: true,
      message: 'No batches found for deletion',
      deletedCount: 0,
    };
  }

  const totalQtyToRemove = batches.reduce((sum, b) => sum + (b.remainingQty || 0), 0);
  const totalInventoryValueToDeduct = batches.reduce((sum, b) => sum + b.remainingQty * batchBaseRate(b), 0);

  const deleteResult = await ItemBatch.deleteMany(
    {
      companyId,
      itemId,
      warehouseId,
      sourceType: deductedSourceType,
      sourceId: deductedSourceId,
    },
    session ? { session } : {},
  );

  if (totalQtyToRemove > 0) {
    await updateWarehouseInventory({
      itemId,
      companyId,
      warehouseId,
      stockDelta: -totalQtyToRemove,
      valueDelta: -totalInventoryValueToDeduct,
      session,
    });
  }

  return {
    success: true,
    message: 'Item batches deleted successfully',
    deletedCount: deleteResult.deletedCount || 0,
    removedStock: totalQtyToRemove,
  };
}

async function reverseDeductionByBatch({ stockData, session }) {
  const { itemId, companyId, warehouseId, itemBatchId, quantity, deductedSourceType, deductedSourceId } = stockData;

  if (!itemBatchId || !quantity) {
    return { success: true, message: 'Nothing to reverse', qtyReversed: 0 };
  }

  const { ItemBatch } = getBooksCrmModels();

  const batch = await ItemBatch.findOne({ _id: itemBatchId, itemId, companyId, warehouseId }, null, session ? { session } : {});
  if (!batch) {
    return { success: true, message: 'Batch not found, nothing to reverse', qtyReversed: 0 };
  }

  batch.remainingQty = roundQty(batch.remainingQty + quantity);

  const dedIndex = (batch.deductions || []).findIndex(
    d =>
      d.deductedSourceType === deductedSourceType &&
      d.deductedSourceId?.toString() === deductedSourceId?.toString() &&
      d.quantityDeducted === quantity,
  );
  if (dedIndex !== -1) batch.deductions.splice(dedIndex, 1);

  await batch.save(session ? { session } : {});

  await updateWarehouseInventory({
    itemId,
    companyId,
    warehouseId,
    stockDelta: quantity,
    valueDelta: quantity * batchBaseRate(batch),
    session,
  });

  return { success: true, message: 'Deduction reversed for batch', qtyReversed: quantity, remainingQty: batch.remainingQty };
}

async function deleteStockByBatchId({ stockData, session }) {
  const { itemId, companyId, warehouseId, itemBatchId } = stockData;

  if (!itemBatchId) {
    return { success: true, message: 'Nothing to delete', deletedCount: 0, removedStock: 0 };
  }

  const { ItemBatch } = getBooksCrmModels();

  const batch = await ItemBatch.findOne({ _id: itemBatchId, itemId, companyId, warehouseId }, null, session ? { session } : {});
  if (!batch) {
    return { success: true, message: 'Batch not found, nothing to delete', deletedCount: 0, removedStock: 0 };
  }

  if ((batch.deductions || []).length > 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot reverse: ${roundQty(batch.quantity - batch.remainingQty)} unit(s) from batch #${batch.batchNo} have already been issued out elsewhere.`,
    );
  }

  const removedStock = batch.remainingQty;
  const removedValue = removedStock * batchBaseRate(batch);

  await ItemBatch.deleteOne({ _id: batch._id }, session ? { session } : {});

  if (removedStock > 0) {
    await updateWarehouseInventory({
      itemId,
      companyId,
      warehouseId,
      stockDelta: -removedStock,
      valueDelta: -removedValue,
      session,
    });
  }

  return { success: true, message: 'Batch deleted', deletedCount: 1, removedStock };
}

// Moves one batch's quantity toward a new target instead of deleting/recreating it - same rule
// as editStockBySource (GRPO): cannot shrink below what's already been issued out of the batch
// elsewhere, can grow freely. Reprices the batch only when nothing has been issued out of it yet
// (once some units are gone at the old price, repricing would desync already-posted cost/ledger
// entries for those units). newQuantity <= 0 delegates to deleteStockByBatchId (same "floor"
// guard, since shrinking to zero is just the extreme case of shrinking).
async function adjustStockByBatchId({ stockData, session }) {
  const {
    itemId,
    companyId,
    warehouseId,
    itemBatchId,
    newQuantity: docQuantity,
    newPurchasePrice: docPurchasePrice,
    vendorBatchNo,
    vendorBatchExpiry,
    itemUnitId: docUnitId,
    rateIsBase,
  } = stockData;

  if (!itemBatchId) {
    return { success: true, message: 'Nothing to adjust', itemBatchId: null };
  }

  if (!docQuantity || docQuantity <= 0) {
    return deleteStockByBatchId({ stockData: { itemId, companyId, warehouseId, itemBatchId }, session });
  }

  const { ItemBatch, Item } = getBooksCrmModels();

  // Document quantity/rate are in docUnitId; the batch is kept in the item main unit.
  const item = await Item.findById(itemId)
    .select('itemName itemUnitId unitConversions purchaseInformation.costPrice')
    .session(session || null)
    .lean();
  const conversionFactor = resolveUnitConversion(item, docUnitId);
  const newQuantity = roundQty(docQuantity * conversionFactor);
  const newPurchasePrice =
    rateIsBase && typeof docPurchasePrice === 'number' ? docPurchasePrice * conversionFactor : docPurchasePrice;

  const batch = await ItemBatch.findOne({ _id: itemBatchId, itemId, companyId, warehouseId }, null, session ? { session } : {});
  if (!batch) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Batch not found');
  }

  const deductedQty = roundQty(batch.quantity - batch.remainingQty);

  if (newQuantity < deductedQty) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot reduce quantity below ${deductedQty} unit(s) already issued out from batch #${batch.batchNo}.`,
    );
  }

  const oldPurchasePrice = batch.purchasePrice || 0;
  const newPrice = roundPrice(deductedQty === 0 && typeof newPurchasePrice === 'number' ? newPurchasePrice : oldPurchasePrice);

  const oldValue = batch.quantity * batchBaseRate(batch);
  const newValue = roundQty(newQuantity) * toBaseRate(newPrice, conversionFactor);
  const qtyDelta = roundQty(newQuantity - batch.quantity);

  batch.quantity = roundQty(newQuantity);
  batch.remainingQty = roundQty(batch.remainingQty + qtyDelta);
  batch.purchasePrice = newPrice;
  batch.documentUnitRate = roundPrice(item?.purchaseInformation?.costPrice);
  batch.purchaseUnitId = docUnitId || item?.itemUnitId || null;
  batch.purchaseQuantity = roundQty(docQuantity);
  batch.conversionFactor = conversionFactor;
  if (vendorBatchNo !== undefined) {
    batch.vendorBatchNo = vendorBatchNo || null;
  }
  if (vendorBatchExpiry !== undefined) {
    batch.vendorBatchExpiry = vendorBatchExpiry || null;
  }
  await batch.save(session ? { session } : {});

  if (qtyDelta !== 0 || newValue !== oldValue) {
    await updateWarehouseInventory({
      itemId,
      companyId,
      warehouseId,
      stockDelta: qtyDelta,
      valueDelta: newValue - oldValue,
      session,
    });
  }

  return {
    success: true,
    batchNo: batch.batchNo,
    quantity: batch.quantity,
    remainingQty: batch.remainingQty,
    purchasePrice: batchBaseRate(batch),
    itemBatchId: batch._id,
  };
}

async function editStockBySource({ record, stockData, session }) {
  const { sourceType, sourceId, newQuantity } = stockData;

  const allBatches = [...record.availableBatches, ...record.completedBatches];

  const batch = allBatches.find(b => b.sourceType === sourceType && b.sourceId?.toString() === sourceId.toString());

  if (!batch) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'GRPO batch not found');
  }

  const deductedQty = batch.quantity - batch.remainingQty;

  // ❌ Cannot reduce below deducted qty
  if (newQuantity < deductedQty) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Cannot reduce GRPO qty below already deducted quantity (${deductedQty})`);
  }

  const diff = newQuantity - batch.quantity;

  batch.quantity = newQuantity;
  batch.remainingQty = roundQty(batch.remainingQty + diff);

  // 🔁 If completed but now has remaining qty → move back
  if (batch.remainingQty > 0) {
    record.completedBatches = record.completedBatches.filter(b => b.batchNo !== batch.batchNo);

    if (!record.availableBatches.find(b => b.batchNo === batch.batchNo)) {
      record.availableBatches.push(batch);
      record.availableBatches.sort((a, b) => a.batchNo - b.batchNo);
    }
  }

  // 🔁 If now zero → move to completed
  if (batch.remainingQty === 0) {
    record.availableBatches = record.availableBatches.filter(b => b.batchNo !== batch.batchNo);

    if (!record.completedBatches.find(b => b.batchNo === batch.batchNo)) {
      record.completedBatches.push(batch);
    }
  }

  record.markModified('availableBatches');
  record.markModified('completedBatches');

  record.totalRemainingQty = record.availableBatches.reduce((sum, b) => sum + b.remainingQty, 0);

  await record.save(session ? { session } : {});
}

async function deductStockQuantityWithoutSourceID({ stockData, session }) {
  const { quantity, companyId, deductedSourceType, deductedSourceId, itemId, warehouseId } = stockData;

  const { ItemBatch } = getBooksCrmModels();

  if (!quantity || quantity <= 0) {
    return { success: true, deductedQty: 0 };
  }

  const { sellingPrice: masterSellingPrice } = await getItemMasterRates(itemId, session);
  let qtyToDeduct = quantity;
  let deductedQty = 0;
  let deductedValue = 0;

  /**
   * 1️⃣ Get available batches in FIFO order
   */
  const batches = await ItemBatch.find(
    {
      itemId,
      warehouseId,
      companyId,
      remainingQty: { $gt: 0 },
    },
    null,
    session ? { session } : {},
  ).sort({ createdAt: 1 }); // FIFO

  if (!batches.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Insufficient stock to deduct requested quantity');
  }

  /**
   * 2️⃣ Deduct quantity batch-by-batch
   */
  for (const batch of batches) {
    if (qtyToDeduct <= 0) break;

    const deductFromBatch = Math.min(batch.remainingQty, qtyToDeduct);

    batch.remainingQty = roundQty(batch.remainingQty - deductFromBatch);
    qtyToDeduct = roundQty(qtyToDeduct - deductFromBatch);
    deductedQty += deductFromBatch;
    deductedValue += deductFromBatch * batchBaseRate(batch);

    batch.deductions.push({
      quantityDeducted: deductFromBatch,
      deductedSourceType,
      deductedSourceId,
      deductedAt: new Date(),
      // Quantity here is in the main unit (factor 1), so the price is the batch cost per main unit.
      sellingPrice: roundPrice(batchBaseRate(batch)),
      documentUnitRate: masterSellingPrice,
      sellingQuantity: deductFromBatch,
      conversionFactor: 1,
    });

    await batch.save(session ? { session } : {});
  }

  if (deductedQty === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Insufficient stock to deduct requested quantity');
  }

  // Get remaining stock for response
  const remainingAgg = await ItemBatch.aggregate(
    [
      {
        $match: {
          itemId: new mongoose.Types.ObjectId(itemId),
          warehouseId: new mongoose.Types.ObjectId(warehouseId),
        },
      },
      {
        $group: {
          _id: null,
          totalRemainingQty: { $sum: '$remainingQty' },
        },
      },
    ],
    session ? { session } : {},
  );

  // Single combined update for stock and inventory value
  await updateWarehouseInventory({
    itemId,
    companyId,
    warehouseId,
    stockDelta: -deductedQty,
    valueDelta: -deductedValue,
    session,
  });

  return {
    success: true,
    requestedQty: quantity,
    deductedQty,
    deductedValue,
    remainingQty: remainingAgg[0]?.totalRemainingQty || 0,
  };
}

async function updateGrpoAndBillBatchQty({ stockData, session }) {
  const {
    sourceId,
    updatedQty: docQty,
    purchasePrice: docPrice,
    itemId,
    warehouseId,
    companyId,
    itemUnitId: docUnitId,
  } = stockData;

  const { ItemBatch, Item } = getBooksCrmModels();

  const item = await Item.findById(itemId)
    .select('itemName itemUnitId unitConversions purchaseInformation.costPrice')
    .session(session || null)
    .lean();
  const conversionFactor = resolveUnitConversion(item, docUnitId);
  const updatedQty = roundQty(docQty * conversionFactor);
  const purchasePrice = docPrice;

  if (updatedQty < 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid update quantity');
  }

  const batch = await ItemBatch.findOne({ sourceId, itemId, warehouseId, companyId }, null, session ? { session } : {});

  if (!batch) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Batch not found for given source');
  }

  const oldQty = batch.quantity;
  const oldRemainingQty = batch.remainingQty;
  const oldPrice = batch.purchasePrice || 0;
  const oldBaseRate = batchBaseRate(batch);

  const totalDeductedQty = batch.deductions.reduce((sum, d) => sum + (d.quantityDeducted || 0), 0);

  if (updatedQty < totalDeductedQty) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot reduce quantity below already deducted quantity');
  }

  const qtyDiff = updatedQty - oldQty;

  batch.quantity = updatedQty;
  batch.remainingQty = roundQty(updatedQty - totalDeductedQty);
  batch.purchaseUnitId = docUnitId || item?.itemUnitId || null;
  batch.purchaseQuantity = roundQty(docQty);
  batch.conversionFactor = conversionFactor;

  const effectivePrice = purchasePrice !== undefined ? roundPrice(purchasePrice) : oldPrice;
  if (purchasePrice !== undefined) batch.purchasePrice = effectivePrice;
  batch.documentUnitRate = roundPrice(item?.purchaseInformation?.costPrice);

  await batch.save({ session });

  // New batch value = newRemainingQty * newPrice, where newRemainingQty = oldRemainingQty + qtyDiff
  // (totalDeductedQty is unchanged by this update). This reduces to the qty-only and
  // price-only cases when only one of them changes, but also stays correct when both change.
  // Valued per base unit: price / conversionFactor on both sides.
  const effectiveBaseRate = toBaseRate(effectivePrice, conversionFactor);
  const valueDelta = qtyDiff * effectiveBaseRate + oldRemainingQty * (effectiveBaseRate - oldBaseRate);

  // Single combined update for stock and inventory value
  if (qtyDiff !== 0 || valueDelta !== 0) {
    await updateWarehouseInventory({
      itemId,
      companyId,
      warehouseId,
      stockDelta: qtyDiff,
      valueDelta,
      session,
    });
  }

  return batch;
}

// Replaces updateWarehouseStock + updateWarehouseInventoryValue with a single atomic $inc.
// stockDelta: positive = add stock, negative = deduct stock
// valueDelta: positive = add value, negative = deduct value
async function updateWarehouseInventory({
  itemId,
  companyId,
  warehouseId,
  branchId,
  divisionId,
  stockDelta = 0,
  valueDelta = 0,
  session,
}) {
  stockDelta = roundQty(stockDelta);
  valueDelta = Math.round(valueDelta * 100) / 100;

  if (stockDelta === 0 && valueDelta === 0) return;

  const { ItemInventory, Item } = getBooksCrmModels();

  // Round the target warehouse's availableStock and the document-level totalAvailableStock
  // to 3dp within the same pipeline update — plain `$inc` accumulates floating point drift
  // (e.g. 1.2000000000000002) across many transactions, same pattern as incBankBalance in
  // bankBalance.service.js.
  const warehouseIdStr = String(warehouseId);
  const setStage = {};
  if (stockDelta !== 0 || valueDelta !== 0) {
    setStage.warehouses = {
      $map: {
        input: '$warehouses',
        as: 'wh',
        in: {
          $cond: [
            { $eq: [{ $toString: '$$wh.warehouseId' }, warehouseIdStr] },
            {
              $mergeObjects: [
                '$$wh',
                {
                  ...(stockDelta !== 0 && {
                    availableStock: { $round: [{ $add: [{ $ifNull: ['$$wh.availableStock', 0] }, stockDelta] }, 3] },
                  }),
                  ...(valueDelta !== 0 && {
                    inventoryValue: { $add: [{ $ifNull: ['$$wh.inventoryValue', 0] }, valueDelta] },
                  }),
                },
              ],
            },
            '$$wh',
          ],
        },
      },
    };
  }
  if (stockDelta !== 0) {
    setStage.totalAvailableStock = { $round: [{ $add: [{ $ifNull: ['$totalAvailableStock', 0] }, stockDelta] }, 3] };
  }
  if (valueDelta !== 0) {
    setStage.totalInventoryValue = { $add: [{ $ifNull: ['$totalInventoryValue', 0] }, valueDelta] };
  }

  // Include the sufficient-stock / sufficient-value checks atomically in the filter via $elemMatch.
  // This prevents going negative without a separate read — the update simply won't match if
  // stock or the per-warehouse inventory value is insufficient.
  // Stock never moves on an inactive warehouse row (legacy rows without isActive count as active).
  const warehouseMatch = { warehouseId, isActive: { $ne: false } };
  if (stockDelta < 0) {
    warehouseMatch.availableStock = { $gte: -stockDelta };
  }
  if (valueDelta < 0) {
    warehouseMatch.inventoryValue = { $gte: -valueDelta - VALUE_GUARD_EPSILON };
  }

  const filter = { itemId, companyId, warehouses: { $elemMatch: warehouseMatch } };

  // Same atomic-guard approach for the document-level total: never let totalInventoryValue go negative.
  if (valueDelta < 0) {
    filter.totalInventoryValue = { $gte: -valueDelta - VALUE_GUARD_EPSILON };
  }

  const result = await ItemInventory.updateOne(filter, [{ $set: setStage }], session ? { session } : {});

  if (result.matchedCount === 0) {
    // matchedCount === 0 can mean: inventory missing, warehouse entry missing, insufficient stock,
    // insufficient per-warehouse value, or insufficient total value. Run lightweight exists checks
    // to figure out which error to throw.
    const item = await Item.findById(itemId).select('itemName itemNo').session(session);
    const itemLabel = item?.itemName ? (item.itemNo ? `${item.itemName} (${item.itemNo})` : item.itemName) : `item ${itemId}`;

    const inactiveRowExists = await ItemInventory.exists(
      { itemId, companyId, warehouses: { $elemMatch: { warehouseId, isActive: false } } },
      session ? { session } : {},
    );
    if (inactiveRowExists) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${itemLabel} is not active in the selected warehouse. Activate it in the Item Master before moving stock.`,
      );
    }

    const inventoryExists = await ItemInventory.exists({ itemId, companyId }, session ? { session } : {});

    if (!inventoryExists) {
      if (stockDelta > 0) {
        // First-ever stock for an inventory-tracked item whose ItemInventory document was never
        // created (e.g. a finished good receiving its first stock from a production submission).
        // Create the document with this warehouse entry so the batch that was just added is
        // reflected in inventory, instead of failing and leaving a batch with no inventory.
        // Deductions still fall through to the "not found" error below — you cannot deduct from
        // an item that has no inventory.
        await ItemInventory.create(
          [
            {
              itemId,
              companyId,
              totalAvailableStock: Math.max(0, stockDelta),
              totalInventoryValue: Math.max(0, valueDelta),
              warehouses: [
                {
                  warehouseId,
                  branchId,
                  divisionId,
                  availableStock: Math.max(0, stockDelta),
                  openingStock: 0,
                  inventoryValue: Math.max(0, valueDelta),
                  isActive: true,
                },
              ],
            },
          ],
          session ? { session } : {},
        );
        return;
      }
      throw new ApiError(httpStatus.NOT_FOUND, `Item inventory not found for ${itemLabel}`);
    }

    if (valueDelta < 0) {
      const hasSufficientTotalValue = await ItemInventory.exists(
        { itemId, companyId, totalInventoryValue: { $gte: -valueDelta - VALUE_GUARD_EPSILON } },
        session ? { session } : {},
      );

      if (!hasSufficientTotalValue) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot deduct value for ${itemLabel}. Total inventory value would go negative.`,
        );
      }
    }

    if (stockDelta < 0 || valueDelta < 0) {
      const warehouseExists = await ItemInventory.exists(
        { itemId, companyId, 'warehouses.warehouseId': warehouseId },
        session ? { session } : {},
      );

      if (!warehouseExists) {
        const action = stockDelta < 0 ? 'stock' : 'value';
        throw new ApiError(httpStatus.BAD_REQUEST, `Cannot deduct ${action} for ${itemLabel}. Warehouse does not exist.`);
      }
    }

    if (stockDelta < 0) {
      const hasSufficientStock = await ItemInventory.exists(
        { itemId, companyId, warehouses: { $elemMatch: { warehouseId, availableStock: { $gte: -stockDelta } } } },
        session ? { session } : {},
      );

      if (!hasSufficientStock) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Insufficient stock in warehouse for ${itemLabel}`);
      }
    }

    if (valueDelta < 0) {
      const hasSufficientWarehouseValue = await ItemInventory.exists(
        {
          itemId,
          companyId,
          warehouses: { $elemMatch: { warehouseId, inventoryValue: { $gte: -valueDelta - VALUE_GUARD_EPSILON } } },
        },
        session ? { session } : {},
      );

      if (!hasSufficientWarehouseValue) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot deduct value for ${itemLabel}. Warehouse inventory value would go negative.`,
        );
      }
    }

    if (stockDelta > 0) {
      // Warehouse entry doesn't exist yet — create it and update totals in one operation.
      // Pipeline update so totalAvailableStock stays rounded the same way as the main update above.
      const newEntrySet = {
        warehouses: {
          $concatArrays: [
            '$warehouses',
            [
              {
                warehouseId,
                branchId,
                divisionId,
                availableStock: Math.max(0, stockDelta),
                openingStock: 0,
                inventoryValue: Math.max(0, valueDelta),
                isActive: true,
              },
            ],
          ],
        },
        totalAvailableStock: { $round: [{ $add: [{ $ifNull: ['$totalAvailableStock', 0] }, stockDelta] }, 3] },
      };
      if (valueDelta !== 0) {
        newEntrySet.totalInventoryValue = { $add: [{ $ifNull: ['$totalInventoryValue', 0] }, valueDelta] };
      }

      await ItemInventory.updateOne({ itemId, companyId }, [{ $set: newEntrySet }], session ? { session } : {});
    }
    // stockDelta === 0 and warehouse not found — nothing to do
  }
}

async function notifyCompanyUsersOfStockAlerts({ companyId, docType, docId, docNo, alerts, triggeredByUserId, session }) {
  if (!alerts.length) return;

  try {
    const { UserRole, Notification } = getBooksModels();

    const userRoles = await UserRole.find({
      companyId,
      status: 'active',
      $or: [{ isActive: true }, { isActive: { $exists: false } }],
    })
      .select('userId')
      .session(session || null)
      .lean();

    const userIds = [...new Set(userRoles.map(ur => ur.userId?.toString()).filter(Boolean))];
    if (!userIds.length) return;

    const belowMinimumCount = alerts.filter(alert => alert.stockStatus === STOCK_STATUS.BELOW_MINIMUM).length;
    const aboveMaximumCount = alerts.filter(alert => alert.stockStatus === STOCK_STATUS.ABOVE_MAXIMUM).length;

    const title = 'Stock Alert';
    const body = `${alerts.length} item(s)${docNo ? ` for ${docNo}` : ''} are outside their stock levels (${belowMinimumCount} below minimum, ${aboveMaximumCount} above maximum).`;

    const items = alerts.map(alert => ({
      itemId: alert.itemId?.toString(),
      itemName: alert.itemName,
      itemNo: alert.itemNo,
      totalAvailableStock: alert.totalAvailableStock,
      minimumStockLevel: alert.minimumStockLevel,
      maximumStockLevel: alert.maximumStockLevel,
      stockStatus: alert.stockStatus,
    }));

    const notificationDocs = userIds.map(uid => ({
      userId: uid,
      userType: DEVICE_USER_TYPE.USER,
      companyId,
      type: NOTIFICATION_TYPE.STOCK_MIN_MAX_LEVEL,
      title,
      body,
      module: docType || null,
      actionId: docId || null,
      data: {
        docType: docType || null,
        docId: docId || null,
        docNo: docNo || null,
        items,
      },
      ...(triggeredByUserId && {
        triggeredBy: triggeredByUserId,
        triggeredByType: NOTIFICATION_ACTOR_TYPE.USER,
      }),
    }));

    if (!notificationDocs.length) return;

    const inserted = await Notification.insertMany(notificationDocs, {
      ordered: false,
      ...(session && { session }),
    });

    inserted.forEach(doc => emitNotificationToUser(doc.userId, doc));

    alerts.forEach(alert => {
      const type = alert.stockStatus === STOCK_STATUS.BELOW_MINIMUM ? 'STOCK_MIN_LIMIT_REACHED' : 'STOCK_MAX_LIMIT_REACHED';
      const limitValue = alert.stockStatus === STOCK_STATUS.BELOW_MINIMUM ? alert.minimumStockLevel : alert.maximumStockLevel;

      publishRealtimeEvent(
        buildEnvelope({
          type,
          version: 1,
          source: 'abss-books-backend',
          data: {
            companyId,
            itemId: alert.itemId?.toString(),
            itemName: alert.itemName,
            itemNo: alert.itemNo,
            currentStock: alert.totalAvailableStock,
            limitValue,
            limitType: alert.stockStatus === STOCK_STATUS.BELOW_MINIMUM ? 'MIN' : 'MAX',
          },
        }),
      ).catch(err => logger.error(`Failed to publish ${type} for item ${alert.itemId}:`, err.message));
    });
  } catch (err) {
    logger.error('Failed to send stock min/max notifications:', err.message);
  }
}

const pendingStockAlerts = new WeakMap();

async function checkCompanyStockLevels({ itemIds, companyId, docType, docId, docNo, userId, session }) {
  if (!companyId || !Array.isArray(itemIds) || !itemIds.length) return [];

  if (!session) {
    return runStockLevelAlerts({ itemIds, companyId, docType, docId, docNo, userId, session: null });
  }

  let entry = pendingStockAlerts.get(session);
  if (!entry) {
    entry = { companyId, docType, docId, docNo, userId, itemIds: new Set() };
    pendingStockAlerts.set(session, entry);
  }
  itemIds.forEach(id => id && entry.itemIds.add(id.toString()));
  return [];
}

async function flushCompanyStockLevels(session) {
  if (!session) return [];
  const entry = pendingStockAlerts.get(session);
  if (!entry) return [];
  pendingStockAlerts.delete(session);
  if (!entry.itemIds.size) return [];
  try {
    return await runStockLevelAlerts({ ...entry, itemIds: [...entry.itemIds], session });
  } catch (err) {
    logger.error('Stock level flush failed:', err.message);
    return [];
  }
}

async function runStockLevelAlerts({ itemIds, companyId, docType, docId, docNo, userId, session }) {
  const { ItemInventory } = getBooksCrmModels();

  const objectItemIds = itemIds.map(id => new mongoose.Types.ObjectId(id.toString()));

  const inventories = await ItemInventory.aggregate(
    [
      { $match: { companyId: new mongoose.Types.ObjectId(companyId), itemId: { $in: objectItemIds } } },
      {
        $lookup: {
          from: 'items',
          localField: 'itemId',
          foreignField: '_id',
          as: 'item',
          pipeline: [{ $project: { itemName: 1, itemNo: 1, itemStatus: 1 } }],
        },
      },
      { $unwind: '$item' },
      { $match: { 'item.itemStatus': true } },
      {
        $project: {
          itemId: 1,
          itemName: '$item.itemName',
          itemNo: '$item.itemNo',
          totalAvailableStock: 1,
          minimumStockLevel: 1,
          maximumStockLevel: 1,
        },
      },
    ],
    session ? { session } : {},
  );

  const results = inventories
    .map(inv => {
      const minimumStockLevel = inv.minimumStockLevel || 0;
      const maximumStockLevel = inv.maximumStockLevel || 0;

      let stockStatus = STOCK_STATUS.NORMAL;
      if (minimumStockLevel > 0 && inv.totalAvailableStock < minimumStockLevel) {
        stockStatus = STOCK_STATUS.BELOW_MINIMUM;
      } else if (maximumStockLevel > 0 && inv.totalAvailableStock > maximumStockLevel) {
        stockStatus = STOCK_STATUS.ABOVE_MAXIMUM;
      }

      return {
        itemId: inv.itemId,
        itemName: inv.itemName,
        itemNo: inv.itemNo,
        totalAvailableStock: inv.totalAvailableStock,
        minimumStockLevel,
        maximumStockLevel,
        stockStatus,
      };
    })
    .filter(inv => inv.stockStatus === STOCK_STATUS.BELOW_MINIMUM || inv.stockStatus === STOCK_STATUS.ABOVE_MAXIMUM);

  await notifyCompanyUsersOfStockAlerts({
    companyId,
    docType,
    docId,
    docNo,
    alerts: results,
    triggeredByUserId: userId,
    session,
  });

  return results;
}
module.exports = {
  roundQty,
  resolveUnitConversion,
  isStockTrackedItem,
  getUntrackedProductionItems,
  handleWarehouseStock,
  addStock,
  addOpeningStockBatch,
  deductStock,
  inventoryTransferDeduction,
  reverseDeduction,
  deleteStockBySource,
  reverseDeductionByBatch,
  deleteStockByBatchId,
  adjustStockByBatchId,
  deductStockQuantityWithoutSourceID,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
};
