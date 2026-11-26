// services/documentItemEnricher.service.js
//
// Single source of truth for item line enrichment + selectability across every document
// module (quote, sales order, delivery challan, invoice, purchase order, GRPO, bill).
//
// It does two independent jobs for a set of document lines:
//   1. Snapshot — fills the display fields (itemNo/itemName/hsnCode/itemUnit/gst) from the
//      Item master so a line NEVER renders blank, regardless of how it was created.
//   2. Classify — tags each line with an `itemIssue` so callers can enforce the business rule:
//        - global active gate  (item.itemStatus === true)
//        - warehouse availability (active inventory row in the selected warehouse)
//
// Enrichment never queries per line — it batch-loads the master once (the getNameMap pattern),
// because these item tables can be long.
//
// The ENFORCEMENT decision stays with the caller, because it differs by write path:
//   - A newly ADDED line must reference an active item        → assertSelectableForNewLines
//   - A CARRIED line (conversion / editing an issued doc) may
//     keep an item that was since deactivated (inactivation
//     is not retroactive), but must still resolve to an item  → assertResolvable
//   - Warehouse availability blocks newly added lines only; on carried lines the UI shows a warning.

const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { getBooksCrmModels } = require('./model.service');
const { resolveUnitConversion } = require('./warehouseBatch.service');

// Display fields sourced from the Item master. `description` is intentionally excluded —
// it is user-editable per line and must not be overwritten from the master.
const ITEM_SNAPSHOT_FIELDS = ['itemNo', 'itemName', 'hsnCode', 'itemUnit', 'gst'];

const ITEM_LINE_ISSUE = {
  NONE: null,
  MISSING: 'ITEM_MISSING', // itemId does not resolve to an item in this company
  INACTIVE: 'ITEM_INACTIVE', // global itemStatus === false
  NOT_IN_WAREHOUSE: 'ITEM_NOT_IN_WAREHOUSE', // inventory-tracked, no active stock row in the warehouse
};

// 'overwrite'   — authoritative fresh snapshot from the master. Use on CREATE / conversion.
// 'fillMissing' — only populate empty snapshot fields; never clobber a stored value. Use on
//                 READ and on UPDATE of an already-issued document, so renaming an item later
//                 does not rewrite historical documents (audit / GST immutability).
const SNAPSHOT_MODE = { OVERWRITE: 'overwrite', FILL_MISSING: 'fillMissing' };

const isEmpty = value => value === undefined || value === null || value === '';

/**
 * Enrich document lines with the item snapshot and an `itemIssue` classification.
 *
 * @param {Array}  lines                     document line items (each with an `itemId`)
 * @param {Object} opts
 * @param {string} opts.companyId
 * @param {string} [opts.warehouseId]        when present, the warehouse-availability flag is computed
 * @param {Object} [opts.session]            mongoose session for transactional writes
 * @param {string} [opts.snapshotMode]       SNAPSHOT_MODE.* (default FILL_MISSING — the safe default)
 * @returns {Promise<Array>} new line objects: { ...line, <snapshot>, itemIssue }
 */
const enrichDocumentItemLines = async (
  lines,
  { companyId, warehouseId, session, snapshotMode = SNAPSHOT_MODE.FILL_MISSING } = {},
) => {
  if (!Array.isArray(lines) || lines.length === 0) return lines;

  const { Item, ItemInventory } = getBooksCrmModels();

  // Batch-load the master once.
  const itemIds = [
    ...new Set(
      lines
        .map(line => line?.itemId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const items = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemNo itemName hsnCode itemUnit gst itemStatus trackInventory itemCategory.isService')
        .session(session || null)
        .lean()
    : [];
  const itemById = new Map(items.map(item => [String(item._id), item]));

  // Warehouse inventory rows are only needed for the availability flag.
  let inventoryByItemId = new Map();
  if (warehouseId && itemIds.length) {
    const inventories = await ItemInventory.find({ itemId: { $in: itemIds }, companyId })
      .select('itemId warehouses.warehouseId warehouses.isActive')
      .session(session || null)
      .lean();
    inventoryByItemId = new Map(inventories.map(inv => [String(inv.itemId), inv]));
  }

  const overwrite = snapshotMode === SNAPSHOT_MODE.OVERWRITE;

  return lines.map(line => {
    // A line with no itemId is a non-catalog / free-text line — nothing to enrich or enforce.
    if (!line?.itemId) {
      return { ...line, itemIssue: ITEM_LINE_ISSUE.NONE };
    }

    const master = itemById.get(String(line.itemId));
    if (!master) {
      // Present but unresolvable itemId — a genuinely broken reference. Keep the stored line as-is
      // (its numbers are still valid) but flag it.
      return { ...line, itemIssue: ITEM_LINE_ISSUE.MISSING };
    }

    // 1) Snapshot the display fields.
    const enriched = { ...line };
    for (const field of ITEM_SNAPSHOT_FIELDS) {
      if (overwrite || isEmpty(enriched[field])) {
        enriched[field] = master[field] ?? enriched[field] ?? '';
      }
    }

    // 2) Classify. The global active gate takes priority over warehouse availability.
    let itemIssue = ITEM_LINE_ISSUE.NONE;
    if (master.itemStatus !== true) {
      itemIssue = ITEM_LINE_ISSUE.INACTIVE;
    } else if (warehouseId) {
      // Warehouse availability mirrors the item dropdown's own exceptions: service items and
      // non-inventory items are legitimately sellable from any warehouse without a stock row,
      // so they are never flagged here.
      const carriesNoStock = master.itemCategory?.isService === true || master.trackInventory === false;
      if (!carriesNoStock) {
        const inventory = inventoryByItemId.get(String(line.itemId));
        const hasActiveWarehouseRow = (inventory?.warehouses || []).some(
          row => String(row.warehouseId) === String(warehouseId) && row.isActive !== false,
        );
        if (!hasActiveWarehouseRow) itemIssue = ITEM_LINE_ISSUE.NOT_IN_WAREHOUSE;
      }
    }

    enriched.itemIssue = itemIssue;
    return enriched;
  });
};

const describeBlockedLines = blocked =>
  blocked.map(line => ({
    itemId: line.itemId ? String(line.itemId) : null,
    itemName: line.itemName || null,
    itemIssue: line.itemIssue,
  }));

const NEW_LINE_BLOCKING_ISSUES = [ITEM_LINE_ISSUE.MISSING, ITEM_LINE_ISSUE.INACTIVE, ITEM_LINE_ISSUE.NOT_IN_WAREHOUSE];

// Same wording as the frontend save guard (itemLineStatus.buildWarehouseBlockMessage).
const buildNotSelectableMessage = (blocked, documentLabel) => {
  const names = blocked.map(line => line.itemName || line.itemId).join(', ');
  return blocked.length > 1
    ? `${names} are inactive or not available in the selected warehouse, so this ${documentLabel} can't be saved yet. To continue, activate these items from the Item Master and make sure they're available in the selected warehouse. You can then save the document.`
    : `${names} is inactive or not available in the selected warehouse, so this ${documentLabel} can't be saved yet. To continue, activate this item from the Item Master and make sure it's available in the selected warehouse. You can then save the document.`;
};

// New lines only: the item must resolve, be active and be available in the warehouse (mirrors the item dropdown).
const assertSelectableForNewLines = (enrichedLines, documentLabel = 'document') => {
  const blocked = (enrichedLines || []).filter(line => NEW_LINE_BLOCKING_ISSUES.includes(line.itemIssue));
  if (blocked.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, buildNotSelectableMessage(blocked, documentLabel), 'ITEM_NOT_SELECTABLE', {
      lines: describeBlockedLines(blocked),
    });
  }
};

// Enforce on CARRIED lines (conversion / update of existing lines): the item must still resolve,
// but an item deactivated after the source document was created is tolerated (not retroactive).
const assertResolvable = enrichedLines => {
  const blocked = (enrichedLines || []).filter(line => line.itemIssue === ITEM_LINE_ISSUE.MISSING);
  if (blocked.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `These line items reference an item that no longer exists: ${blocked.map(line => line.itemName || line.itemId).join(', ')}`,
      'ITEM_NOT_RESOLVABLE',
      { lines: describeBlockedLines(blocked) },
    );
  }
};

// Purchase: every line must be active in the warehouse; an inactive item blocks only lines not in carriedItemIds.
const assertPurchaseLinesSelectable = async (lines, { carriedItemIds = [], warehouseId, companyId, session, documentLabel }) => {
  const enrichedLines = await enrichDocumentItemLines(lines, { companyId, warehouseId, session });
  assertResolvable(enrichedLines);

  const carried = new Set([...carriedItemIds].filter(Boolean).map(String));
  const blocked = (enrichedLines || []).filter(
    line =>
      line.itemIssue === ITEM_LINE_ISSUE.NOT_IN_WAREHOUSE ||
      (line.itemIssue === ITEM_LINE_ISSUE.INACTIVE && !carried.has(String(line.itemId))),
  );
  if (blocked.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, buildNotSelectableMessage(blocked, documentLabel), 'ITEM_NOT_SELECTABLE', {
      lines: describeBlockedLines(blocked),
    });
  }
};

// Re-activates or adds a zero-stock warehouse row for active stock items; inactive items are left for the guard to reject.
const activateItemsInWarehouse = async ({ itemIds, warehouseId, companyId, userId, session }) => {
  const { Item, ItemInventory, Warehouse } = getBooksCrmModels();
  const uniqueItemIds = [...new Set((itemIds || []).filter(Boolean).map(String))];
  if (!uniqueItemIds.length) return;

  const warehouse = await Warehouse.findOne({ _id: warehouseId, companyId })
    .select('divisionId branchId')
    .session(session)
    .lean();
  if (!warehouse) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Warehouse not found');
  }

  const stockItems = await Item.find({
    _id: { $in: uniqueItemIds },
    companyId,
    itemStatus: true,
    trackInventory: { $ne: false },
    'itemCategory.isService': { $ne: true },
  })
    .select('_id')
    .session(session)
    .lean();
  if (!stockItems.length) return;

  const stockItemIds = stockItems.map(item => item._id);
  const warehouseRow = {
    divisionId: warehouse.divisionId,
    branchId: warehouse.branchId,
    warehouseId: warehouse._id,
    isActive: true,
    openingStock: 0,
    openingStockRate: 0,
    availableStock: 0,
    inventoryValue: 0,
  };

  const existingInventories = await ItemInventory.find({ itemId: { $in: stockItemIds }, companyId })
    .select('itemId')
    .session(session)
    .lean();
  const itemIdsWithInventory = new Set(existingInventories.map(inventory => String(inventory.itemId)));
  const itemIdsWithoutInventory = stockItemIds.filter(itemId => !itemIdsWithInventory.has(String(itemId)));

  if (itemIdsWithoutInventory.length) {
    await ItemInventory.insertMany(
      itemIdsWithoutInventory.map(itemId => ({
        itemId,
        companyId,
        warehouses: [warehouseRow],
        addedBy: userId,
        updatedBy: userId,
      })),
      { session },
    );
  }

  // Per item: re-activate the row when it exists, otherwise add it. The two filters are mutually exclusive.
  const operations = existingInventories
    .map(inventory => inventory.itemId)
    .flatMap(itemId => [
      {
        updateOne: {
          filter: { itemId, companyId, 'warehouses.warehouseId': warehouse._id },
          update: { $set: { 'warehouses.$.isActive': true, updatedBy: userId } },
        },
      },
      {
        updateOne: {
          filter: { itemId, companyId, 'warehouses.warehouseId': { $ne: warehouse._id } },
          update: { $push: { warehouses: warehouseRow }, $set: { updatedBy: userId } },
        },
      },
    ]);
  if (operations.length) {
    await ItemInventory.bulkWrite(operations, { session, ordered: true });
  }
};

// Each line's unit (itemUnitId) must be the item's main unit or one of its configured conversions. Checked when a
// document is saved so a bad unit is rejected up front instead of failing later when stock moves (or never, on a
// document that has no stock effect). Lines without an itemId or itemUnitId are skipped (main unit assumed).
const assertLineUnitsValid = async (lines, { companyId, session } = {}) => {
  const unitLines = (lines || []).filter(line => line?.itemId && line?.itemUnitId);
  if (!unitLines.length) return;

  const { Item } = getBooksCrmModels();
  const itemIds = [...new Set(unitLines.map(line => String(line.itemId?._id || line.itemId)))];
  const items = await Item.find({ _id: { $in: itemIds }, ...(companyId && { companyId }) })
    .select('itemName itemUnitId unitConversions')
    .session(session || null)
    .lean();
  const itemById = new Map(items.map(item => [String(item._id), item]));

  for (const line of unitLines) {
    const item = itemById.get(String(line.itemId?._id || line.itemId));
    // An unresolvable item is reported by assertResolvable / assertSelectableForNewLines, not here.
    if (item) resolveUnitConversion(item, line.itemUnitId?._id || line.itemUnitId);
  }
};

module.exports = {
  ITEM_LINE_ISSUE,
  activateItemsInWarehouse,
  SNAPSHOT_MODE,
  enrichDocumentItemLines,
  assertSelectableForNewLines,
  assertResolvable,
  assertPurchaseLinesSelectable,
  assertLineUnitsValid,
};
