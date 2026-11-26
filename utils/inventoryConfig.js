const ApiError = require('./ApiError');
const httpStatus = require('http-status');
const {
  MODULE_NAMES,
  QUOTE_STATUS,
  PO_STATUSES,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  SALES_ORDER_INVOICE_STATUS,
  GRPO_STATUSES,
  BILL_STATUSES,
  DEBIT_NOTE_STATUS,
} = require('./enum');
const { getCommonModels, getBooksCrmModels } = require('../services/model.service');
const { resolveUnitConversion, roundQty } = require('../services/warehouseBatch.service');

const SALES_MODULES = [MODULE_NAMES.QUOTATION, MODULE_NAMES.SALES_ORDER, MODULE_NAMES.DELIVERY_CHALLAN, MODULE_NAMES.INVOICE];
const PURCHASE_MODULES = [MODULE_NAMES.PURCHASE_ORDER, MODULE_NAMES.GRPO, MODULE_NAMES.BILL];

const QUOTE_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    DRAFT: [QUOTE_STATUS.SENT, QUOTE_STATUS.EXPIRED, QUOTE_STATUS.CANCELLED],
    SENT: [QUOTE_STATUS.ACCEPTED, QUOTE_STATUS.REJECTED, QUOTE_STATUS.EXPIRED, QUOTE_STATUS.DRAFT, QUOTE_STATUS.CANCELLED],
    ACCEPTED: [QUOTE_STATUS.COMPLETED, QUOTE_STATUS.CANCELLED, QUOTE_STATUS.SENT, QUOTE_STATUS.DRAFT],
    REJECTED: [QUOTE_STATUS.DRAFT, QUOTE_STATUS.CANCELLED],
    EXPIRED: [QUOTE_STATUS.CANCELLED],
    COMPLETED: [QUOTE_STATUS.CANCELLED],
    CANCELLED: [QUOTE_STATUS.DRAFT, QUOTE_STATUS.SENT],
  },
  EDIT_RESTRICTED_STATUSES: [
    QUOTE_STATUS.SENT,
    QUOTE_STATUS.ACCEPTED,
    QUOTE_STATUS.REJECTED,
    QUOTE_STATUS.COMPLETED,
    QUOTE_STATUS.EXPIRED,
    QUOTE_STATUS.CANCELLED,
  ],
  CONVERSION_ALLOWED_STATUSES: [QUOTE_STATUS.ACCEPTED],
  STOCK_RELEASE_STATUSES: [QUOTE_STATUS.REJECTED, QUOTE_STATUS.EXPIRED, QUOTE_STATUS.CANCELLED],
};

const SALES_ORDER_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [SALES_ORDER_STATUS.DRAFT]: [SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.CANCELLED],
    [SALES_ORDER_STATUS.OPEN]: [SALES_ORDER_STATUS.CLOSED, SALES_ORDER_STATUS.CANCELLED, SALES_ORDER_STATUS.DRAFT],
    [SALES_ORDER_STATUS.CANCELLED]: [SALES_ORDER_STATUS.DRAFT, SALES_ORDER_STATUS.OPEN],
    [SALES_ORDER_STATUS.PARTIALLY_RECORDED]: [SALES_ORDER_STATUS.CLOSED],
    [SALES_ORDER_STATUS.CLOSED]: [SALES_ORDER_STATUS.CANCELLED],
  },
  EDIT_RESTRICTED_STATUSES: [
    SALES_ORDER_STATUS.OPEN,
    SALES_ORDER_STATUS.CLOSED,
    SALES_ORDER_STATUS.CANCELLED,
    SALES_ORDER_STATUS.PARTIALLY_RECORDED,
    SALES_ORDER_STATUS.COMPLETED,
  ],
  CONVERSION_ALLOWED_STATUSES: [SALES_ORDER_STATUS.OPEN],
  STOCK_RELEASE_STATUSES: [SALES_ORDER_STATUS.CANCELLED],
};

const DELIVERY_CHALLAN_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [DELIVERY_CHALLAN_STATUS.DRAFT]: [DELIVERY_CHALLAN_STATUS.SENT, DELIVERY_CHALLAN_STATUS.CANCELLED],
    [DELIVERY_CHALLAN_STATUS.SENT]: [DELIVERY_CHALLAN_STATUS.CANCELLED, DELIVERY_CHALLAN_STATUS.DRAFT],
    [DELIVERY_CHALLAN_STATUS.CANCELLED]: [DELIVERY_CHALLAN_STATUS.DRAFT, DELIVERY_CHALLAN_STATUS.SENT],
  },
  EDIT_RESTRICTED_STATUSES: [DELIVERY_CHALLAN_STATUS.SENT, DELIVERY_CHALLAN_STATUS.DELIVERED, DELIVERY_CHALLAN_STATUS.CANCELLED],
  CONVERSION_ALLOWED_STATUSES: [DELIVERY_CHALLAN_STATUS.SENT],
};

const INVOICE_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [SALES_ORDER_INVOICE_STATUS.DRAFT]: [SALES_ORDER_INVOICE_STATUS.SENT, SALES_ORDER_INVOICE_STATUS.CANCELLED],
    [SALES_ORDER_INVOICE_STATUS.SENT]: [
      SALES_ORDER_INVOICE_STATUS.PAID,
      SALES_ORDER_INVOICE_STATUS.PARTIALLY_PAID,
      SALES_ORDER_INVOICE_STATUS.OVERDUE,
      SALES_ORDER_INVOICE_STATUS.CANCELLED,
    ],
    [SALES_ORDER_INVOICE_STATUS.PAID]: [SALES_ORDER_INVOICE_STATUS.CANCELLED],
    [SALES_ORDER_INVOICE_STATUS.PARTIALLY_PAID]: [SALES_ORDER_INVOICE_STATUS.PAID, SALES_ORDER_INVOICE_STATUS.CANCELLED],
    [SALES_ORDER_INVOICE_STATUS.OVERDUE]: [
      SALES_ORDER_INVOICE_STATUS.PAID,
      SALES_ORDER_INVOICE_STATUS.PARTIALLY_PAID,
      SALES_ORDER_INVOICE_STATUS.CANCELLED,
    ],
    [SALES_ORDER_INVOICE_STATUS.CANCELLED]: [],
  },
  EDIT_RESTRICTED_STATUSES: [
    SALES_ORDER_INVOICE_STATUS.SENT,
    SALES_ORDER_INVOICE_STATUS.PAID,
    SALES_ORDER_INVOICE_STATUS.PARTIALLY_PAID,
    SALES_ORDER_INVOICE_STATUS.OVERDUE,
    SALES_ORDER_INVOICE_STATUS.CANCELLED,
  ],
};

const PURCHASE_ORDER_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [PO_STATUSES.DRAFT]: [PO_STATUSES.SENT, PO_STATUSES.CANCELLED],
    [PO_STATUSES.SENT]: [PO_STATUSES.ACCEPTED, PO_STATUSES.REJECTED, PO_STATUSES.CANCELLED, PO_STATUSES.DRAFT],
    [PO_STATUSES.ACCEPTED]: [PO_STATUSES.CONVERTED, PO_STATUSES.CANCELLED, PO_STATUSES.SENT, PO_STATUSES.DRAFT],
    [PO_STATUSES.REJECTED]: [PO_STATUSES.DRAFT, PO_STATUSES.CANCELLED],
    [PO_STATUSES.CONVERTED]: [],
    [PO_STATUSES.CANCELLED]: [PO_STATUSES.DRAFT, PO_STATUSES.SENT],
    [PO_STATUSES.PARTIALLY_RECORDED]: [PO_STATUSES.CLOSED],
    [PO_STATUSES.CLOSED]: [PO_STATUSES.PARTIALLY_RECORDED],
  },
  EDIT_RESTRICTED_STATUSES: [
    PO_STATUSES.SENT,
    PO_STATUSES.ACCEPTED,
    PO_STATUSES.REJECTED,
    PO_STATUSES.CONVERTED,
    PO_STATUSES.CANCELLED,
  ],
  CONVERSION_ALLOWED_STATUSES: [PO_STATUSES.ACCEPTED],
  STOCK_RELEASE_STATUSES: [PO_STATUSES.REJECTED, PO_STATUSES.CONVERTED, PO_STATUSES.CANCELLED],
};

const GRPO_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [GRPO_STATUSES.DRAFT]: [GRPO_STATUSES.RECORDED, GRPO_STATUSES.CANCELLED],
    [GRPO_STATUSES.RECORDED]: [GRPO_STATUSES.CANCELLED, GRPO_STATUSES.DRAFT],
    [GRPO_STATUSES.CONVERTED]: [GRPO_STATUSES.CANCELLED],
    [GRPO_STATUSES.CANCELLED]: [GRPO_STATUSES.DRAFT, GRPO_STATUSES.RECORDED],
  },
  EDIT_RESTRICTED_STATUSES: [GRPO_STATUSES.RECORDED, GRPO_STATUSES.CONVERTED, GRPO_STATUSES.CANCELLED],
  CONVERSION_ALLOWED_STATUSES: [GRPO_STATUSES.RECORDED],
};

const BILL_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [BILL_STATUSES.DRAFT]: [BILL_STATUSES.OPEN, BILL_STATUSES.CANCELLED],
    [BILL_STATUSES.OPEN]: [BILL_STATUSES.PAID, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.OVERDUE, BILL_STATUSES.CANCELLED],
    [BILL_STATUSES.PAID]: [],
    [BILL_STATUSES.PARTIALLY_PAID]: [BILL_STATUSES.PAID, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.CANCELLED],
    [BILL_STATUSES.OVERDUE]: [BILL_STATUSES.PAID, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.CANCELLED],
    [BILL_STATUSES.CANCELLED]: [],
  },
  EDIT_RESTRICTED_STATUSES: [BILL_STATUSES.PAID, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.OVERDUE, BILL_STATUSES.CANCELLED],
};

const CREDIT_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [DEBIT_NOTE_STATUS.DRAFT]: [DEBIT_NOTE_STATUS.OPEN, DEBIT_NOTE_STATUS.CANCELLED],
    [DEBIT_NOTE_STATUS.OPEN]: [DEBIT_NOTE_STATUS.CLOSED, DEBIT_NOTE_STATUS.CANCELLED, DEBIT_NOTE_STATUS.DRAFT],
    [DEBIT_NOTE_STATUS.CLOSED]: [DEBIT_NOTE_STATUS.OPEN, DEBIT_NOTE_STATUS.DRAFT],
    [DEBIT_NOTE_STATUS.CANCELLED]: [DEBIT_NOTE_STATUS.DRAFT, DEBIT_NOTE_STATUS.OPEN],
    [DEBIT_NOTE_STATUS.PARTIALLY_USED]: [DEBIT_NOTE_STATUS.CLOSED],
  },
};
// Validate status transition
const validateStatusTransition = (statusTransitions, currentStatus, newStatus) => {
  if (!statusTransitions[currentStatus]?.includes(newStatus)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid status transition from ${currentStatus} to ${newStatus}`);
  }
};

//  Validate edit permissions
const validateEditPermissions = (editRestrictedStatuses, currentStatus) => {
  if (editRestrictedStatuses.includes(currentStatus)) {
    throw new ApiError(httpStatus.BAD_GATEWAY, `Editing is restricted for ${currentStatus} status`);
  }
};

const hasStockEffect = inventoryConfig =>
  !!inventoryConfig && !!(inventoryConfig.stockDeductEnabled || inventoryConfig.stockAddEnabled);

const assertRevertAllowed = ({ isUncancel = false, hasEffect = false } = {}) => {
  if (isUncancel && hasEffect) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This document cannot be reverted from Cancelled because its stock or accounting entries were released on cancellation.',
    );
  }
};

// Validate stock availability
// Row quantities are in the unit the row was entered in (itemUnitId); stock is kept in the item's main unit,
// so rows are converted and summed per item before comparing. `oldItems` (the document's previous rows) gives the
// quantity the document already holds, so only the increase is checked. `oldItemsMap` (itemId → quantity) is a
// fallback for callers that cannot pass rows; its quantities are assumed to be in the same unit as the new rows.
const validateStockAvailability = async (
  { items, oldItems = null, oldItemsMap = null, companyId = null, warehouseId = null },
  session = null,
) => {
  const { Item, ItemInventory, ItemUnit, Warehouse } = getBooksCrmModels();
  const warehouse = warehouseId ? await Warehouse.findById(warehouseId).select('name').session(session) : null;
  const warehouseName = warehouse?.name || 'selected warehouse';

  const itemIds = [
    ...new Set([...(items || []), ...(oldItems || [])].map(row => row.itemId && String(row.itemId)).filter(Boolean)),
  ];
  const itemDocs = await Item.find({ _id: { $in: itemIds } })
    .select('itemCategory.isService trackInventory itemNo itemName itemUnitId unitConversions')
    .session(session)
    .lean();
  const itemDocMap = new Map(itemDocs.map(doc => [String(doc._id), doc]));

  const sumBaseQuantity = rows => {
    const totals = new Map();
    for (const row of rows || []) {
      if (!row.itemId) continue;
      const id = String(row.itemId);
      const rowItem = itemDocMap.get(id);
      const factor = rowItem ? resolveUnitConversion(rowItem, row.itemUnitId) : 1;
      totals.set(id, (totals.get(id) || 0) + (Number(row.quantity) || 0) * factor);
    }
    return totals;
  };

  const newTotals = sumBaseQuantity(items);
  const oldTotals = oldItems ? sumBaseQuantity(oldItems) : null;
  const checked = new Set();

  for (const item of items) {
    const itemKey = String(item.itemId);
    if (checked.has(itemKey)) continue;
    checked.add(itemKey);

    const itemDoc = itemDocMap.get(itemKey);
    if (itemDoc?.itemCategory?.isService || itemDoc?.trackInventory === false) {
      continue;
    }

    const itemLabel = `${item.itemName}${itemDoc?.itemNo ? ` (${itemDoc.itemNo})` : ''}`;

    const itemInventory = await ItemInventory.findOne({
      itemId: item.itemId,
      companyId: companyId,
      'warehouses.warehouseId': warehouseId,
    }).session(session);

    if (!itemInventory) {
      continue;
    }

    const warehouseStock = itemInventory?.warehouses?.find(
      warehouse => warehouse.warehouseId.toString() === warehouseId.toString(),
    );

    if (!warehouseStock) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Item ${itemLabel} is not available in warehouse: ${warehouseName}`);
    }

    let oldQuantity = 0;
    if (oldTotals) {
      oldQuantity = oldTotals.get(itemKey) || 0;
    } else if (oldItemsMap) {
      oldQuantity = (oldItemsMap.get(itemKey) || 0) * resolveUnitConversion(itemDoc, item.itemUnitId);
    }
    const quantity = roundQty(newTotals.get(itemKey) - oldQuantity);

    if (quantity > 0 && warehouseStock.availableStock < quantity) {
      // Stock and requested quantity are in the main unit; report them in the unit the document line uses.
      const factor = resolveUnitConversion(itemDoc, item.itemUnitId) || 1;
      const isMainUnit = !item.itemUnitId || String(item.itemUnitId) === String(itemDoc?.itemUnitId);
      const unit = isMainUnit ? null : await ItemUnit.findById(item.itemUnitId).select('name').session(session).lean();
      const unitSuffix = unit?.name ? ` ${unit.name}` : '';
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Insufficient stock for item ${itemLabel} in warehouse ${warehouseName}. Requested ${roundQty(quantity / factor)}${unitSuffix}, available ${roundQty(warehouseStock.availableStock / factor)}${unitSuffix}`,
      );
    }
  }
};

const getInventoryConfig = async (companyId, moduleName, session = null) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId).session(session);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const companyConfig = await CompanySettings.findOne({ companyId }).session(session);

  const { inventoryConfig } = companyConfig;

  if (SALES_MODULES.includes(moduleName)) {
    return {
      stockCheckEnabled: inventoryConfig?.salesFlowStockCheckSource?.includes(moduleName),
      stockDeductEnabled: inventoryConfig?.salesFlowStockDeductSource === moduleName,
    };
  }

  if (PURCHASE_MODULES.includes(moduleName)) {
    return {
      stockAddEnabled: inventoryConfig?.purchaseFlowStockAddSource === moduleName,
      purchaseFlowStockAddSource: inventoryConfig?.purchaseFlowStockAddSource || null,
    };
  }

  return {
    stockCheckEnabled: inventoryConfig?.salesFlowStockCheckSource?.includes(moduleName),
    stockDeductEnabled: inventoryConfig?.salesFlowStockDeductSource === moduleName,
    stockAddEnabled: inventoryConfig?.purchaseFlowStockAddSource === moduleName,
  };
};

/**
 * Get inventory configuration for profit/loss calculations
 * Returns the actual configuration names instead of boolean values
 * @param {string} companyId - Company ID
 * @param {Object} session - MongoDB session (optional)
 * @returns {Promise<Object>} Inventory configuration with source names
 */
const getInventoryConfigForProfitLoss = async (companyId, session = null) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId).session(session);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const companyConfig = await CompanySettings.findOne({ companyId }).session(session);
  const { inventoryConfig } = companyConfig;

  return {
    stockDeductSource: inventoryConfig?.salesFlowStockDeductSource || null,
    stockCheckSource: inventoryConfig?.salesFlowStockCheckSource || [],
  };
};

const checkRawMaterialsStockAvailability = async ({
  warehouseId,
  rawMaterials,
  companyId,
  session = null,
  includeRejectQty = false,
  strictValidation = false,
}) => {
  const { Item, Warehouse, ItemInventory } = getBooksCrmModels();

  const rawMaterialIds = rawMaterials?.map(rm => rm.rawMaterialId) || [];

  const [warehouse, items, itemInventories] = await Promise.all([
    Warehouse.findById(warehouseId).session(session).lean(),
    Item.find({ _id: { $in: rawMaterialIds }, companyId })
      .select('itemName itemCategory itemUnitId unitConversions')
      .session(session)
      .lean(),
    ItemInventory.find({ itemId: { $in: rawMaterialIds }, companyId })
      .session(session)
      .lean(),
  ]);

  if (!warehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Warehouse not found');
  }

  const itemMap = new Map(items.map(i => [i._id.toString(), i]));
  const inventoryMap = new Map(itemInventories.map(inv => [inv.itemId.toString(), inv]));

  // Required quantity per item in the item's main unit. The same item can appear on several rows (and in several
  // units), and they all draw on the same stock, so rows are totalled before the stock comparison.
  const requiredByItem = new Map();

  for (const rm of rawMaterials) {
    const { rawMaterialId } = rm;

    const item = itemMap.get(rawMaterialId.toString());
    if (!item) {
      throw new ApiError(httpStatus.NOT_FOUND, `Raw material not found: ${rawMaterialId}`);
    }
    if (item?.itemCategory?.isService) {
      continue;
    }

    let requiredQty = 0;

    if (includeRejectQty) {
      requiredQty = (rm.productionOrderSubmittedUnit || 0) + (rm.rejectQty || 0);
    } else {
      requiredQty = rm.productionOrderRequiredUnit;
    }

    // Required quantity is in the row's unit (itemUnitId); stock is kept in the item's main unit.
    requiredQty *= resolveUnitConversion(item, rm.itemUnitId);

    if (strictValidation && (!requiredQty || requiredQty <= 0)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Invalid quantity for ${item.itemName}`);
    }

    const key = rawMaterialId.toString();
    requiredByItem.set(key, { item, requiredQty: (requiredByItem.get(key)?.requiredQty || 0) + (requiredQty || 0) });
  }

  for (const [itemId, { item, requiredQty }] of requiredByItem) {
    const itemInventory = inventoryMap.get(itemId);
    if (!itemInventory) {
      throw new ApiError(httpStatus.NOT_FOUND, `Item inventory not found for item: ${item.itemName}`);
    }

    const inventoryWarehouse = itemInventory.warehouses?.find(w => w.warehouseId.toString() === warehouseId.toString());

    if (!inventoryWarehouse || inventoryWarehouse.availableStock < roundQty(requiredQty)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Insufficient stock for raw material ${item.itemName} in warehouse ${warehouse.name}`,
      );
    }
  }

  return {
    success: true,
    message: 'Sufficient stock available for all raw materials',
  };
};

module.exports = {
  QUOTE_STATUS_CONFIG,
  SALES_ORDER_STATUS_CONFIG,
  DELIVERY_CHALLAN_STATUS_CONFIG,
  INVOICE_STATUS_CONFIG,
  PURCHASE_ORDER_STATUS_CONFIG,
  GRPO_STATUS_CONFIG,
  BILL_STATUS_CONFIG,
  CREDIT_STATUS_CONFIG,
  validateStatusTransition,
  validateEditPermissions,
  hasStockEffect,
  assertRevertAllowed,
  validateStockAvailability,
  getInventoryConfig,
  getInventoryConfigForProfitLoss,
  checkRawMaterialsStockAvailability,
};
