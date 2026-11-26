// services/item.service.js
const httpStatus = require('http-status');
const { getBooksCrmModels, getClientConnection, getBooksModels, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { ITEM_MESSAGES } = require('../../../utils/messages');
const {
  itemsInUse,
  cleanupItemOwnedRecords,
  itemHasBatchOrProductionOrder,
} = require('../../../services/itemDeleteGuard.service');
const mongoose = require('mongoose');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { postOpeningBalanceJournal, deleteJournal } = require('../../accountant/ledger/ledger.service');
const { LEDGER_SOURCE_MODULES, ACCOUNT_CATEGORIES, STOCK_STATUS } = require('../../../utils/enum');
const {
  MODULE_NAMES,
  INVENTORY_TRANSFER_REQUEST,
  PRODUCTION_ORDER_STATUS,
  PRODUCTION_MANAGE_METHOD,
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  INVOICE_STATUS,
  SALES_ORDER_INVOICE_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  BILL_STATUSES,
  CREDIT_NOTE_STATUS,
  DEBIT_NOTE_STATUS,
  ITEM_BATCH_SOURCE_TYPE,
} = require('../../../utils/enum');
const { escapeRegex, createSearchRegex } = require('../../../utils/regexUtils');
const { isProductionDataComplete } = require('../../../utils/production');
const { APP_NAME, BALANCE_TYPES, PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { activeFeatureList } = require('../../setting/companyProfile/companyProfile.service');
const logger = require('../../../config/logger');
const { uploadFileToS3, handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
  resolveUnitConversion,
  roundQty,
} = require('../../../services/warehouseBatch.service');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { getCurrency } = require('../../../services/currencyResolver.service');
const { itemUnitUsage } = require('../itemUnit/itemUnit.service');

const SALES_ACCOUNT_CATEGORIES = [ACCOUNT_CATEGORIES.INCOME.code, ACCOUNT_CATEGORIES.OTHER_INCOME.code];
const PURCHASE_ACCOUNT_CATEGORIES = [
  ACCOUNT_CATEGORIES.FIXED_ASSET.code,
  ACCOUNT_CATEGORIES.EXPENSE.code,
  ACCOUNT_CATEGORIES.COGS.code,
  ACCOUNT_CATEGORIES.OTHER_EXPENSE.code,
];
const INVENTORY_ACCOUNT_CATEGORY = ACCOUNT_CATEGORIES.STOCK.code;
const BULK_ITEM_ACCOUNT_CATEGORIES = [...SALES_ACCOUNT_CATEGORIES, ...PURCHASE_ACCOUNT_CATEGORIES, INVENTORY_ACCOUNT_CATEGORY];

const BULK_ITEM_TYPES = ['RM', 'FG', 'SEMI_RM', 'CONSUMABLE', 'TRADE', 'SCRAP', 'SERVICE'];

/** Buckets a company's Chart of Accounts by bulk-item role (sales/purchase/inventory) so
 * validateBulkItemFields can check a row's account name against real accounts without a
 * per-item DB call. Also exposes name->id maps scoped to the same category buckets, so
 * createBulkItems resolves each row to an account of the *correct* category — account names
 * aren't unique across categories, so a flat, category-blind name->id map could silently
 * resolve a row to the wrong account (e.g. an Expense account sharing a name with an Income
 * account) even though validation confirmed a same-named account exists in the right category. */
const buildBulkAccountNameSets = accounts => {
  // A selling account must be an Income account specifically — Other Income accounts (e.g.
  // interest income) aren't valid sales accounts even though they share the sales fetch above.
  const salesAccounts = accounts.filter(account => account.category === ACCOUNT_CATEGORIES.INCOME.code);
  const purchaseAccounts = accounts.filter(account => PURCHASE_ACCOUNT_CATEGORIES.includes(account.category));
  const inventoryAccounts = accounts.filter(account => account.category === INVENTORY_ACCOUNT_CATEGORY);

  return {
    salesAccountNames: new Set(salesAccounts.map(account => account.accountName)),
    purchaseAccountNames: new Set(purchaseAccounts.map(account => account.accountName)),
    inventoryAccountNames: new Set(inventoryAccounts.map(account => account.accountName)),
    salesAccountIdByName: Object.fromEntries(salesAccounts.map(account => [account.accountName, account._id])),
    purchaseAccountIdByName: Object.fromEntries(purchaseAccounts.map(account => [account.accountName, account._id])),
    inventoryAccountIdByName: Object.fromEntries(inventoryAccounts.map(account => [account.accountName, account._id])),
  };
};

const unitNameKey = name => String(name).trim().toLowerCase();

/** A spreadsheet carries unit names, not ids — load the company's active units keyed by name (case-insensitive). */
const loadActiveUnitsByName = async (companyId, session = null) => {
  const { ItemUnit } = getBooksCrmModels();
  const units = await ItemUnit.find({ companyId, isActive: true }).select('name').session(session).lean();
  return new Map(units.map(unit => [unitNameKey(unit.name), unit]));
};

const unitNotFoundError = itemUnit => ({
  name: 'ITEM_UNIT_NOT_FOUND',
  message: `Item unit does not exist or is inactive: ${itemUnit}`,
});

/** Field-level "required" checks for a single bulk item row, shared by
 * verifyBulkItemCreation and createBulkItems so both report the same errors per-row
 * instead of relying on Joi to reject the whole sheet. `accountNameSets` (from
 * buildBulkAccountNameSets) is optional so callers without account context can still get the
 * required-field checks. */
const validateBulkItemFields = (item, accountNameSets) => {
  const errors = [];

  if (!item.itemName) {
    errors.push({ name: 'ITEM_NAME_REQUIRED', message: 'Item Name is required.' });
  }

  if (!item.itemType) {
    errors.push({ name: 'ITEM_TYPE_REQUIRED', message: 'Item Type is required.' });
  } else if (!BULK_ITEM_TYPES.includes(item.itemType)) {
    errors.push({
      name: 'INVALID_ITEM_TYPE',
      message: `Item Type must be one of ${BULK_ITEM_TYPES.join(', ')}: ${item.itemType}`,
    });
  }

  if (!item.itemGroup) {
    errors.push({ name: 'ITEM_GROUP_REQUIRED', message: 'Item Group is required.' });
  }

  const itemCategory = item.itemCategory || {};
  if (!itemCategory.isGoods && !itemCategory.isService) {
    errors.push({ name: 'ITEM_CATEGORY_REQUIRED', message: 'Please select either Goods or Service.' });
  }

  if (!item.itemUnit) {
    errors.push({ name: 'ITEM_UNIT_REQUIRED', message: 'Item Unit is required.' });
  }

  if (!item.gst) {
    errors.push({ name: 'GST_REQUIRED', message: 'GST Tax Applicable is required.' });
  }

  if (!item.hsnCode) {
    errors.push({ name: 'HSN_CODE_REQUIRED', message: 'HSN Code is required.' });
  }

  const salesInfo = item.salesInformation || {};
  const purchaseInfo = item.purchaseInformation || {};
  const isSellable = salesInfo.isSellable === true;
  const isPurchasable = purchaseInfo.isPurchasable === true;
  const isTrackInventory = item.trackInventory === true;

  // Every row must play at least one role — sold, bought, or stocked.
  if (!isSellable && !isPurchasable && !isTrackInventory) {
    errors.push({ name: 'NO_ROLE_SELECTED', message: ITEM_MESSAGES.NO_ROLE_SELECTED });
  }

  if (isSellable) {
    if (!(Number(salesInfo.sellingPrice) > 0)) {
      errors.push({ name: 'SELLING_PRICE_REQUIRED', message: ITEM_MESSAGES.SELLING_PRICE_REQUIRED });
    }
    if (!salesInfo.salesAccountName) {
      errors.push({ name: 'SALES_ACCOUNT_REQUIRED', message: ITEM_MESSAGES.SALES_ACCOUNT_REQUIRED });
    } else if (accountNameSets && !accountNameSets.salesAccountNames.has(salesInfo.salesAccountName)) {
      errors.push({
        name: 'SALES_ACCOUNT_NOT_FOUND',
        message: `Sales account does not exist: ${salesInfo.salesAccountName}`,
      });
    }
  } else {
    // A row that opted out of Sellable shouldn't carry sale pricing/account leftovers either.
    if (Number(salesInfo.sellingPrice) > 0) {
      errors.push({ name: 'SELLING_PRICE_NOT_ALLOWED', message: ITEM_MESSAGES.SELLING_PRICE_NOT_ALLOWED });
    }
    if (salesInfo.salesAccountName) {
      errors.push({ name: 'SALES_ACCOUNT_NOT_ALLOWED', message: ITEM_MESSAGES.SALES_ACCOUNT_NOT_ALLOWED });
    }
  }

  if (isPurchasable) {
    if (!(Number(purchaseInfo.costPrice) > 0)) {
      errors.push({ name: 'COST_PRICE_REQUIRED', message: ITEM_MESSAGES.COST_PRICE_REQUIRED });
    }
    if (!purchaseInfo.purchaseAccountName) {
      errors.push({ name: 'PURCHASE_ACCOUNT_REQUIRED', message: ITEM_MESSAGES.PURCHASE_ACCOUNT_REQUIRED });
    } else if (accountNameSets && !accountNameSets.purchaseAccountNames.has(purchaseInfo.purchaseAccountName)) {
      errors.push({
        name: 'PURCHASE_ACCOUNT_NOT_FOUND',
        message: `Purchase account does not exist: ${purchaseInfo.purchaseAccountName}`,
      });
    }
  } else {
    if (Number(purchaseInfo.costPrice) > 0) {
      errors.push({ name: 'COST_PRICE_NOT_ALLOWED', message: ITEM_MESSAGES.COST_PRICE_NOT_ALLOWED });
    }
    if (purchaseInfo.purchaseAccountName) {
      errors.push({ name: 'PURCHASE_ACCOUNT_NOT_ALLOWED', message: ITEM_MESSAGES.PURCHASE_ACCOUNT_NOT_ALLOWED });
    }
  }

  if (itemCategory.isService && isTrackInventory) {
    errors.push({ name: 'SERVICE_CANNOT_TRACK_INVENTORY', message: ITEM_MESSAGES.SERVICE_CANNOT_TRACK_INVENTORY });
  }

  if (isTrackInventory) {
    if (!item.inventoryAccountName) {
      errors.push({ name: 'INVENTORY_ACCOUNT_REQUIRED', message: ITEM_MESSAGES.INVENTORY_ACCOUNT_REQUIRED });
    } else if (accountNameSets && !accountNameSets.inventoryAccountNames.has(item.inventoryAccountName)) {
      errors.push({
        name: 'INVENTORY_ACCOUNT_NOT_FOUND',
        message: `Inventory account does not exist: ${item.inventoryAccountName}`,
      });
    }
  } else if (item.inventoryAccountName) {
    errors.push({ name: 'INVENTORY_ACCOUNT_NOT_ALLOWED', message: ITEM_MESSAGES.INVENTORY_ACCOUNT_NOT_ALLOWED });
  }

  return errors;
};

// Each BOM / scrap row's unit must be the row item's main unit or one of its configured conversions.
const assertProductionRowUnitsValid = async (productionData, companyId, session = null) => {
  const rows = [
    ...(productionData?.bomBased || []).map(row => ({ itemId: row.item, itemUnitId: row.itemUnitId })),
    ...(productionData?.productionScrapOutInventory || []).map(row => ({
      itemId: row.scrapItemName,
      itemUnitId: row.itemUnitId,
    })),
  ].filter(row => row.itemId && row.itemUnitId);
  if (!rows.length) return;

  const { Item } = getBooksCrmModels();
  const items = await Item.find({ _id: { $in: [...new Set(rows.map(r => String(r.itemId)))] }, companyId })
    .select('itemName itemUnitId unitConversions')
    .session(session)
    .lean();
  const itemMap = new Map(items.map(i => [String(i._id), i]));
  for (const row of rows) {
    const rowItem = itemMap.get(String(row.itemId));
    if (rowItem) resolveUnitConversion(rowItem, row.itemUnitId);
  }
};

const assertProductionItemsAreStock = async (productionData, companyId, session = null) => {
  await assertProductionRowUnitsValid(productionData, companyId, session);
  const ids = (productionData?.bomBased || []).map(row => row.item).filter(Boolean);
  if (!ids.length) return;

  const { Item } = getBooksCrmModels();
  const bad = await Item.find({
    _id: { $in: ids },
    companyId,
    $or: [{ 'itemCategory.isService': true }, { trackInventory: false }],
  })
    .select('itemName')
    .session(session)
    .lean();

  if (bad.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `${ITEM_MESSAGES.PRODUCTION_ITEM_MUST_BE_STOCK}: ${[...new Set(bad.map(i => i.itemName))].join(', ')}`,
    );
  }
};

const assertStockUnitsValid = async (body, companyId, session) => {
  const unitIds = [...new Set([body.itemUnitId, body.stockInUnit, body.stockOutUnit].filter(Boolean).map(String))];
  if (!unitIds.length) return;
  const { ItemUnit } = getBooksCrmModels();
  const count = await ItemUnit.countDocuments({ _id: { $in: unitIds }, companyId, isActive: true }).session(session);
  if (count !== unitIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item unit, stock in unit or stock out unit is invalid or inactive.');
  }
};

/**
 * @param {ObjectId|string} companyId
 * @param {Object} salesData - incoming salesData, mutated in place
 * @param {Object} [storedSalesData] - the item's current salesData (update only)
 */
const applyPortalPlanGate = async (companyId, salesData, storedSalesData = null) => {
  if (!salesData) return;

  let isPortalInPlan = false;
  try {
    const features = await activeFeatureList(companyId);
    isPortalInPlan = Boolean(features?.[PLAN_FEATURES.CUSTOMER_ORDER]);
  } catch (error) {
    // No subscription found: treat the feature as unavailable rather than failing the item save.
    logger.warn(`Plan lookup failed for company ${companyId} while saving item portal settings: ${error.message}`);
  }
  if (isPortalInPlan) return;

  salesData.customerPortalEnable = Boolean(storedSalesData?.customerPortalEnable);
  salesData.specificCustomerEnable = Boolean(storedSalesData?.specificCustomerEnable);
  salesData.specificCustomers = storedSalesData?.specificCustomers || [];
};

/**
 * Create a new Item
 * @param {Object} itemBody
 * @param {ObjectId} userId
 * @returns {Promise<Item>}
 */
const createItem = async (
  itemBody,
  userId,
  regularAttachments = [],
  uploadedPurchasingDataFiles = [],
  uploadedSalesDataFiles = [],
) => {
  const { Item, Warehouse, ItemInventory } = getBooksCrmModels();
  await applyPortalPlanGate(itemBody.companyId, itemBody.salesData);
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    await assertProductionItemsAreStock(itemBody.productionData, itemBody.companyId, session);
    itemBody.itemNo = await generateUniqueId(
      Item,
      itemBody.companyId,
      MODULE_NAMES.ITEM,
      'itemNo',
      'ITM',
      session,
      itemBody.itemNo,
    );
    const commentHistory = [
      {
        message: `Item created`,
        addedBy: userId,
        createdAt: new Date(),
      },
    ];

    const findItemByName = await Item.findOne({
      itemName: itemBody.itemName,
      companyId: itemBody.companyId,
    }).session(session);

    if (findItemByName) {
      throw new ApiError(httpStatus.CONFLICT, 'Item with this name already exists.');
    }

    await assertStockUnitsValid(itemBody, itemBody.companyId, session);

    if (itemBody.unitConversions?.length) {
      const { ItemUnit } = getBooksCrmModels();
      const unitIds = itemBody.unitConversions.map(conversion => String(conversion.itemUnitId));
      if (new Set(unitIds).size !== unitIds.length) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Duplicate units are not allowed in unit conversions.');
      }
      const validUnitCount = await ItemUnit.countDocuments({
        _id: { $in: unitIds },
        companyId: itemBody.companyId,
        isActive: true,
      }).session(session);
      if (validUnitCount !== unitIds.length) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'One or more units in unit conversions are invalid or inactive.');
      }
    }
    // Prepare the item data
    const itemData = {
      ...itemBody,
      addedBy: userId,
      updatedBy: userId,
      commentHistory,
    };

    let attachmentUrls = [];
    let purchasingDataAttachmentUrls = [];
    let salesDataAttachmentUrls = [];
    if (regularAttachments.length > 0) {
      const uploadPromises = regularAttachments.map(file => uploadFileToS3(file, userId, itemBody.companyId));
      attachmentUrls = await Promise.all(uploadPromises);
    }

    if (uploadedPurchasingDataFiles.length > 0) {
      const uploadPromises = uploadedPurchasingDataFiles.map(file => uploadFileToS3(file, userId, itemBody.companyId));
      purchasingDataAttachmentUrls = await Promise.all(uploadPromises);
    }

    if (uploadedSalesDataFiles.length > 0) {
      const uploadPromises = uploadedSalesDataFiles.map(file => uploadFileToS3(file, userId, itemBody.companyId));
      salesDataAttachmentUrls = await Promise.all(uploadPromises);
    }

    itemData.purchasingData.vendorSideMFGAndQCDocument = purchasingDataAttachmentUrls;
    itemData.salesData.vendorSideMFGAndQCDocument = salesDataAttachmentUrls;
    itemData.attachments = attachmentUrls;
    itemData.appName = APP_NAME.BOOKS;
    const inventoryData = { ...itemBody.inventoryData };

    delete itemData.inventoryData;

    const createdItemArray = await Item.create([itemData], { session });
    const createdItem = createdItemArray[0];
    const isServiceItem = createdItem?.itemCategory?.isService;
    let itemInventory = null;
    if (createdItem && !isServiceItem) {
      const inventoryDataToCreate = {
        itemId: createdItem._id,
        companyId: createdItem.companyId,
        totalOpeningStock: inventoryData?.totalOpeningStock || 0,
        totalAvailableStock: 0,
        inventorySalesMethod: inventoryData?.inventorySalesMethod || null,
        minimumStockLevel: inventoryData?.minimumStockLevel || 0,
        maximumStockLevel: inventoryData?.maximumStockLevel || 0,
        warehouses: inventoryData?.warehouses || [],
        addedBy: userId,
        updatedBy: userId,
      };
      itemInventory = await ItemInventory.create([inventoryDataToCreate], { session });
      itemInventory = itemInventory[0];

      if (itemInventory.warehouses?.length) {
        for (const warehouse of itemInventory.warehouses) {
          // Ensure all stock fields exist
          warehouse.openingStock = warehouse.openingStock || 0;
          warehouse.availableStock = warehouse.availableStock || warehouse.openingStock || 0;
          warehouse.isActive = warehouse.isActive !== undefined ? warehouse.isActive : true;

          const warehouseDetails = await Warehouse.findById(warehouse.warehouseId).session(session);
          // add warehouseItem Batch
          const warehouseStockObj = {
            action: 'addStock',
            stockData: {
              itemId: createdItem._id,
              companyId: createdItem.companyId,
              branchId: warehouseDetails.branchId,
              divisionId: warehouseDetails?.divisionId,
              warehouseId: warehouse.warehouseId,
              quantity: warehouse.openingStock,
              purchasePrice: warehouse.openingStockRate || 0,
              vendorBatchNo: null,
              vendorBatchExpiry: null,
              sourceType: 'OPENING_STOCK',
              sourceId: createdItem._id,
            },
            session,
          };

          if (warehouse.openingStock > 0) {
            await handleWarehouseStock(warehouseStockObj);
          }
        }

        await checkCompanyStockLevels({
          itemIds: [createdItem._id],
          companyId: createdItem.companyId,
          docType: MODULE_NAMES.ITEM,
          docId: createdItem._id,
          docNo: createdItem.itemNo,
          userId,
          session,
        });
      }
    }

    if (itemInventory) {
      await syncItemOpeningStockJournal(createdItem, itemInventory.warehouses, userId, session);
    }

    // Save the updated item
    await createdItem.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    session.endSession();

    return createdItem;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error('Error creating item with stock:', error);
    throw error;
  }
};

/**
 * Create a bulk items
 * @param {Object} itemBody
 * @param {ObjectId} userId
 * @returns {Promise<Item>}
 */
// Replace the opening stock journal on the item inventory account when warehouse opening rows change.
const syncItemOpeningStockJournal = async (item, warehouses, userId, session) => {
  await deleteJournal(
    // Rows posted before opening balance was split by source still carry the old module.
    {
      companyId: item.companyId,
      sourceModule: { $in: [LEDGER_SOURCE_MODULES.OPENING_STOCK, LEDGER_SOURCE_MODULES.OPENING_BALANCE] },
      sourceId: item._id,
    },
    session,
  );

  const value =
    Math.round(
      (warehouses || []).reduce(
        (sum, warehouse) => sum + (Number(warehouse.openingStock) || 0) * (Number(warehouse.openingStockRate) || 0),
        0,
      ) * 100,
    ) / 100;
  if (!value) return;

  // Dr inventory account, Cr Opening Balance Adjustment — same pattern as a chart opening balance.
  await postOpeningBalanceJournal(
    {
      companyId: item.companyId,
      accountId: item.inventoryAccountId,
      amount: value,
      balanceType: BALANCE_TYPES.DEBIT,
      postingDate: new Date(),
      sourceId: item._id,
      sourceModule: LEDGER_SOURCE_MODULES.OPENING_STOCK,
      narration: `Opening stock ${item.itemNo}`,
      addedBy: userId,
    },
    session,
  );
};

const createBulkItems = async (reqBody, userId) => {
  const { Item, ItemGroup, SubItemGroup, ItemInventory, Warehouse } = getBooksCrmModels();
  const { Account } = getBooksModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { items, companyId } = reqBody;

    if (!Array.isArray(items) || items.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Items array is empty or invalid.');
    }

    // ================= COLLECT ALL VALIDATION ERRORS PER ITEM =================
    items.forEach(item => {
      if (typeof item.itemName === 'string') {
        item.itemName = item.itemName.trim();
      }
      if (typeof item.itemGroup === 'string') {
        item.itemGroup = item.itemGroup.trim();
      }
      if (typeof item.subItemGroup === 'string') {
        item.subItemGroup = item.subItemGroup.trim();
      }
    });

    const itemErrorsByIndex = items.map(() => []);

    // ---- Item name is required ----
    items.forEach((item, index) => {
      if (!item.itemName) {
        itemErrorsByIndex[index].push({ name: 'ITEM_NAME_REQUIRED', message: 'Item name is required.' });
      }
    });

    // ---- Duplicate item name within the sheet ----
    const itemNames = items.map(item => item.itemName).filter(Boolean);

    const nameCountInSheet = itemNames.reduce((acc, name) => {
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});

    items.forEach((item, index) => {
      if (item.itemName && nameCountInSheet[item.itemName] > 1) {
        itemErrorsByIndex[index].push({
          name: 'DUPLICATE_ITEM_NAME_IN_SHEET',
          message: `Duplicate item name in sheet: ${item.itemName}`,
        });
      }
    });

    // ---- Item name already exists in DB ----
    const existingItems = itemNames.length
      ? await Item.find({ companyId, itemName: { $in: itemNames } })
          .select('itemName')
          .lean()
          .session(session)
      : [];

    const existingItemNames = new Set(existingItems.map(item => item.itemName));

    items.forEach((item, index) => {
      if (item.itemName && existingItemNames.has(item.itemName)) {
        itemErrorsByIndex[index].push({
          name: 'ITEM_ALREADY_EXISTS',
          message: `Item already exists: ${item.itemName}`,
        });
      }
    });

    // ---- Item group must exist ----
    const itemGroupNames = [...new Set(items.map(item => item.itemGroup).filter(Boolean))];

    const existingItemGroups = itemGroupNames.length
      ? await ItemGroup.find({ name: { $in: itemGroupNames }, companyId })
          .session(session)
          .lean()
      : [];

    const existingItemGroupNames = new Set(existingItemGroups.map(group => group.name));

    items.forEach((item, index) => {
      if (item.itemGroup && !existingItemGroupNames.has(item.itemGroup)) {
        itemErrorsByIndex[index].push({
          name: 'ITEM_GROUP_NOT_FOUND',
          message: `Item group does not exist: ${item.itemGroup}`,
        });
      }
    });

    // ---- Sub item group, if provided, must exist ----
    const subItemGroupNames = [...new Set(items.map(item => item.subItemGroup).filter(Boolean))];

    const existingSubItemGroups = subItemGroupNames.length
      ? await SubItemGroup.find({ name: { $in: subItemGroupNames }, companyId })
          .session(session)
          .lean()
      : [];

    const existingSubItemGroupNames = new Set(existingSubItemGroups.map(group => group.name));

    items.forEach((item, index) => {
      if (item.subItemGroup && !existingSubItemGroupNames.has(item.subItemGroup)) {
        itemErrorsByIndex[index].push({
          name: 'SUB_ITEM_GROUP_NOT_FOUND',
          message: `Sub item group does not exist: ${item.subItemGroup}`,
        });
      }
    });

    // ---- Item unit must be one of the company's active units ----
    const unitByName = await loadActiveUnitsByName(companyId, session);
    items.forEach((item, index) => {
      if (item.itemUnit && !unitByName.has(unitNameKey(item.itemUnit))) {
        itemErrorsByIndex[index].push(unitNotFoundError(item.itemUnit));
      }
    });

    // A spreadsheet carries account names, not ids — resolve each against the company's real
    // Chart of Accounts, both for the field checks below and for the id lookup after creation.
    const accounts = await Account.find({ companyId, category: { $in: BULK_ITEM_ACCOUNT_CATEGORIES } })
      .select('accountName category')
      .session(session)
      .lean();
    const accountNameSets = buildBulkAccountNameSets(accounts);

    // ---- Remaining required/format checks (description, category, item unit, gst, hsn code,
    // sales/purchase/inventory role, pricing, and account) ----
    items.forEach((item, index) => {
      itemErrorsByIndex[index].push(...validateBulkItemFields(item, accountNameSets));
    });

    // ---- Bail out before creating anything if any item has errors ----
    const erroredItems = items.reduce((acc, item, index) => {
      if (itemErrorsByIndex[index].length) {
        acc.push({
          row: index + 1,
          itemName: item.itemName || null,
          itemNo: item.itemNo || null,
          errors: itemErrorsByIndex[index],
        });
      }
      return acc;
    }, []);

    if (erroredItems.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Bulk item validation failed.', 0, { errors: erroredItems });
    }

    const baseDate = new Date();

    const itemGroupMap = Object.fromEntries(existingItemGroups.map(group => [group.name, group._id]));
    const subItemGroupMap = Object.fromEntries(existingSubItemGroups.map(group => [group.name, group._id]));

    // Remove inventoryData from items since it's now in a separate collection
    const bulkItems = items.map((item, index) => {
      const { inventoryData, ...itemWithoutInventory } = item;

      const currentDate = new Date(baseDate.getTime() + index * 1000);

      const itemUnit = unitByName.get(unitNameKey(item.itemUnit));

      return {
        ...itemWithoutInventory,
        itemUnit: itemUnit.name,
        itemUnitId: itemUnit._id,
        ...(item.salesInformation?.isSellable && {
          salesInformation: {
            ...item.salesInformation,
            salesAccountId: accountNameSets.salesAccountIdByName[item.salesInformation.salesAccountName],
          },
        }),
        ...(item.purchaseInformation?.isPurchasable && {
          purchaseInformation: {
            ...item.purchaseInformation,
            purchaseAccountId: accountNameSets.purchaseAccountIdByName[item.purchaseInformation.purchaseAccountName],
          },
        }),
        ...(item.trackInventory === true && {
          inventoryAccountId: accountNameSets.inventoryAccountIdByName[item.inventoryAccountName],
        }),
        appName: APP_NAME.BOOKS,
        companyId,
        itemGroup: itemGroupMap[item.itemGroup] || null,
        subItemGroup: subItemGroupMap[item.subItemGroup] || null,
        itemGstTax: item?.itemGstTax || null,
        addedBy: userId,
        createdAt: currentDate,
        updatedAt: currentDate,
        updatedBy: userId,
        commentHistory: [
          {
            message: `Item created via bulk import`,
            addedBy: userId,
            createdAt: currentDate,
          },
        ],
      };
    });

    const createdItems = await insertItemsWithAutoNumbering(bulkItems, companyId, session);

    // Every active warehouse of the company gets a default (0) inventory entry on each item.
    const companyWarehouses = await Warehouse.find({ companyId, isActive: true })
      .select('_id branchId divisionId')
      .session(session)
      .lean();

    const defaultWarehouses = companyWarehouses.map(companyWarehouse => ({
      warehouseId: companyWarehouse._id,
      branchId: companyWarehouse.branchId,
      divisionId: companyWarehouse.divisionId,
      isActive: true,
      openingStock: 0,
      openingStockRate: 0,
      availableStock: 0,
      inventoryValue: 0,
    }));

    // Create ItemInventory records only for non-service items.
    const inventoryRecords = createdItems
      .filter(item => item?.itemCategory?.isService !== true)
      .map((item, index) => {
        const currentDate = new Date(baseDate.getTime() + index * 1000);

        return {
          itemId: item._id,
          companyId: item.companyId,
          totalOpeningStock: 0,
          totalAvailableStock: 0,
          inventorySalesMethod: null,
          totalInventoryValue: 0,
          warehouses: defaultWarehouses.map(warehouse => ({ ...warehouse })),
          addedBy: userId,
          createdAt: currentDate,
          updatedAt: currentDate,
          updatedBy: userId,
        };
      });

    if (inventoryRecords.length > 0) {
      await ItemInventory.insertMany(inventoryRecords, { session, timestamps: false });
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return createdItems;
  } catch (error) {
    await session.abortTransaction();
    if (error instanceof ApiError) throw error;
    console.error('Bulk insert failed:', error.message);
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Some items could not be imported. Please check the file and try again.',
    );
  } finally {
    session.endSession();
  }
};

const verifyBulkItemCreation = async reqBody => {
  const { Item, ItemGroup, SubItemGroup } = getBooksCrmModels();
  const { Account } = getBooksModels();
  const { items, companyId } = reqBody;

  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Items array is empty or invalid.');
  }

  items.forEach(item => {
    if (typeof item.itemName === 'string') {
      item.itemName = item.itemName.trim();
    }
    if (typeof item.itemGroup === 'string') {
      item.itemGroup = item.itemGroup.trim();
    }
    if (typeof item.subItemGroup === 'string') {
      item.subItemGroup = item.subItemGroup.trim();
    }
  });

  // ================= DUPLICATE ITEM NAME CHECK (within sheet) =================
  const itemNameCounts = {};
  items.forEach(item => {
    if (!item.itemName) return;
    itemNameCounts[item.itemName] = (itemNameCounts[item.itemName] || 0) + 1;
  });

  const itemNames = [...new Set(items.map(item => item.itemName).filter(Boolean))];
  const itemGroupNames = [...new Set(items.map(item => item.itemGroup).filter(Boolean))];
  const subItemGroupNames = [...new Set(items.map(item => item.subItemGroup).filter(Boolean))];

  const [existingItems, existingItemGroups, existingSubItemGroups, accounts, unitByName] = await Promise.all([
    Item.find({ companyId, itemName: { $in: itemNames } })
      .select('itemName')
      .lean(),
    ItemGroup.find({ companyId, name: { $in: itemGroupNames } })
      .select('name')
      .lean(),
    SubItemGroup.find({ companyId, name: { $in: subItemGroupNames } })
      .select('name')
      .lean(),
    Account.find({ companyId, category: { $in: BULK_ITEM_ACCOUNT_CATEGORIES } })
      .select('accountName category')
      .lean(),
    loadActiveUnitsByName(companyId),
  ]);

  const existingItemNameSet = new Set(existingItems.map(item => item.itemName));
  const existingItemGroupSet = new Set(existingItemGroups.map(group => group.name));
  const existingSubItemGroupSet = new Set(existingSubItemGroups.map(group => group.name));
  const accountNameSets = buildBulkAccountNameSets(accounts);

  const invalidRecords = [];
  const validRecords = [];

  items.forEach((item, index) => {
    const errors = [];
    const itemName = item.itemName;

    if (!itemName) {
      errors.push({ name: 'ITEM_NAME_REQUIRED', message: 'Item name is required.' });
    } else {
      if (itemNameCounts[itemName] > 1) {
        errors.push({
          name: 'DUPLICATE_ITEM_NAME_IN_SHEET',
          message: `Duplicate item name in sheet: ${itemName}`,
        });
      }
      if (existingItemNameSet.has(itemName)) {
        errors.push({ name: 'ITEM_ALREADY_EXISTS', message: `Item already exists: ${itemName}` });
      }
    }

    if (item.itemGroup && !existingItemGroupSet.has(item.itemGroup)) {
      errors.push({ name: 'ITEM_GROUP_NOT_FOUND', message: `Item group does not exist: ${item.itemGroup}` });
    }

    if (item.subItemGroup && !existingSubItemGroupSet.has(item.subItemGroup)) {
      errors.push({
        name: 'SUB_ITEM_GROUP_NOT_FOUND',
        message: `Sub item group does not exist: ${item.subItemGroup}`,
      });
    }

    if (item.itemUnit && !unitByName.has(unitNameKey(item.itemUnit))) {
      errors.push(unitNotFoundError(item.itemUnit));
    }

    errors.push(...validateBulkItemFields(item, accountNameSets));

    if (errors.length > 0) {
      invalidRecords.push({ ...item, errors });
    } else {
      validRecords.push(item);
    }
  });

  return {
    totalRecords: items.length,
    validCount: validRecords.length,
    invalidCount: invalidRecords.length,
    invalidRecords,
    validRecords,
  };
};

const insertItemsWithAutoNumbering = async function (bulkItems, companyId, existingSession = null) {
  const { Item, ModuleSettings } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  // Use existing session if provided, otherwise create new one
  const shouldCreateSession = !existingSession;
  const session = existingSession || (await connection.startSession());

  if (shouldCreateSession) {
    await session.startTransaction();
  }

  try {
    const moduleSettings = await ModuleSettings.findOne({
      companyId,
      moduleName: MODULE_NAMES.ITEM,
    }).session(session);
    if (!moduleSettings) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Module settings not found');
    }
    const prefix = moduleSettings.useCustomPrefix ? moduleSettings.prefix : 'I-';
    let nextSeq = moduleSettings.nextSequence || moduleSettings.startingSequence;

    bulkItems.forEach(item => {
      const itemNo = `${prefix}${nextSeq}`;
      item.itemNo = item.itemNo || itemNo;
      nextSeq = (parseInt(nextSeq) + 1).toString().padStart(moduleSettings.nextSequence.length, '0');
    });
    const inserted = await Item.insertMany(bulkItems, {
      session,
      rawResult: false,
      ordered: true,
      lean: false,
      timestamps: false,
    });
    await ModuleSettings.updateOne({ companyId, moduleName: MODULE_NAMES.ITEM }, { nextSequence: nextSeq }, { session });

    if (shouldCreateSession) {
      await flushCompanyStockLevels(session);
      await session.commitTransaction();
    }

    return inserted;
  } catch (error) {
    if (shouldCreateSession) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    if (shouldCreateSession) {
      session.endSession();
    }
  }
};

/**
 * Query for items
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @returns {Promise<QueryResult>}
 */
const queryItems = async (query, filter, options) => {
  try {
    const { Item, ItemGroup } = getBooksCrmModels();

    if (filter.status === 'ACTIVE') filter.itemStatus = true;
    else if (filter.status === 'INACTIVE') filter.itemStatus = false;
    delete filter.status;

    if (query.search) {
      const searchRegex = new RegExp(escapeRegex(query.search.trim()), 'i');
      const matchingitemGroupIds = await ItemGroup.find({ name: searchRegex }).select('_id');

      filter.$or = [
        { itemName: searchRegex },
        { itemType: searchRegex },
        { itemNo: searchRegex },
        { itemModelNo: searchRegex },
        { hsnCode: searchRegex },
        { description: searchRegex },
        { itemGroup: { $in: matchingitemGroupIds } },
        { gst: searchRegex },
      ];
    }

    if (filter?.category) {
      const category = String(filter.category).trim().toLowerCase();

      if (category === 'goods') {
        filter['itemCategory.isGoods'] = true;
        filter['itemCategory.isService'] = { $ne: true };
      } else if (category === 'service') {
        filter['itemCategory.isService'] = true;
        filter['itemCategory.isGoods'] = { $ne: true };
      }

      delete filter.category;
    }

    if (filter?.itemType) {
      const itemTypes = query.itemType
        .split(',')
        .map(type => type.trim())
        .filter(Boolean);

      if (itemTypes.length > 0) {
        filter.itemType = { $in: itemTypes };
      }
    }

    if (filter?.itemGroup) {
      const itemGroupIds = query.itemGroup
        .split(',')
        .map(type => type.trim())
        .filter(Boolean);

      if (itemGroupIds.length > 0) {
        filter.itemGroup = { $in: itemGroupIds };
      }
    }

    if (filter?.startDate && filter?.endDate) {
      const endDate = new Date(filter.endDate);
      endDate.setHours(23, 59, 59, 999);
      filter.createdAt = {
        $gte: new Date(filter.startDate),
        $lte: endDate,
      };
      delete filter.startDate;
      delete filter.endDate;
    }

    if (filter?.itemDate) {
      filter.createdAt = {
        $gte: new Date(filter.itemDate),
      };
      delete filter.itemDate;
    }

    // Only select fields required by the frontend item list
    options.select =
      options.select ||
      'itemNo itemName itemType itemStatus itemModelNo itemUnit itemUnitId appName hsnCode gst itemGroup subItemGroup description productionData.productionManageMethod salesInformation.sellingPrice purchaseInformation.costPrice';
    options.populate = options.populate || 'itemGroup:name,subItemGroup:name,itemUnitId:name';

    // Get the paginated results
    const result = await Item.paginate(filter, options);

    // Map results directly for the frontend item list and skip heavy population
    const populatedResults = result.results.map(item => {
      const itemObj = item.toObject();
      itemObj.id = itemObj._id;
      return itemObj;
    });

    return {
      ...result,
      results: populatedResults,
    };
  } catch (error) {
    console.error('Error in queryItems:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't load the item list. Please try again.");
  }
};

const queryItemsExports = async (query, filter) => {
  try {
    const { Item, ItemGroup } = getBooksCrmModels();

    if (filter.status === 'ACTIVE') filter.itemStatus = true;
    else if (filter.status === 'INACTIVE') filter.itemStatus = false;
    delete filter.status;

    if (query.search) {
      const searchRegex = new RegExp(escapeRegex(query.search.trim()), 'i');
      const matchingitemGroupIds = await ItemGroup.find({ name: searchRegex }).select('_id');

      filter.$or = [
        { itemName: searchRegex },
        { itemType: searchRegex },
        { itemNo: searchRegex },
        { itemModelNo: searchRegex },
        { hsnCode: searchRegex },
        { description: searchRegex },
        { itemGroup: { $in: matchingitemGroupIds } },
        { gst: searchRegex },
        { appName: searchRegex },
      ];
    }

    if (filter?.category) {
      const category = String(filter.category).trim().toLowerCase();

      if (category === 'goods') {
        filter['itemCategory.isGoods'] = true;
        filter['itemCategory.isService'] = { $ne: true };
      } else if (category === 'service') {
        filter['itemCategory.isService'] = true;
        filter['itemCategory.isGoods'] = { $ne: true };
      }

      delete filter.category;
    }

    if (filter?.itemType) {
      const itemTypes = query.itemType
        .split(',')
        .map(type => type.trim())
        .filter(Boolean);

      if (itemTypes.length > 0) {
        filter.itemType = { $in: itemTypes };
      }
    }

    if (filter?.itemGroup) {
      const itemGroupIds = query.itemGroup
        .split(',')
        .map(type => type.trim())
        .filter(Boolean);

      if (itemGroupIds.length > 0) {
        filter.itemGroup = { $in: itemGroupIds };
      }
    }

    if (filter?.subItemGroup) {
      const subItemGroupIds = query.subItemGroup
        .split(',')
        .map(type => type.trim())
        .filter(Boolean);

      if (subItemGroupIds.length > 0) {
        filter.subItemGroup = { $in: subItemGroupIds };
      }
    }

    if (filter?.startDate && filter?.endDate) {
      const endDate = new Date(filter.endDate);
      endDate.setHours(23, 59, 59, 999);
      filter.createdAt = {
        $gte: new Date(filter.startDate),
        $lte: endDate,
      };
      delete filter.startDate;
      delete filter.endDate;
    }

    if (filter?.itemDate) {
      filter.createdAt = {
        $gte: new Date(filter.itemDate),
      };
      delete filter.itemDate;
    }

    // Get the paginated results
    const items = await Item.find(filter)
      .select(
        'itemNo itemName trackInventory itemCategory purchaseInformation salesInformation itemType itemStatus itemModelNo itemUnit itemUnitId appName hsnCode gst itemGroup subItemGroup inventoryAccountId description productionData.productionManageMethod createdAt',
      )
      .populate('itemGroup', 'name')
      .populate('subItemGroup', 'name')
      .populate('itemUnitId', 'name')
      .sort({ createdAt: -1 });

    const { Account } = getBooksModels();
    const accountIds = [
      ...new Set(
        items
          .flatMap(item => [
            item.salesInformation?.salesAccountId,
            item.purchaseInformation?.purchaseAccountId,
            item.inventoryAccountId,
          ])
          .filter(Boolean)
          .map(String),
      ),
    ];
    const accounts = accountIds.length
      ? await Account.find({ _id: { $in: accountIds } })
          .select('accountName')
          .lean()
      : [];
    const accountNameById = new Map(accounts.map(account => [String(account._id), account.accountName]));

    // Map results directly for the frontend item list and skip heavy population
    const populatedResults = items.map(item => {
      const itemObj = item.toObject();
      return {
        ...itemObj,
        id: item._id,
        salesInformation: itemObj.salesInformation && {
          ...itemObj.salesInformation,
          salesAccountName: accountNameById.get(String(itemObj.salesInformation.salesAccountId)) || null,
        },
        purchaseInformation: itemObj.purchaseInformation && {
          ...itemObj.purchaseInformation,
          purchaseAccountName: accountNameById.get(String(itemObj.purchaseInformation.purchaseAccountId)) || null,
        },
        inventoryAccountName: accountNameById.get(String(itemObj.inventoryAccountId)) || null,
      };
    });

    return populatedResults;
  } catch (error) {
    console.error('Error in queryItems:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't load the item list. Please try again.");
  }
};

/**
 * Get items for dropdown (only itemName and itemNo)
 * @param {Object} filter - Mongo filter
 * @returns {Promise<Array>}
 */
const getItemsForDropdown = async (query, filter, options) => {
  const { Item, ItemInventory, Customer, PriceList } = getBooksCrmModels();

  const warehouseId = filter?.warehouseId ? new mongoose.Types.ObjectId(filter.warehouseId) : null;
  const customerId = filter?.customerId;
  const priceListId = filter?.priceListId;
  const includeZeroInventory = filter?.includeZeroInventory === true || filter?.includeZeroInventory === 'true';
  const includeInactive = filter?.includeInactive === true;

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    filter.$or = [{ itemType: searchRegex }];
  }
  // These filters are Joi booleans, so presence is all that needs checking.
  if (filter.isService !== undefined) {
    filter['itemCategory.isService'] = filter.isService ? true : { $ne: true };
    delete filter.isService;
  }
  // An item awaiting migration has no trackInventory flag and still counts as tracked.
  if (filter.trackInventory !== undefined) {
    filter.trackInventory = filter.trackInventory ? { $ne: false } : false;
  }
  if (filter.isSellable !== undefined) {
    filter['salesInformation.isSellable'] = filter.isSellable;
    delete filter.isSellable;
  }
  if (filter.isPurchasable !== undefined) {
    filter['purchaseInformation.isPurchasable'] = filter.isPurchasable;
    delete filter.isPurchasable;
  }

  filter.itemStatus = true;

  delete filter?.warehouseId;
  delete filter?.customerId;
  delete filter?.priceListId;
  delete filter?.includeZeroInventory;
  delete filter?.includeInactive;

  if (customerId && priceListId) {
    const customer = await Customer.findById(customerId).select('otherDetails.includePriceListItemOnly').lean();
    if (customer?.otherDetails?.includePriceListItemOnly) {
      const priceList = await PriceList.findById(priceListId).select('items.itemId').lean();
      filter._id = { $in: (priceList?.items || []).map(i => i.itemId) };
    }
  }

  const items = await Item.find(filter)
    .select(
      'itemName itemNo itemGroup gst hsnCode itemType purchasingData.timeBatchNumberMandatory purchasingData.punchingTimeBatchNumberMandatory salesInformation purchaseInformation isActive itemUnit itemUnitId unitConversions stockInUnit stockOutUnit itemCategory trackInventory productionData.productionManageMethod productionData.bomBased.item productionData.selectProcessRecipe',
    )
    .populate('itemUnitId', 'name')
    .populate('stockInUnit', 'name')
    .populate('stockOutUnit', 'name')
    .populate('unitConversions.itemUnitId', 'name')
    .populate('itemGroup', 'name itemGroupId')
    .lean();

  if (items.length === 0) {
    return [];
  }

  const itemIds = items.map(item => item._id);
  const inventoryQuery = { itemId: { $in: itemIds } };
  if (filter.companyId) {
    inventoryQuery.companyId = filter.companyId;
  }
  const inventories = await ItemInventory.find(inventoryQuery).select('itemId warehouses').lean();

  const inventoryByItemId = new Map();
  inventories.forEach(inv => inventoryByItemId.set(inv.itemId.toString(), inv));

  return items
    .map(item => {
      const inventory = inventoryByItemId.get(item._id.toString());
      const warehouses = includeInactive
        ? inventory?.warehouses || []
        : (inventory?.warehouses || []).filter(b => b.isActive !== false);
      const isServiceItem = item?.itemCategory?.isService === true;
      const carriesNoStock = isServiceItem || item?.trackInventory === false;
      let availableStock = 0;
      if (warehouseId) {
        const branch = warehouses.find(b => b.warehouseId?.toString() === warehouseId.toString());
        if (!branch) {
          // Service items and items that don't track inventory carry no stock, and back-order-only
          // items stay sellable even without stock in the selected warehouse — never exclude any of them.
          if (!carriesNoStock && !includeZeroInventory) {
            return null;
          }
          availableStock = 0;
        } else {
          availableStock = branch.availableStock ?? 0;
        }
      } else {
        availableStock = warehouses.reduce((sum, b) => sum + (b.availableStock || 0), 0);
      }
      return {
        ...item,
        availableStock,
        convertedStockDetails: getConvertedStockDetails(item.unitConversions, { availableStock }),
        isProductionDataAdded: isProductionDataComplete(item.productionData),
      };
    })
    .filter(Boolean);
};

/**
 * Get inventory status for items
 * @param {Object} filter - Filter criteria
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Inventory status data
 */
const getInventoryListOptimized = async (query, filter, options) => {
  const { Item, ItemInventory } = getBooksCrmModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const includeZero = query.includeZeroInventory === true || query.includeZeroInventory === 'true';
  const toIds = v =>
    v
      ? v
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id))
      : null;
  const divisionFilter = toIds(query.divisionId);
  const branchFilter = toIds(query.branchId);
  const warehouseFilter = toIds(query.warehouseId);
  const hasWh = Boolean(divisionFilter || branchFilter || warehouseFilter);

  const page = parseInt(options.page, 10) || 1;
  const limit = parseInt(options.limit, 10) || 10;
  const skip = (page - 1) * limit;
  const empty = {
    results: [],
    page,
    limit,
    totalPages: 0,
    totalResults: 0,
    totalStock: 0,
    totalValuation: 0,
    stockStatusCounts: { inRange: 0, belowMinimum: 0, aboveMaximum: 0, noRange: 0 },
  };

  const requestedItemIds = toIds(query.itemIds);
  const hasItemFilter = Boolean(
    query.search ||
    query.itemType ||
    query.itemGroup ||
    requestedItemIds ||
    filter.itemStatus !== undefined ||
    filter.isActive !== undefined,
  );
  let itemIds = null;
  if (hasItemFilter) {
    const im = { companyId, 'itemCategory.isService': { $ne: true } };
    if (filter.itemStatus !== undefined) im.itemStatus = filter.itemStatus;
    if (filter.isActive !== undefined) im.isActive = filter.isActive;
    if (requestedItemIds) im._id = { $in: requestedItemIds };
    if (query.itemType) im.itemType = { $in: query.itemType.split(',').filter(Boolean) };
    if (query.itemGroup) im.itemGroup = { $in: toIds(query.itemGroup) };
    if (query.search) {
      const rx = new RegExp(escapeRegex(query.search.trim()), 'i');
      im.$or = [{ itemName: rx }, { itemType: rx }, { itemNo: rx }, { itemModelNo: rx }];
    }
    itemIds = (await Item.find(im).select('_id').lean()).map(i => i._id);
    if (!itemIds.length) return empty;
  }

  const filteredWh = {
    $filter: {
      input: { $ifNull: ['$warehouses', []] },
      as: 'w',
      cond: {
        $and: [
          ...(divisionFilter ? [{ $in: ['$$w.divisionId', divisionFilter] }] : []),
          ...(branchFilter ? [{ $in: ['$$w.branchId', branchFilter] }] : []),
          ...(warehouseFilter ? [{ $in: ['$$w.warehouseId', warehouseFilter] }] : []),
        ],
      },
    },
  };
  const sumWh = f => ({ $sum: { $map: { input: filteredWh, as: 'w', in: { $ifNull: [`$$w.${f}`, 0] } } } });
  const effStock = hasWh ? sumWh('availableStock') : { $ifNull: ['$totalAvailableStock', 0] };
  const effValue = hasWh ? sumWh('inventoryValue') : { $ifNull: ['$totalInventoryValue', 0] };

  const minLevel = { $ifNull: ['$minimumStockLevel', 0] };
  const maxLevel = { $ifNull: ['$maximumStockLevel', 0] };
  const stockStatusExpr = {
    $switch: {
      branches: [
        { case: { $and: [{ $eq: [minLevel, 0] }, { $eq: [maxLevel, 0] }] }, then: STOCK_STATUS.NO_RANGE },
        { case: { $and: [{ $gt: [minLevel, 0] }, { $lt: ['$effStock', minLevel] }] }, then: STOCK_STATUS.BELOW_MINIMUM },
        { case: { $and: [{ $gt: [maxLevel, 0] }, { $gt: ['$effStock', maxLevel] }] }, then: STOCK_STATUS.ABOVE_MAXIMUM },
      ],
      default: STOCK_STATUS.NORMAL,
    },
  };
  const stockStatusFilter = query.stockStatus
    ? query.stockStatus
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : null;
  const stockStatusMatch = stockStatusFilter ? [{ $match: { stockStatus: { $in: stockStatusFilter } } }] : [];

  const invMatch = { companyId };
  if (itemIds) invMatch.itemId = { $in: itemIds };

  const [facet = {}] = await ItemInventory.aggregate([
    { $match: invMatch },
    { $addFields: { effStock, effValue } },
    ...(!includeZero ? [{ $match: { effStock: { $gt: 0 } } }] : []),
    { $addFields: { stockStatus: stockStatusExpr } },
    {
      $facet: {
        statusCounts: [{ $group: { _id: '$stockStatus', count: { $sum: 1 } } }],
        meta: [
          ...stockStatusMatch,
          {
            $group: {
              _id: null,
              totalResults: { $sum: 1 },
              totalStock: { $sum: '$effStock' },
              totalValuation: { $sum: '$effValue' },
            },
          },
        ],
        results: [
          ...stockStatusMatch,
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: 'items',
              localField: 'itemId',
              foreignField: '_id',
              as: 'item',
              pipeline: [
                {
                  $project: {
                    itemNo: 1,
                    itemName: 1,
                    itemType: 1,
                    itemModelNo: 1,
                    itemStatus: 1,
                    itemGroup: 1,
                    itemUnitId: 1,
                    unitConversions: 1,
                  },
                },
              ],
            },
          },
          { $unwind: '$item' },
          {
            $lookup: {
              from: 'itemgroups',
              localField: 'item.itemGroup',
              foreignField: '_id',
              as: 'grp',
              pipeline: [{ $project: { name: 1, groupCode: 1 } }],
            },
          },
          { $unwind: { path: '$grp', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'itembatches',
              let: { itemId: '$itemId', cid: companyId },
              pipeline: [
                { $match: { $expr: { $and: [{ $eq: ['$itemId', '$$itemId'] }, { $eq: ['$companyId', '$$cid'] }] } } },
                { $sort: { createdAt: -1 } },
                { $limit: 1 },
                { $project: { purchasePrice: 1 } },
              ],
              as: 'latestBatch',
            },
          },
          {
            $project: {
              _id: '$item._id',
              itemNo: '$item.itemNo',
              itemName: '$item.itemName',
              itemType: '$item.itemType',
              itemModelNo: '$item.itemModelNo',
              itemStatus: '$item.itemStatus',
              itemUnitId: '$item.itemUnitId',
              unitConversions: '$item.unitConversions',
              itemGroup: { _id: '$item.itemGroup', name: '$grp.name', code: '$grp.groupCode' },
              totalOpeningStock: { $ifNull: ['$totalOpeningStock', 0] },
              totalAvailableStock: '$effStock',
              totalValuation: '$effValue',
              minimumStockLevel: { $ifNull: ['$minimumStockLevel', 0] },
              maximumStockLevel: { $ifNull: ['$maximumStockLevel', 0] },
              stockStatus: 1,
              latestPrice: { $ifNull: [{ $arrayElemAt: ['$latestBatch.purchasePrice', 0] }, null] },
              addedBy: 1,
              updatedBy: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ],
      },
    },
  ]);

  const meta = facet.meta?.[0] || { totalResults: 0, totalStock: 0, totalValuation: 0 };
  const rows = facet.results || [];
  await Item.populate(rows, [
    { path: 'itemUnitId', select: 'name' },
    { path: 'unitConversions.itemUnitId', select: 'name' },
  ]);

  const stockStatusCounts = { inRange: 0, belowMinimum: 0, aboveMaximum: 0, noRange: 0 };
  (facet.statusCounts || []).forEach(s => {
    if (s._id === STOCK_STATUS.BELOW_MINIMUM) stockStatusCounts.belowMinimum = s.count;
    else if (s._id === STOCK_STATUS.ABOVE_MAXIMUM) stockStatusCounts.aboveMaximum = s.count;
    else if (s._id === STOCK_STATUS.NO_RANGE) stockStatusCounts.noRange = s.count;
    else stockStatusCounts.inRange += s.count;
  });

  const { User } = getCommonModels();
  const userIds = [
    ...new Set([
      ...rows.map(r => r.addedBy?.toString()).filter(Boolean),
      ...rows.map(r => r.updatedBy?.toString()).filter(Boolean),
    ]),
  ];
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select('firstName lastName')
        .lean()
    : [];
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  const results = rows.map(({ unitConversions, ...r }) => ({
    ...r,
    convertedStockDetails: getConvertedStockDetails(unitConversions, {
      totalOpeningStock: r.totalOpeningStock,
      totalAvailableStock: r.totalAvailableStock,
    }),
    addedBy: r.addedBy ? userMap.get(r.addedBy.toString()) || null : null,
    updatedBy: r.updatedBy ? userMap.get(r.updatedBy.toString()) || null : null,
  }));

  return {
    results,
    page,
    limit,
    totalPages: Math.ceil(meta.totalResults / limit),
    totalResults: meta.totalResults,
    totalStock: meta.totalStock,
    totalValuation: meta.totalValuation,
    stockStatusCounts,
  };
};

const getItemInventoryStatus = async (query, filter, options) => {
  const { Item } = getBooksCrmModels();
  const { companyId, itemId, itemStatus } = filter;
  const includeZeroInventory = query.includeZeroInventory;

  if (!itemId) {
    return getInventoryListOptimized(query, filter, options);
  }
  const matchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    'itemCategory.isService': { $ne: true },
  };

  if (itemId) {
    matchFilter._id = new mongoose.Types.ObjectId(itemId);
  }

  if (itemStatus !== undefined) {
    matchFilter.itemStatus = itemStatus;
  }

  if (query.search) {
    const searchRegex = new RegExp(escapeRegex(query.search.trim()), 'i');

    matchFilter.$or = [
      { itemName: searchRegex },
      { itemType: searchRegex },
      { itemNo: searchRegex },
      { itemModelNo: searchRegex },
    ];
  }
  if (query.itemType) {
    const itemTypes = query.itemType.split(',').filter(Boolean);
    if (itemTypes.length > 0) {
      matchFilter.itemType = { $in: itemTypes };
    }
  }
  if (query.itemGroup) {
    const itemGroups = query.itemGroup.split(',').filter(Boolean);
    if (itemGroups.length > 0) {
      matchFilter.itemGroup = { $in: itemGroups.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (filter.isActive !== undefined) {
    matchFilter.isActive = filter.isActive;
  }

  // Store filter values for later use in stockDetails filtering
  let warehouseFilter = null;
  let branchFilter = null;
  let divisionFilter = null;

  if (query.warehouseId) {
    const warehouseIds = query.warehouseId.split(',').filter(Boolean);
    if (warehouseIds.length > 0) {
      warehouseFilter = warehouseIds.map(id => new mongoose.Types.ObjectId(id));
    }
  }

  if (query.branchId) {
    const branchIds = query.branchId.split(',').filter(Boolean);
    if (branchIds.length > 0) {
      branchFilter = branchIds.map(id => new mongoose.Types.ObjectId(id));
    }
  }

  if (query.divisionId) {
    const divisionIds = query.divisionId.split(',').filter(Boolean);
    if (divisionIds.length > 0) {
      divisionFilter = divisionIds.map(id => new mongoose.Types.ObjectId(id));
    }
  }
  const pipeline = [
    {
      $match: matchFilter,
    },
    // Add filter variables to the pipeline
    {
      $addFields: {
        warehouseFilter: warehouseFilter,
        branchFilter: branchFilter,
        divisionFilter: divisionFilter,
        companyIdFilter: new mongoose.Types.ObjectId(companyId),
      },
    },
    // Lookup item group
    {
      $lookup: {
        from: 'itemgroups',
        localField: 'itemGroup',
        foreignField: '_id',
        as: 'itemGroupInfo',
      },
    },
    {
      $unwind: {
        path: '$itemGroupInfo',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: 'iteminventories',
        localField: '_id',
        foreignField: 'itemId',
        as: 'inventoryData',
        pipeline: [
          // unwind warehouses
          {
            $unwind: {
              path: '$warehouses',
              preserveNullAndEmptyArrays: true,
            },
          },

          // warehouse lookup
          {
            $lookup: {
              from: 'warehouses',
              let: { warehouseId: '$warehouses.warehouseId' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$warehouseId'] } } },
                { $project: { _id: 1, name: 1, warehouseId: 1 } },
              ],
              as: 'warehouse',
            },
          },
          { $unwind: { path: '$warehouse', preserveNullAndEmptyArrays: true } },

          // branch lookup
          {
            $lookup: {
              from: 'branches',
              let: { branchId: '$warehouses.branchId' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$branchId'] } } },
                { $project: { _id: 1, name: 1, branchCode: 1 } },
              ],
              as: 'branch',
            },
          },
          { $unwind: { path: '$branch', preserveNullAndEmptyArrays: true } },

          // division lookup
          {
            $lookup: {
              from: 'divisions',
              let: { divisionId: '$warehouses.divisionId' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$divisionId'] } } },
                { $project: { _id: 1, name: 1, divisionCode: 1 } },
              ],
              as: 'division',
            },
          },
          { $unwind: { path: '$division', preserveNullAndEmptyArrays: true } },

          // rebuild warehouse object
          {
            $addFields: {
              'warehouses.warehouse': '$warehouse',
              'warehouses.branch': '$branch',
              'warehouses.division': '$division',
            },
          },

          // cleanup temp fields
          {
            $project: {
              warehouse: 0,
              branch: 0,
              division: 0,
            },
          },

          // group warehouses back
          {
            $group: {
              _id: '$_id',
              itemId: { $first: '$itemId' },
              companyId: { $first: '$companyId' },
              totalOpeningStock: { $first: '$totalOpeningStock' },
              totalAvailableStock: { $first: '$totalAvailableStock' },
              inventorySalesMethod: { $first: '$inventorySalesMethod' },
              totalInventoryValue: { $first: '$totalInventoryValue' },
              minimumStockLevel: { $first: '$minimumStockLevel' },
              maximumStockLevel: { $first: '$maximumStockLevel' },
              warehouses: {
                $push: {
                  $cond: [
                    {
                      $or: [
                        { $ne: ['$warehouses.warehouseId', null] },
                        { $ne: ['$warehouses.branchId', null] },
                        { $ne: ['$warehouses.divisionId', null] },
                      ],
                    },
                    '$warehouses',
                    '$$REMOVE',
                  ],
                },
              },
            },
          },
        ],
      },
    },
    {
      $unwind: {
        path: '$inventoryData',
        preserveNullAndEmptyArrays: true,
      },
    },
    // Project the final result
    {
      $project: {
        _id: 1,
        itemNo: 1,
        itemName: 1,
        itemType: 1,
        itemModelNo: 1,
        hsnCode: 1,
        gst: 1,
        itemStatus: 1,
        itemGroup: {
          _id: '$itemGroupInfo._id',
          name: '$itemGroupInfo.name',
          code: '$itemGroupInfo.groupCode',
        },
        totalOpeningStock: { $ifNull: ['$inventoryData.totalOpeningStock', 0] },
        totalAvailableStock: { $ifNull: ['$inventoryData.totalAvailableStock', 0] },
        minimumStockLevel: { $ifNull: ['$inventoryData.minimumStockLevel', 0] },
        maximumStockLevel: { $ifNull: ['$inventoryData.maximumStockLevel', 0] },
        createdAt: 1,
        itemUnitId: 1,
        unitConversions: 1,
        itemInventory: itemId
          ? '$inventoryData'
          : {
              _id: '$inventoryData._id',
              totalOpeningStock: { $ifNull: ['$inventoryData.totalOpeningStock', 0] },
              totalAvailableStock: { $ifNull: ['$inventoryData.totalAvailableStock', 0] },
              totalInventoryValue: { $ifNull: ['$inventoryData.totalInventoryValue', 0] },
              minimumStockLevel: { $ifNull: ['$inventoryData.minimumStockLevel', 0] },
              maximumStockLevel: { $ifNull: ['$inventoryData.maximumStockLevel', 0] },
            },
      },
    },
    ...(!includeZeroInventory ? [{ $match: { totalAvailableStock: { $gt: 0 } } }] : []),
    // Sort by item number
    {
      $sort: { createdAt: -1 },
    },
  ];
  const page = parseInt(options.page, 10) || 1;
  const limit = parseInt(options.limit, 10) || 10;
  const skip = (page - 1) * limit;

  pipeline.push({ $skip: skip }, { $limit: limit });
  const items = await Item.aggregate(pipeline);
  await Item.populate(items, [
    { path: 'itemUnitId', select: 'name' },
    { path: 'unitConversions.itemUnitId', select: 'name' },
  ]);

  // Single-item path: the page is the whole match, so derive count/totals here.
  const keepWarehouse = warehouse => {
    if (!warehouse || Object.keys(warehouse).length === 0) return false;
    if (
      divisionFilter?.length &&
      warehouse.divisionId &&
      !divisionFilter.some(d => d.toString() === warehouse.divisionId.toString())
    )
      return false;
    if (branchFilter?.length && warehouse.branchId && !branchFilter.some(b => b.toString() === warehouse.branchId.toString()))
      return false;
    if (
      warehouseFilter?.length &&
      warehouse.warehouseId &&
      !warehouseFilter.some(w => w.toString() === warehouse.warehouseId.toString())
    )
      return false;
    return true;
  };

  let totalStock = 0;
  let totalValuation = 0;
  const itemsWithValuation = items.map(({ unitConversions, ...item }) => {
    if (!item.itemInventory) return item;
    const filteredWarehouses = (item.itemInventory.warehouses || []).filter(keepWarehouse).map(w => ({
      ...w,
      convertedStockDetails: getConvertedStockDetails(unitConversions, {
        availableStock: w.availableStock,
        openingStock: w.openingStock,
      }),
    }));
    const stock = filteredWarehouses.reduce((sum, w) => sum + (w.availableStock || 0), 0);
    const valuation = filteredWarehouses.reduce((sum, w) => sum + (w.inventoryValue || 0), 0);
    totalStock += stock;
    totalValuation += valuation;
    return {
      ...item,
      stock,
      valuation,
      convertedStockDetails: getConvertedStockDetails(unitConversions, {
        totalOpeningStock: item.totalOpeningStock,
        totalAvailableStock: item.totalAvailableStock,
        stock,
      }),
      itemInventory: {
        ...item.itemInventory,
        warehouses: filteredWarehouses,
        totalInventoryValue: valuation,
        convertedStockDetails: getConvertedStockDetails(unitConversions, {
          totalOpeningStock: item.itemInventory.totalOpeningStock,
          totalAvailableStock: item.itemInventory.totalAvailableStock,
        }),
      },
    };
  });
  const totalCount = itemsWithValuation.length;

  // Format the response
  const result = {
    results: itemsWithValuation,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
    totalResults: totalCount,
    totalStock: totalStock,
    totalValuation: totalValuation,
  };

  return result;
};

const ITEM_BATCH_POPULATE = [
  { path: 'divisionId', select: 'name divisionCode' },
  { path: 'branchId', select: 'name branchCode' },
  { path: 'warehouseId', select: 'name warehouseId' },
  { path: 'itemUnitId', select: 'name' },
  { path: 'purchaseUnitId', select: 'name' },
  { path: 'deductions.sellingUnitId', select: 'name' },
];

const ITEM_BATCH_DETAILS_POPULATE = [...ITEM_BATCH_POPULATE, { path: 'itemId', select: 'itemName itemNo itemUnitId' }];

const getConvertedStockDetails = (unitConversions, stocks) =>
  (unitConversions || [])
    .filter(conversion => conversion.baseQty > 0)
    .map(conversion => ({
      itemUnitId: conversion.itemUnitId?._id || conversion.itemUnitId,
      unitName: conversion.itemUnitId?.name || null,
      ...Object.fromEntries(
        Object.entries(stocks).map(([field, value]) => [field, roundQty(((value || 0) * conversion.qty) / conversion.baseQty)]),
      ),
    }));

const getItemUnitConversions = async (itemId, companyId) => {
  const { Item } = getBooksCrmModels();
  const item = await Item.findOne({ _id: itemId, companyId })
    .select('unitConversions')
    .populate({ path: 'unitConversions.itemUnitId', select: 'name' })
    .lean();
  return item?.unitConversions || [];
};

const enrichBatchesWithDocNo = async rawBatches => {
  const {
    Invoice,
    DeliveryChallan,
    DebitNote,
    ProductionOrder,
    InventoryTransferRequest,
    InventoryAdjustment,
    GrpoOrder,
    Bill,
    CreditNote,
    RejectionOrder,
  } = getBooksModels();

  const DEDUCTION_SOURCE_ID_FIELD_MAP = {
    [MODULE_NAMES.INVOICE]: 'invoiceId',
    [MODULE_NAMES.DELIVERY_CHALLAN]: 'deliveryChallanId',
    [MODULE_NAMES.DEBIT_NOTE]: 'debitNoteId',
    [MODULE_NAMES.SPLIT_DEBIT_NOTE]: 'splitDebitNoteId',
    PRODUCTION_ORDER: 'productionOrderId',
    MANUAL_STOCK_TRANSFER: 'manualStockTransferId',
    PRODUCTIONORDER_STOCK_TRANSFER: 'productionOrderStockTransferId',
    [ITEM_BATCH_SOURCE_TYPE.DELIVERY_CHALLAN_STOCK_TRANSFER]: 'deliveryChallanId',
    INVENTORY_ADJUSTMENT: 'inventoryAdjustmentId',
    [MODULE_NAMES.SPLIT_INVOICE]: 'splitInvoiceId',
  };

  const DEDUCTION_DOC_NO_SOURCE_MAP = {
    [MODULE_NAMES.INVOICE]: { model: Invoice, field: 'invoiceId' },
    [MODULE_NAMES.DELIVERY_CHALLAN]: { model: DeliveryChallan, field: 'challanId' },
    [MODULE_NAMES.DEBIT_NOTE]: { model: DebitNote, field: 'debitNoteId' },
    [MODULE_NAMES.SPLIT_DEBIT_NOTE]: { model: DebitNote, field: 'debitNoteId' },
    PRODUCTION_ORDER: { model: ProductionOrder, field: 'productionOrderCode' },
    MANUAL_STOCK_TRANSFER: { model: InventoryTransferRequest, field: 'transferId' },
    PRODUCTIONORDER_STOCK_TRANSFER: { model: InventoryTransferRequest, field: 'transferId' },
    [ITEM_BATCH_SOURCE_TYPE.DELIVERY_CHALLAN_STOCK_TRANSFER]: { model: DeliveryChallan, field: 'challanId' },
    INVENTORY_ADJUSTMENT: { model: InventoryAdjustment, field: 'inventoryAdjustmentNumber' },
    [MODULE_NAMES.SPLIT_INVOICE]: { model: Invoice, field: 'invoiceId' },
  };

  const SOURCE_DOC_NO_MAP = {
    [MODULE_NAMES.GRPO]: { model: GrpoOrder, field: 'grpoOrderId' },
    [MODULE_NAMES.BILL]: { model: Bill, field: 'billId' },
    [MODULE_NAMES.SPLIT_BILL]: { model: Bill, field: 'billId' },
    [MODULE_NAMES.CREDIT_NOTE]: { model: CreditNote, field: 'creditNoteId' },
    [MODULE_NAMES.SPLIT_CREDIT_NOTE]: { model: CreditNote, field: 'creditNoteId' },
    PRODUCTION_ORDER: { model: ProductionOrder, field: 'productionOrderCode' },
    MANUAL_STOCK_TRANSFER: { model: InventoryTransferRequest, field: 'transferId' },
    PRODUCTIONORDER_STOCK_TRANSFER: { model: InventoryTransferRequest, field: 'transferId' },
    [ITEM_BATCH_SOURCE_TYPE.DELIVERY_CHALLAN_STOCK_TRANSFER]: { model: DeliveryChallan, field: 'challanId' },
    INVENTORY_ADJUSTMENT: { model: InventoryAdjustment, field: 'inventoryAdjustmentNumber' },
    REJECTION_RECOVERY: { model: RejectionOrder, field: 'rejectionOrderId' },
  };

  const sourceIdsByType = new Map();
  for (const batch of rawBatches) {
    const config = SOURCE_DOC_NO_MAP[batch.sourceType];
    if (!config || !batch.sourceId) continue;
    if (!sourceIdsByType.has(batch.sourceType)) {
      sourceIdsByType.set(batch.sourceType, new Set());
    }
    sourceIdsByType.get(batch.sourceType).add(batch.sourceId.toString());
  }

  const sourceDocNoMapsByType = new Map();
  await Promise.all(
    [...sourceIdsByType.entries()].map(async ([sourceType, idSet]) => {
      const { model, field } = SOURCE_DOC_NO_MAP[sourceType];
      const docs = await model
        .find({ _id: { $in: [...idSet] } })
        .select(field)
        .lean();
      sourceDocNoMapsByType.set(sourceType, new Map(docs.map(doc => [doc._id.toString(), doc[field]])));
    }),
  );

  const deductedIdsByType = new Map();
  for (const batch of rawBatches) {
    for (const deduction of batch.deductions || []) {
      const config = DEDUCTION_DOC_NO_SOURCE_MAP[deduction.deductedSourceType];
      if (!config || !deduction.deductedSourceId) continue;
      if (!deductedIdsByType.has(deduction.deductedSourceType)) {
        deductedIdsByType.set(deduction.deductedSourceType, new Set());
      }
      deductedIdsByType.get(deduction.deductedSourceType).add(deduction.deductedSourceId.toString());
    }
  }

  const docNoMapsByType = new Map();
  await Promise.all(
    [...deductedIdsByType.entries()].map(async ([sourceType, idSet]) => {
      const { model, field } = DEDUCTION_DOC_NO_SOURCE_MAP[sourceType];
      const docs = await model
        .find({ _id: { $in: [...idSet] } })
        .select(field)
        .lean();
      docNoMapsByType.set(sourceType, new Map(docs.map(doc => [doc._id.toString(), doc[field]])));
    }),
  );

  return rawBatches.map(batch => ({
    ...batch,
    docNo: batch.sourceId ? (sourceDocNoMapsByType.get(batch.sourceType)?.get(batch.sourceId.toString()) ?? null) : null,
    deductions: (batch.deductions || []).map(deduction => {
      const idFieldName = DEDUCTION_SOURCE_ID_FIELD_MAP[deduction.deductedSourceType];
      const docNo = deduction.deductedSourceId
        ? (docNoMapsByType.get(deduction.deductedSourceType)?.get(deduction.deductedSourceId.toString()) ?? null)
        : null;
      return {
        ...deduction,
        ...(idFieldName ? { [idFieldName]: deduction.deductedSourceId } : {}),
        docNo,
      };
    }),
  }));
};

const populateAuditUsers = async batch => {
  const { User } = getCommonModels();
  const userIds = new Set();

  if (batch?.addedBy && !(typeof batch.addedBy === 'object' && batch.addedBy.firstName !== undefined)) {
    userIds.add(batch.addedBy.toString());
  }

  // updatedBy is scalar ObjectId on ItemBatch; keep array fallback for any legacy docs
  const updatedByRaw = batch?.updatedBy;
  let updatedByIdStr = null;
  if (updatedByRaw) {
    if (Array.isArray(updatedByRaw)) {
      const last = updatedByRaw[updatedByRaw.length - 1];
      updatedByIdStr = last?.userId?.toString() ?? null;
    } else if (!(typeof updatedByRaw === 'object' && updatedByRaw.firstName !== undefined)) {
      updatedByIdStr = updatedByRaw.toString();
    }
  }
  if (updatedByIdStr) userIds.add(updatedByIdStr);

  const users = userIds.size
    ? await User.find({ _id: { $in: [...userIds] } })
        .select('firstName lastName')
        .lean()
    : [];
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  let addedBy = batch?.addedBy || null;
  if (addedBy && !(typeof addedBy === 'object' && addedBy.firstName !== undefined)) {
    addedBy = userMap.get(addedBy.toString()) || null;
  } else if (!addedBy) {
    addedBy = null;
  }

  const updatedBy = updatedByIdStr ? userMap.get(updatedByIdStr) || null : null;
  const updatedAt = batch.updatedAt || null;

  return { ...batch, addedBy, updatedBy, updatedAt };
};

const buildItemBatchDetails = async (rawBatch, companyId, options = {}) => {
  const itemId = rawBatch.itemId?._id || rawBatch.itemId;
  const [[enriched], unitConversions] = await Promise.all([
    enrichBatchesWithDocNo([rawBatch]),
    options.unitConversions ? Promise.resolve(options.unitConversions) : getItemUnitConversions(itemId, companyId),
  ]);

  let batch = enriched;
  if (options.includeAuditUsers || options.includeAddedBy) {
    batch = await populateAuditUsers(batch);
  }

  const item = batch.itemId && typeof batch.itemId === 'object' ? batch.itemId : null;

  return {
    ...batch,
    itemName: item?.itemName || batch.itemName || '',
    itemNo: item?.itemNo || batch.itemNo || '',
    branchName: batch.branchId?.name || batch.branchName || '',
    divisionName: batch.divisionId?.name || batch.divisionName || '',
    warehouseName: batch.warehouseId?.name || batch.warehouseName || '',
    convertedStockDetails: getConvertedStockDetails(unitConversions, {
      quantity: batch.quantity,
      remainingQty: batch.remainingQty,
    }),
  };
};

const getItemInventoryDetails = async (itemId, companyId) => {
  const { Item, ItemInventory, Division, Branch, Warehouse } = getBooksCrmModels();
  const { User } = getCommonModels();

  const itemObjectId = new mongoose.Types.ObjectId(itemId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const item = await Item.findOne({ _id: itemObjectId, companyId: companyObjectId })
    .populate({ path: 'itemGroup', select: 'name code' })
    .populate({ path: 'itemUnitId', select: 'name' })
    .populate({ path: 'unitConversions.itemUnitId', select: 'name' })
    .select('itemNo itemName itemType itemModelNo itemGroup itemUnit itemUnitId unitConversions itemStatus')
    .lean();

  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const itemInventory = await ItemInventory.findOne({ itemId: itemObjectId, companyId: companyObjectId }).lean();

  if (!itemInventory) {
    return {
      item,
      itemInventory: {
        totalOpeningStock: 0,
        totalAvailableStock: 0,
        inventorySalesMethod: null,
        totalInventoryValue: 0,
        warehouses: [],
      },
    };
  }

  const divisionIds = [...new Set((itemInventory.warehouses || []).map(w => w.divisionId).filter(Boolean))];
  const branchIds = [...new Set((itemInventory.warehouses || []).map(w => w.branchId).filter(Boolean))];
  const warehouseIds = [...new Set((itemInventory.warehouses || []).map(w => w.warehouseId).filter(Boolean))];

  const [divisions, branches, warehouses] = await Promise.all([
    Division.find({ _id: { $in: divisionIds } })
      .select('name divisionCode')
      .lean(),
    Branch.find({ _id: { $in: branchIds } })
      .select('name branchCode')
      .lean(),
    Warehouse.find({ _id: { $in: warehouseIds } })
      .select('name warehouseId')
      .lean(),
  ]);

  const divisionMap = new Map(divisions.map(d => [d._id.toString(), d]));
  const branchMap = new Map(branches.map(b => [b._id.toString(), b]));
  const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w]));

  const warehousesWithPopulated = (itemInventory.warehouses || []).map(wh => ({
    ...wh,
    convertedStockDetails: getConvertedStockDetails(item.unitConversions, {
      availableStock: wh.availableStock,
      openingStock: wh.openingStock,
    }),
    division: divisionMap.get(wh.divisionId?.toString()) || null,
    branch: branchMap.get(wh.branchId?.toString()) || null,
    warehouse: warehouseMap.get(wh.warehouseId?.toString()) || null,
  }));

  const userIds = [itemInventory.addedBy?.toString(), itemInventory.updatedBy?.toString()].filter(Boolean);
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select('firstName lastName')
        .lean()
    : [];
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  return {
    item,
    itemInventory: {
      ...itemInventory,
      warehouses: warehousesWithPopulated,
      addedBy: itemInventory.addedBy ? userMap.get(itemInventory.addedBy.toString()) || null : null,
      updatedBy: itemInventory.updatedBy ? userMap.get(itemInventory.updatedBy.toString()) || null : null,
    },
  };
};

/**
 * Get a paginated page of ItemBatch records for an item, newest-first by default.
 * @param {ObjectId} itemId - Item ID
 * @param {ObjectId} companyId - Company ID
 * @param {Object} [options] - { sortBy, limit, page, pagination }
 * @returns {Promise<{results: Array, page?: number, limit?: number, totalPages?: number, totalResults: number}>}
 */
const getItemInventoryBatches = async (itemId, companyId, options = {}) => {
  const { ItemBatch } = getBooksCrmModels();
  const itemObjectId = new mongoose.Types.ObjectId(itemId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const filter = { itemId: itemObjectId, companyId: companyObjectId };

  let sort = '-createdAt';
  if (typeof options.sortBy === 'string' && options.sortBy.trim() !== '') {
    sort = options.sortBy
      .split(',')
      .map(opt => {
        const [key, order] = opt.split(':');
        return (order === 'desc' ? '-' : '') + key;
      })
      .join(' ');
  }

  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;
  const paginationEnabled = options.pagination !== false;

  let query = ItemBatch.find(filter).populate(ITEM_BATCH_POPULATE).sort(sort);
  if (paginationEnabled) {
    query = query.skip(skip).limit(limit);
  }

  const [totalResults, rawBatches, unitConversions] = await Promise.all([
    ItemBatch.countDocuments(filter),
    query.lean(),
    getItemUnitConversions(itemObjectId, companyObjectId),
  ]);

  const results = (await enrichBatchesWithDocNo(rawBatches)).map(batch => ({
    ...batch,
    convertedStockDetails: getConvertedStockDetails(unitConversions, {
      quantity: batch.quantity,
      remainingQty: batch.remainingQty,
    }),
  }));

  const result = { results, totalResults };
  if (paginationEnabled) {
    Object.assign(result, { page, limit, totalPages: Math.ceil(totalResults / limit) });
  }
  return result;
};

const getItemInventoryBatchById = async (itemId, batchId, companyId) => {
  const { ItemBatch } = getBooksCrmModels();

  const rawBatch = await ItemBatch.findOne({ _id: batchId, itemId, companyId }).populate(ITEM_BATCH_DETAILS_POPULATE).lean();
  if (!rawBatch) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.INVENTORY_BATCH_NOT_FOUND);
  }

  return buildItemBatchDetails(rawBatch, companyId, { includeAuditUsers: true });
};

function getStockStatus(stock) {
  if (!stock.quantity) return 'OUT_OF_STOCK';
  if (stock.quantity <= stock.reorderLevel) return 'LOW_STOCK';
  if (stock.quantity >= stock.maximumStock) return 'EXCESS_STOCK';
  return 'NORMAL';
}

/**
 * Get item by id
 * @param {ObjectId} id
 * @returns {Promise<Item>}
 */
const getItemById = async (id, companyId) => {
  const { Item, ItemInventory } = getBooksCrmModels();
  const { QualityMaster, Recipe, Account, Process } = getBooksModels();
  const { User } = getCommonModels();

  const item = await Item.findOne({ _id: id, companyId }).populate([
    { path: 'itemGroup', select: 'name' },
    { path: 'subItemGroup', select: 'name' },
    { path: 'itemUnitId', select: 'name' },
    { path: 'unitConversions.itemUnitId', select: 'name' },
    { path: 'stockInUnit', select: 'name' },
    { path: 'stockOutUnit', select: 'name' },
    { path: 'productionData.bomBased.item', select: 'itemName' },
    { path: 'productionData.bomBased.itemGroup', select: 'name' },
    { path: 'productionData.bomBased.itemUnitId', select: 'name' },
    { path: 'productionData.processBased.rawMaterials.item', select: 'itemName' },
    { path: 'productionData.processBased.rawMaterials.itemGroup', select: 'name' },
    { path: 'productionData.processBased.rawMaterials.itemUnitId', select: 'name' },
    { path: 'productionData.productionScrapOutInventory.scrapItemName', select: 'itemName' },
    { path: 'productionData.productionScrapOutInventory.itemUnitId', select: 'name' },
  ]);

  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const itemInventory = await ItemInventory.findOne({ itemId: item._id, companyId }).lean();

  const mappedAccountIds = [
    item.salesInformation?.salesAccountId,
    item.purchaseInformation?.purchaseAccountId,
    item.inventoryAccountId,
  ].filter(Boolean);
  const mappedAccounts = mappedAccountIds.length
    ? await Account.find({ _id: { $in: mappedAccountIds } })
        .select('_id accountName')
        .lean()
    : [];
  const accountById = new Map(mappedAccounts.map(account => [String(account._id), account]));

  const fqlStanderIds = [...new Set([].concat(item.salesData?.fqlStander || []).filter(Boolean))];

  const processRecipeIds = [...new Set([].concat(item.productionData?.selectProcessRecipe || []).filter(Boolean))];

  const processIds = [
    ...new Set((item.productionData?.processBased || []).map(row => row.processId && String(row.processId)).filter(Boolean)),
  ];

  const [fqlStanders, processRecipes, processes] = await Promise.all([
    QualityMaster.find({ _id: { $in: fqlStanderIds } })
      .select('qcReportName')
      .lean(),
    Recipe.find({ _id: { $in: processRecipeIds } })
      .select('name')
      .lean(),
    processIds.length
      ? Process.find({ _id: { $in: processIds } })
          .select('name processId')
          .lean()
      : [],
  ]);
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (item.commentHistory?.length) {
    const userIds = item.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = item.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  const fqlStanderMap = fqlStanders.reduce((acc, qc) => {
    acc[qc._id.toString()] = qc;
    return acc;
  }, {});

  const processRecipeMap = processRecipes.reduce((acc, recipe) => {
    acc[recipe._id.toString()] = recipe;
    return acc;
  }, {});

  const itemObj = item.toObject();
  if (itemInventory) {
    itemObj.inventoryData = itemInventory;
  }
  // Populate sales data
  if (itemObj.salesData) {
    itemObj.salesData.fqlStander = Array.isArray(itemObj.salesData.fqlStander)
      ? itemObj.salesData.fqlStander.map(id => fqlStanderMap[id.toString()] || null)
      : fqlStanderMap[itemObj.salesData.fqlStander?.toString()] || null;
  }

  // Populate production data
  if (itemObj.productionData) {
    itemObj.productionData.selectProcessRecipe = Array.isArray(itemObj.productionData.selectProcessRecipe)
      ? itemObj.productionData.selectProcessRecipe.map(id => processRecipeMap[id.toString()] || null)
      : processRecipeMap[itemObj.productionData.selectProcessRecipe?.toString()] || null;

    const processMap = new Map(processes.map(proc => [String(proc._id), proc]));
    itemObj.productionData.processBased = (itemObj.productionData.processBased || []).map(row => ({
      ...row,
      processId: processMap.get(String(row.processId)) || row.processId,
    }));
  }
  itemObj.commentHistory = commentHistoryWithUser;
  itemObj.id = itemObj._id;
  if (itemObj.salesInformation && item.salesInformation.salesAccountId) {
    itemObj.salesInformation.salesAccountId = accountById.get(String(item.salesInformation.salesAccountId)) || null;
  }
  if (itemObj.purchaseInformation && itemObj.purchaseInformation.purchaseAccountId) {
    itemObj.purchaseInformation.purchaseAccountId = accountById.get(String(item.purchaseInformation.purchaseAccountId)) || null;
  }
  itemObj.inventoryAccountId = item.inventoryAccountId ? accountById.get(String(item.inventoryAccountId)) || null : null;
  return itemObj;
};

/**
 * Update item by id
 * @param {ObjectId} itemId
 * @param {Object} updateBody
 * @param {ObjectId} userId
 * @returns {Promise<Item>}
 */
const updateItemById = async (
  itemId,
  updateBody,
  userId,
  regularAttachments = [],
  purchasingDataAttachments = [],
  salesDataAttachments = [],
) => {
  const { Item, ItemInventory, ItemBatch } = getBooksCrmModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();
  session.startTransaction();

  try {
    const item = await Item.findById(itemId).session(session);
    if (!item) {
      throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    await assertProductionItemsAreStock(updateBody.productionData, item.companyId, session);
    await applyPortalPlanGate(item.companyId, updateBody.salesData, item.salesData);
    if (updateBody?.removeItemUnitId?.length > 0) {
      await itemUnitUsage(updateBody?.removeItemUnitId, updateBody?.companyId);
    }

    const isServiceItem = updateBody?.itemCategory?.isService;
    let itemInventory = await ItemInventory.findOne({ itemId: item._id, companyId: item.companyId }).session(session);

    if (updateBody.trackInventory === true && !updateBody.itemCategory.isService && !updateBody.inventoryAccountId) {
      throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.INVENTORY_ACCOUNT_REQUIRED);
    }

    const { Invoice, CreditNote, Bill, DebitNote } = getBooksModels();
    const usedInDocument = { companyId: item.companyId, 'items.itemId': item._id };
    const [soldOnInvoice, soldOnCreditNote, boughtOnBill, boughtOnDebitNote] = await Promise.all([
      Invoice.exists(usedInDocument).session(session),
      CreditNote.exists(usedInDocument).session(session),
      Bill.exists(usedInDocument).session(session),
      DebitNote.exists(usedInDocument).session(session),
    ]);
    const salesAccountLocked = Boolean(soldOnInvoice || soldOnCreditNote);
    const purchaseAccountLocked = Boolean(boughtOnBill || boughtOnDebitNote);
    const hasInventoryStock = Number(itemInventory?.totalAvailableStock) > 0;

    if (
      salesAccountLocked &&
      updateBody?.salesInformation?.salesAccountId !== undefined &&
      String(updateBody.salesInformation.salesAccountId || '') !== String(item.salesInformation?.salesAccountId || '')
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.SALES_ACCOUNT_LOCKED);
    }
    if (
      purchaseAccountLocked &&
      updateBody?.purchaseInformation?.purchaseAccountId !== undefined &&
      String(updateBody.purchaseInformation.purchaseAccountId || '') !== String(item.purchaseInformation?.purchaseAccountId || '')
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.PURCHASE_ACCOUNT_LOCKED);
    }
    if (
      hasInventoryStock &&
      updateBody?.inventoryAccountId !== undefined &&
      String(updateBody.inventoryAccountId || '') !== String(item.inventoryAccountId || '')
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.INVENTORY_ACCOUNT_LOCKED);
    }

    // Batches, stock and document quantities are all kept against the main unit, so it is fixed when the item is created.
    if (item.itemUnitId && updateBody.itemUnitId && String(updateBody.itemUnitId) !== String(item.itemUnitId)) {
      throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.ITEM_UNIT_LOCKED);
    }

    const stopsTracking = updateBody?.trackInventory === false || isServiceItem === true;
    if (stopsTracking && item.trackInventory !== false && hasInventoryStock) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot turn off inventory tracking while this item holds ${itemInventory.totalAvailableStock} in stock. Adjust the stock to zero first.`,
      );
    }

    if (
      stopsTracking &&
      item.trackInventory !== false &&
      (await itemHasBatchOrProductionOrder(item._id, item.companyId, session))
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.TRACK_INVENTORY_LOCKED);
    }

    if (!itemInventory && !isServiceItem) {
      // Create ItemInventory if it doesn't exist
      const createdItemInventory = await ItemInventory.create(
        [
          {
            itemId: item._id,
            companyId: item.companyId,
            totalOpeningStock: 0,
            totalAvailableStock: 0,
            inventorySalesMethod: null,
            warehouses: [],
            addedBy: userId,
            updatedBy: userId,
          },
        ],
        { session },
      );
      itemInventory = createdItemInventory[0];
    }

    const findItemByName = await Item.findOne({
      itemName: updateBody.itemName,
      companyId: item.companyId,
      _id: { $ne: itemId },
    }).session(session);

    if (findItemByName) {
      throw new ApiError(httpStatus.CONFLICT, 'Item with this name already exists.');
    }

    // Handle inventory data updates separately
    let inventoryUpdateData = null;
    if (updateBody.inventoryData && !isServiceItem) {
      inventoryUpdateData = { ...updateBody.inventoryData };
      // Preserve fields that shouldn't be directly updated
      const preservedFields = {
        totalOpeningStock: itemInventory.totalOpeningStock || 0,
        totalAvailableStock: itemInventory.totalAvailableStock || 0,
      };

      // Calculate new totals if warehouses are being updated
      if (inventoryUpdateData.warehouses && Array.isArray(inventoryUpdateData.warehouses)) {
        let totalOpeningStock = 0;
        let totalAvailableStock = 0;

        for (const warehouse of inventoryUpdateData.warehouses) {
          warehouse.openingStock = warehouse.openingStock || 0;
          warehouse.availableStock = warehouse.availableStock || warehouse.openingStock || 0;
          warehouse.isActive = warehouse.isActive !== undefined ? warehouse.isActive : true;

          totalOpeningStock += warehouse.openingStock;
          totalAvailableStock += warehouse.availableStock;
        }

        preservedFields.totalOpeningStock = totalOpeningStock;
        preservedFields.totalAvailableStock = totalAvailableStock;
      }

      // Merge preserved fields
      inventoryUpdateData.totalOpeningStock = preservedFields.totalOpeningStock;
      inventoryUpdateData.totalAvailableStock = preservedFields.totalAvailableStock;
      inventoryUpdateData.updatedBy = userId;
    }

    const updatedProductionData = updateBody.productionData;

    if (updatedProductionData?.bomBased?.length) {
      const bomItems = updatedProductionData.bomBased;

      /* ===== COLLECT ALL oldItemIds ===== */
      const oldItemIds = bomItems.map(i => i.oldItemId).filter(Boolean);

      if (oldItemIds.length) {
        /* ===== FIND ITEMS WHERE THIS oldItemId IS USED IN BOM ===== */
        const itemsUsingOldBom = await Item.find({
          _id: { $ne: itemId },
          'productionData.bomBased.item': { $in: oldItemIds },
        })
          .select('productionData.bomBased')
          .lean();

        /* ===== CREATE MAP: oldItemId -> item details ===== */
        const replaceMap = new Map();

        for (const item of bomItems) {
          if (item.oldItemId) {
            replaceMap.set(item.oldItemId.toString(), item);
          }
        }

        /* ===== UPDATE OTHER ITEMS ===== */
        const bomBulkOps = [];

        for (const doc of itemsUsingOldBom) {
          let isModified = false;

          const updatedBom = doc.productionData.bomBased.map(bom => {
            const bomItemId = bom.item?.toString();

            if (replaceMap.has(bomItemId)) {
              const newItem = replaceMap.get(bomItemId);

              // Only replace the item reference — keep each item's own qty/reject/return intact
              if (newItem.item?.toString() !== bom.item?.toString()) {
                isModified = true;
                return {
                  ...bom,
                  item: newItem.item,
                  itemGroup: newItem.itemGroup ?? bom.itemGroup,
                  // The old unit may not exist on the replacement item, so take the unit chosen for it.
                  itemUnitId: newItem.itemUnitId ?? null,
                };
              }
            }

            return bom; // untouched
          });

          if (isModified) {
            bomBulkOps.push({
              updateOne: {
                filter: { _id: doc._id },
                update: { $set: { 'productionData.bomBased': updatedBom } },
              },
            });
          }
        }

        if (bomBulkOps.length) {
          await Item.bulkWrite(bomBulkOps, { session });
        }
      }

      /* ===== STRIP oldItemId BEFORE SAVING — must not persist to DB ===== */
      updatedProductionData.bomBased = updatedProductionData.bomBased.map(({ oldItemId, ...rest }) => rest);
    }

    if (inventoryUpdateData && (!inventoryUpdateData.warehouses || inventoryUpdateData.warehouses.length === 0)) {
      inventoryUpdateData.warehouses = itemInventory.warehouses || [];
    }

    item.commentHistory = item.commentHistory || [];
    item.commentHistory.push({
      message: `Item updated`,
      addedBy: userId,
      createdAt: new Date(),
    });
    // Add update history

    const originalAttachments = item.attachments || [];
    const originalPurchasingAttachments = item.purchasingData?.vendorSideMFGAndQCDocument || [];
    const originalSalesAttachments = item.salesData?.vendorSideMFGAndQCDocument || [];

    await assertStockUnitsValid(updateBody, item.companyId, session);

    const { inventoryData: _inv, removeItemUnitId: _ruid, ...restUpdateBody } = updateBody;
    item.set({ ...restUpdateBody, commentHistory: item.commentHistory });
    item.updatedBy = userId;

    await item.save({ session });

    // Update warehouses if provided
    let openingStockValueDelta = 0;
    if (inventoryUpdateData?.warehouses && Array.isArray(inventoryUpdateData.warehouses)) {
      // Sequential, not Promise.all: each iteration issues ItemBatch reads/writes on the shared
      // transaction session, and the MongoDB driver doesn't support concurrent operations on one session.
      const updatedWarehouses = [];
      for (const warehouse of inventoryUpdateData.warehouses) {
        const existingWarehouse = itemInventory.warehouses?.find(
          w => w.warehouseId?.toString() === warehouse.warehouseId?.toString(),
        );

        if (existingWarehouse) {
          const originalOpening = existingWarehouse.openingStock || 0;
          const originalAvailable = existingWarehouse.availableStock ?? originalOpening;
          const originalInventoryValue = existingWarehouse.inventoryValue ?? 0;

          const currentOpening = warehouse.openingStock ?? originalOpening;

          // The opening-stock ItemBatch tracks prior consumption (deductions) and is a rate fallback
          // for legacy rows; the previously saved rate is the persisted itemInventory value the user
          // was shown on the edit form.
          const openingBatch = await ItemBatch.findOne({
            itemId: item._id,
            companyId: item.companyId,
            warehouseId: warehouse.warehouseId,
            sourceType: 'OPENING_STOCK',
          }).session(session);

          const existingRate = existingWarehouse.openingStockRate ?? (openingBatch?.purchasePrice || 0);
          const submittedRate = warehouse.openingStockRate;
          const currentRate =
            submittedRate === undefined || submittedRate === null || submittedRate === ''
              ? existingRate
              : Number(submittedRate) || 0;
          const isOpeningStockChanging = currentOpening !== originalOpening || currentRate !== existingRate;

          if (isOpeningStockChanging && openingBatch && (openingBatch.deductions?.length || 0) > 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.OPENING_STOCK_ALREADY_USED);
          }

          const diff = currentOpening - originalOpening;
          const newAvailable = originalAvailable + diff;
          const valueDiff = currentOpening * currentRate - originalOpening * existingRate;
          const newInventoryValue = originalInventoryValue + valueDiff;
          openingStockValueDelta += valueDiff;

          if (isOpeningStockChanging) {
            if (openingBatch) {
              // Guarded above: no deductions exist yet, so remainingQty stays in sync with quantity.
              openingBatch.quantity = currentOpening;
              openingBatch.remainingQty = currentOpening;
              openingBatch.purchasePrice = currentRate;
              await openingBatch.save({ session });
            } else if (currentOpening > 0) {
              const warehouseStockObj = {
                action: 'addOpeningStockBatch',
                stockData: {
                  itemId: item._id,
                  companyId: item.companyId,
                  branchId: warehouse.branchId,
                  divisionId: warehouse?.divisionId,
                  warehouseId: warehouse.warehouseId,
                  quantity: currentOpening,
                  purchasePrice: currentRate,
                  vendorBatchNo: null,
                  vendorBatchExpiry: null,
                  sourceType: 'OPENING_STOCK',
                  sourceId: item._id,
                },
                session,
              };

              await handleWarehouseStock(warehouseStockObj);

              await checkCompanyStockLevels({
                itemIds: [item._id],
                companyId: item.companyId,
                docType: MODULE_NAMES.ITEM,
                docId: item._id,
                docNo: item.itemNo,
                userId,
                session,
              });
            }
          }

          updatedWarehouses.push({
            ...warehouse,
            openingStock: currentOpening,
            availableStock: newAvailable,
            isActive: warehouse.isActive !== undefined ? warehouse.isActive : existingWarehouse.isActive,
            inventoryValue: newInventoryValue,
          });
          continue;
        }

        if (warehouse.openingStock > 0) {
          const warehouseStockObj = {
            action: 'addOpeningStockBatch',
            stockData: {
              itemId: item._id,
              companyId: item.companyId,
              branchId: warehouse.branchId,
              divisionId: warehouse?.divisionId,
              warehouseId: warehouse.warehouseId,
              quantity: warehouse.openingStock,
              purchasePrice: warehouse.openingStockRate || 0,
              vendorBatchNo: null,
              vendorBatchExpiry: null,
              sourceType: 'OPENING_STOCK',
              sourceId: item._id,
            },
            session,
          };
          await handleWarehouseStock(warehouseStockObj);

          await checkCompanyStockLevels({
            itemIds: [item._id],
            companyId: item.companyId,
            docType: MODULE_NAMES.ITEM,
            docId: item._id,
            docNo: item.itemNo,
            userId,
            session,
          });
          openingStockValueDelta += Number(warehouse.openingStock) * (Number(warehouse.openingStockRate) || 0);
        }

        // If warehouse not found, use provided values or defaults
        const fallbackOpening = warehouse.openingStock ?? 0;
        const fallbackAvailable = warehouse.availableStock ?? fallbackOpening;

        updatedWarehouses.push({
          ...warehouse,
          openingStock: fallbackOpening,
          availableStock: fallbackAvailable,
          isActive: warehouse.isActive !== undefined ? warehouse.isActive : true,
          inventoryValue: fallbackOpening * (warehouse.openingStockRate || 0),
        });
      }

      // Final updated array
      inventoryUpdateData.warehouses = updatedWarehouses;
    }

    const finalAttachments = await handleFileUpdate({
      newFiles: regularAttachments,
      currentUrls: updateBody.attachments || [],
      existingUrls: originalAttachments,
      userId,
      companyId: item.companyId,
    });

    const finalPurchasingDataAttachments = await handleFileUpdate({
      newFiles: purchasingDataAttachments,
      currentUrls: updateBody.purchasingData?.vendorSideMFGAndQCDocument || [],
      existingUrls: originalPurchasingAttachments,
      userId,
      companyId: item.companyId,
    });

    const finalSalesDataAttachments = await handleFileUpdate({
      newFiles: salesDataAttachments,
      currentUrls: updateBody.salesData?.vendorSideMFGAndQCDocument || [],
      existingUrls: originalSalesAttachments,
      userId,
      companyId: item.companyId,
    });

    item.attachments = finalAttachments;
    item.purchasingData.vendorSideMFGAndQCDocument = finalPurchasingDataAttachments;
    item.salesData.vendorSideMFGAndQCDocument = finalSalesDataAttachments;
    await item.save({ session });

    // Update ItemInventory separately if inventory data was provided
    if (inventoryUpdateData) {
      inventoryUpdateData.totalOpeningStock = inventoryUpdateData.warehouses.reduce((sum, wh) => sum + (wh.openingStock || 0), 0);
      inventoryUpdateData.totalAvailableStock = inventoryUpdateData.warehouses.reduce(
        (sum, wh) => sum + (wh.availableStock || 0),
        0,
      );
      inventoryUpdateData.totalInventoryValue = inventoryUpdateData.warehouses.reduce(
        (sum, wh) => sum + (wh.inventoryValue || 0),
        0,
      );
      Object.assign(itemInventory, inventoryUpdateData);
      await itemInventory.save({ session });

      // Sync the opening-stock journal only when the opening-stock value actually changed
      // (accumulated per warehouse above). inventoryUpdateData.warehouses carries the submitted
      // openingStock + openingStockRate for the recompute.
      if (Math.abs(openingStockValueDelta) > 0.001) {
        await syncItemOpeningStockJournal(item, inventoryUpdateData.warehouses, userId, session);
      }
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    session.endSession();
    return item;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error updating item:', error);
    throw error;
  }
};

/**
 * Delete item by id
 * @param {ObjectId} itemId
 * @returns {Promise<Item>}
 */
const deleteItemById = async (itemId, companyId) => {
  const item = await getItemById(itemId, companyId);
  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (await itemsInUse([item._id], companyId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, ITEM_MESSAGES.DELETE_IN_USE);
  }

  const { Item } = getBooksCrmModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.withTransaction(async () => {
      await deleteJournal(
        // Opening stock posted before the split still carries the generic opening balance module.
        {
          companyId: item.companyId,
          sourceModule: { $in: [LEDGER_SOURCE_MODULES.OPENING_STOCK, LEDGER_SOURCE_MODULES.OPENING_BALANCE] },
          sourceId: item._id,
        },
        session,
      );
      await cleanupItemOwnedRecords([item._id], companyId, session);
      await Item.deleteOne({ _id: item._id, companyId }, { session });
    });
  } finally {
    await session.endSession();
  }

  return item;
};

/**
 * Update item stock
 * @param {Object} stockData - Stock movement data
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Item>}
 */
const updateItemStock = async (stockData, userId) => {
  const { Item } = getBooksCrmModels();
  const {
    itemId,
    movementType,
    quantity,
    branchId,
    warehouseId,
    fromBranchId,
    fromWarehouseId,
    toBranchId,
    toWarehouseId,
    referenceId,
    referenceNumber,
    batchNumber,
    expiryDate,
    unitCost,
    notes,
  } = stockData;

  const item = await getItemById(itemId);
  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  // Initialize inventoryData if it doesn't exist
  if (!item.inventoryData) {
    item.inventoryData = {
      quantity: 0,
      branches: [],
    };
  }

  // Initialize stockMovements array if it doesn't exist
  if (!item.inventoryData.stockMovements) {
    item.inventoryData.stockMovements = [];
  }

  // Create a new stock movement record
  const stockMovement = {
    date: new Date(),
    movementType,
    quantity,
    fromBranchId,
    fromWarehouseId,
    toBranchId,
    toWarehouseId,
    referenceId,
    referenceNumber,
    batchNumber,
    notes,
    addedBy: userId,
  };

  // Add the stock movement to the history
  item.inventoryData.stockMovements.push(stockMovement);

  // Update quantities based on movement type
  switch (movementType) {
    case 'OPENING':
      await handleOpeningStock(item, branchId, warehouseId, quantity, batchNumber, expiryDate, unitCost);
      break;
    case 'PURCHASE':
    case 'RETURN':
      await handleStockIncrease(item, branchId, warehouseId, quantity, batchNumber, expiryDate, unitCost);
      break;
    case 'SALE':
    case 'ADJUSTMENT':
      await handleStockDecrease(item, branchId, warehouseId, quantity, batchNumber);
      break;
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      await handleStockTransfer(item, fromBranchId, fromWarehouseId, toBranchId, toWarehouseId, quantity, batchNumber);
      break;
    default:
      throw new ApiError(httpStatus.BAD_REQUEST, "This stock movement type isn't supported.");
  }

  // Update the updatedBy field
  item.updatedBy = userId;

  // Save the updated item
  await item.save();
  return item;
};

/**
 * Handle opening stock
 * @private
 */
async function handleOpeningStock(item, branchId, warehouseId, quantity, batchNumber, expiryDate, unitCost) {
  const { Branch, Warehouse } = getBooksCrmModels();
  // Find the branch in the item's inventory data
  let branch = item.inventoryData.branches.find(b => b.branchId && b.branchId.toString() === branchId.toString());

  // If branch doesn't exist, create it
  if (!branch) {
    // Fetch branch and warehouse details
    const branchDetails = await Branch.findById(branchId).lean();
    const warehouseDetails = await Warehouse.findById(warehouseId).lean();

    branch = {
      branchId,
      branchName: branchDetails ? branchDetails.name : '',
      bcode: branchDetails ? branchDetails.branchCode : '',
      warehouseId,
      whName: warehouseDetails ? warehouseDetails.name : '',
      whCode: warehouseDetails ? warehouseDetails.warehouseId : '',
      openingStock: quantity,
      quantity: quantity,
      batches: [],
    };
    item.inventoryData.branches.push(branch);
  } else {
    // Update existing branch
    branch.openingStock = quantity;
    branch.quantity = (branch.quantity || 0) + quantity;
  }

  // Initialize batches array if it doesn't exist
  if (!branch.batches) {
    branch.batches = [];
  }

  // Add batch information if provided
  if (batchNumber) {
    branch.batches.push({
      batchNumber,
      expiryDate,
      quantity,
      unitCost,
      manufacturingDate: new Date(),
    });
  }

  // Update total quantity
  item.inventoryData.quantity = item.inventoryData.branches.reduce((total, b) => total + (b.quantity || 0), 0);
}

/**
 * Handle stock increase (purchase, return)
 * @private
 */
async function handleStockIncrease(item, branchId, warehouseId, quantity, batchNumber, expiryDate, unitCost) {
  const { Branch, Warehouse } = getBooksCrmModels();
  // Find the branch in the item's inventory data
  let branch = item.inventoryData.branches.find(b => b.branchId && b.branchId.toString() === branchId.toString());

  // If branch doesn't exist, create it
  if (!branch) {
    // Fetch branch and warehouse details
    const branchDetails = await Branch.findById(branchId).lean();
    const warehouseDetails = await Warehouse.findById(warehouseId).lean();

    branch = {
      branchId,
      branchName: branchDetails ? branchDetails.name : '',
      bcode: branchDetails ? branchDetails.branchCode : '',
      warehouseId,
      whName: warehouseDetails ? warehouseDetails.name : '',
      whCode: warehouseDetails ? warehouseDetails.warehouseId : '',
      openingStock: 0,
      quantity: quantity,
      batches: [],
    };
    item.inventoryData.branches.push(branch);
  } else {
    // Update existing branch
    branch.quantity = (branch.quantity || 0) + quantity;
  }

  // Initialize batches array if it doesn't exist
  if (!branch.batches) {
    branch.batches = [];
  }

  // Add batch information if provided
  if (batchNumber) {
    // Check if batch already exists
    const existingBatch = branch.batches.find(b => b.batchNumber === batchNumber);
    if (existingBatch) {
      existingBatch.quantity += quantity;
    } else {
      branch.batches.push({
        batchNumber,
        expiryDate,
        quantity,
        unitCost,
        manufacturingDate: new Date(),
      });
    }
  }

  // Update total quantity
  item.inventoryData.quantity = item.inventoryData.branches.reduce((total, b) => total + (b.quantity || 0), 0);
}

/**
 * Handle stock decrease (sale, adjustment)
 * @private
 */
async function handleStockDecrease(item, branchId, warehouseId, quantity, batchNumber) {
  // Find the branch in the item's inventory data
  const branch = item.inventoryData.branches.find(b => b.branchId && b.branchId.toString() === branchId.toString());

  if (!branch) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Branch not found in item inventory');
  }

  if ((branch.quantity || 0) < quantity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Insufficient stock in branch');
  }

  // Update branch quantity
  branch.quantity -= quantity;

  // Update batch quantity if provided
  if (batchNumber && branch.batches) {
    const batch = branch.batches.find(b => b.batchNumber === batchNumber);
    if (batch) {
      if (batch.quantity < quantity) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Insufficient stock in batch');
      }
      batch.quantity -= quantity;

      // Remove batch if quantity becomes zero
      if (batch.quantity <= 0) {
        branch.batches = branch.batches.filter(b => b.batchNumber !== batchNumber);
      }
    } else {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Batch not found');
    }
  }

  // Update total quantity
  item.inventoryData.quantity = item.inventoryData.branches.reduce((total, b) => total + (b.quantity || 0), 0);
}

/**
 * Handle stock transfer
 * @private
 */
async function handleStockTransfer(item, fromBranchId, fromWarehouseId, toBranchId, toWarehouseId, quantity, batchNumber) {
  const { Branch, Warehouse } = getBooksCrmModels();
  // Find source branch
  const sourceBranch = item.inventoryData.branches.find(b => b.branchId && b.branchId.toString() === fromBranchId.toString());

  if (!sourceBranch) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Source branch not found in item inventory');
  }

  if ((sourceBranch.quantity || 0) < quantity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Insufficient stock in source branch');
  }

  // Find or create destination branch
  let destBranch = item.inventoryData.branches.find(b => b.branchId && b.branchId.toString() === toBranchId.toString());

  if (!destBranch) {
    // Fetch branch and warehouse details
    const branchDetails = await Branch.findById(toBranchId).lean();
    const warehouseDetails = await Warehouse.findById(toWarehouseId).lean();

    destBranch = {
      branchId: toBranchId,
      branchName: branchDetails ? branchDetails.name : '',
      bcode: branchDetails ? branchDetails.branchCode : '',
      warehouseId: toWarehouseId,
      whName: warehouseDetails ? warehouseDetails.name : '',
      whCode: warehouseDetails ? warehouseDetails.warehouseId : '',
      openingStock: 0,
      quantity: 0,
      batches: [],
    };
    item.inventoryData.branches.push(destBranch);
  }

  // Update quantities
  sourceBranch.quantity -= quantity;
  destBranch.quantity = (destBranch.quantity || 0) + quantity;

  // Handle batch transfer if provided
  if (batchNumber && sourceBranch.batches) {
    const sourceBatch = sourceBranch.batches.find(b => b.batchNumber === batchNumber);
    if (sourceBatch) {
      if (sourceBatch.quantity < quantity) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Insufficient stock in batch');
      }

      // Initialize batches array for destination if it doesn't exist
      if (!destBranch.batches) {
        destBranch.batches = [];
      }

      // Find or create batch in destination
      let destBatch = destBranch.batches.find(b => b.batchNumber === batchNumber);
      if (destBatch) {
        destBatch.quantity += quantity;
      } else {
        destBranch.batches.push({
          batchNumber: sourceBatch.batchNumber,
          expiryDate: sourceBatch.expiryDate,
          quantity: quantity,
          unitCost: sourceBatch.unitCost,
          manufacturingDate: sourceBatch.manufacturingDate,
        });
      }

      // Update source batch
      sourceBatch.quantity -= quantity;

      // Remove batch if quantity becomes zero
      if (sourceBatch.quantity <= 0) {
        sourceBranch.batches = sourceBranch.batches.filter(b => b.batchNumber !== batchNumber);
      }
    } else {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Batch not found in source branch');
    }
  }

  // No need to update total quantity as it remains the same after transfer
}

const getStockMovements = async (itemId, branchId, fromDate, toDate) => {
  const { Item } = getBooksCrmModels();
  const item = await getItemById(itemId);
  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  let movements = item.inventoryData?.stockMovements || [];

  // Apply filters
  if (branchId) {
    movements = movements.filter(m => m.fromBranchId?.toString() === branchId || m.toBranchId?.toString() === branchId);
  }

  if (fromDate) {
    movements = movements.filter(m => m.date >= new Date(fromDate));
  }

  if (toDate) {
    movements = movements.filter(m => m.date <= new Date(toDate));
  }

  return movements;
};

const getBranchStock = async (itemId, branchId) => {
  const item = await getItemById(itemId);
  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const branch = item.inventoryData?.branches?.find(b => b.branchId.toString() === branchId);

  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Branch stock not found');
  }

  return branch;
};

const addItemStock = async (stockData, userId, companyId) => {
  const { Item, Warehouse, ItemInventory } = getBooksCrmModels();
  const { InventoryLogs } = getBooksModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { itemId, warehouseId, quantity, price, referenceNumber, notes, branchId, divisionId } = stockData;

    // Validate inputs
    if (quantity <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Quantity must be greater than 0');
    }

    // Find item and ensure it exists
    const item = await Item.findOne({ _id: itemId, companyId }).session(session);
    if (!item) {
      throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    if (item?.itemCategory?.isService === true) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Service items cannot be added to inventory stock');
    }

    const itemInventory = await ItemInventory.findOne({ itemId: itemId, companyId }).session(session);

    if (!itemInventory) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Item inventory not found');
    }

    // Validate warehouse
    const warehouse = await Warehouse.findById(warehouseId).session(session);
    if (!warehouse) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Warehouse not found');
    }

    // Find or create branch
    let inventoryWarehouse = itemInventory.warehouses.find(b => b.warehouseId.equals(warehouseId));
    if (!inventoryWarehouse) {
      await defaultWarehouseEntry(
        {
          itemArray: [item],
          companyId: companyId,
          warehouseId: warehouseId,
          branchId: branchId,
          divisionId: divisionId,
          isActive: true,
        },
        session,
      );
      inventoryWarehouse = itemInventory.warehouses.find(b => b.warehouseId.equals(warehouseId));
    } else {
      // If branch already exists, update its stock quantities
      // inventoryWarehouse.totalStock += quantity;
      // inventoryWarehouse.availableStock += quantity;
    }

    // Update total inventory quantity based on all branches
    // itemInventory.totalAvailableStock = itemInventory.warehouses.reduce((total, b) => total + b.availableStock, 0);

    const inventoryLog = await InventoryLogs.create(
      [
        {
          ...stockData,
          createdBy: userId,
        },
      ],
      { session },
    );

    // add warehouseItem Batch
    const warehouseStockObj = {
      action: 'addStock',
      stockData: {
        itemId: itemId,
        companyId: companyId,
        divisionId: warehouse?.divisionId,
        branchId: branchId,
        warehouseId,
        quantity: quantity,
        purchasePrice: price,
        sourceType: 'MANUAL_STOCK_ADD',
        sourceId: inventoryLog[0]._id,
      },
      session,
    };

    await handleWarehouseStock(warehouseStockObj);

    await checkCompanyStockLevels({
      itemIds: [itemId],
      companyId,
      docType: MODULE_NAMES.ITEM,
      docId: itemId,
      docNo: item.itemNo,
      userId,
      session,
    });

    // Save changes
    await itemInventory.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    session.endSession();
    return item;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error transferring stock:', error);
    throw error;
  }
};

const adjustStock = async adjustmentData => {
  const { itemId, branchId, warehouseId, quantity, adjustmentType, reason, batchNumber, notes, addedBy } = adjustmentData;

  return updateItemStock({
    itemId,
    movementType: 'ADJUSTMENT',
    quantity: adjustmentType === 'INCREASE' ? quantity : -quantity,
    branchId,
    warehouseId,
    batchNumber,
    notes: `${reason}${notes ? ': ' + notes : ''}`,
    addedBy,
  });
};

const getProductionDataByItemId = async (query, filter, options) => {
  const { Item, ItemUnit } = getBooksCrmModels();
  const { itemId, companyId } = filter;

  if (!itemId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item ID is required');
  }

  // Fetch item with only productionData
  const item = await Item.findById(itemId).select('productionData').lean();

  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Item not found');
  }

  const productionData = item.productionData || {};
  const { productionManageMethod } = productionData;

  const enrichRows = async rows => {
    const unitIds = [...new Set(rows.map(row => row.itemUnitId && String(row.itemUnitId)).filter(Boolean))];
    const units = unitIds.length
      ? await ItemUnit.find({ _id: { $in: unitIds } })
          .select('name')
          .lean()
      : [];
    const unitMap = new Map(units.map(u => [String(u._id), { _id: u._id, name: u.name }]));

    return Promise.all(
      rows.map(async row => {
        try {
          const result = await getItemInventoryStatus(
            { includeZeroInventory: true },
            { companyId, itemId: row.item },
            { page: 1, limit: 1 },
          );

          const inventoryItem = result?.results?.[0] || {};

          return {
            ...row,
            itemUnitId: row.itemUnitId ? unitMap.get(String(row.itemUnitId)) || row.itemUnitId : inventoryItem.itemUnitId || null,
            itemName: inventoryItem.itemName || null,
            inventoryData: inventoryItem.itemInventory || [],
          };
        } catch (err) {
          console.error(`Error fetching inventory for item ${row.item}:`, err.message);
          return {
            ...row,
            itemUnitId: (row.itemUnitId && unitMap.get(String(row.itemUnitId))) || row.itemUnitId || null,
            itemName: null,
            inventoryData: [],
            error: true,
          };
        }
      }),
    );
  };

  // Case 1: BOM_BASED
  if (productionManageMethod === 'BOM_BASED') {
    const enrichedBomItems = await enrichRows(productionData.bomBased || []);

    return {
      _id: item._id,
      productionData: {
        productionManageMethod,
        bomBased: enrichedBomItems,
      },
    };
  }

  // Case 2: PROCESS_ROUTE
  if (productionManageMethod === 'PROCESS_ROUTE') {
    const { Process, Recipe } = getBooksModels();

    const processBasedRows = productionData.processBased || [];
    const processRefIds = [...new Set(processBasedRows.map(row => row.processId && String(row.processId)).filter(Boolean))];
    const processDocs = processRefIds.length
      ? await Process.find({ _id: { $in: processRefIds } })
          .select('name processId')
          .lean()
      : [];
    const processDocMap = new Map(processDocs.map(proc => [String(proc._id), proc]));

    const processBased = await Promise.all(
      processBasedRows.map(async row => ({
        ...row,
        processId: processDocMap.get(String(row.processId)) || row.processId,
        rawMaterials: await enrichRows(row.rawMaterials || []),
      })),
    );

    if (!productionData.selectProcessRecipe) {
      return {
        _id: item._id,
        productionData: {
          productionManageMethod,
          selectProcessRecipe: null,
          processBased,
        },
      };
    }

    // Then fetch the recipe and its processes separately
    const recipe = await Recipe.findById(productionData.selectProcessRecipe).select('recipeId name companyId processes').lean();

    if (!recipe) {
      return {
        _id: item._id,
        productionData: {
          productionManageMethod,
          selectProcessRecipe: null,
          processBased,
        },
      };
    }

    // Fetch processes separately
    const processes = await Promise.all(
      recipe.processes.map(async processId => {
        const process = await Process.findById(processId).select('name processId').lean();
        return process;
      }),
    );

    // Combine the data
    return {
      _id: item._id,
      productionData: {
        productionManageMethod,
        selectProcessRecipe: {
          _id: recipe._id,
          recipeId: recipe.recipeId,
          name: recipe.name,
          companyId: recipe.companyId,
          processes: processes.filter(Boolean), // Filter out any null processes
        },
        processBased,
      },
    };
  }

  // Default fallback (if method is unrecognized or missing)
  return {
    _id: item._id,
    productionData: {
      productionManageMethod: productionManageMethod || null,
    },
  };
};

const itembomBasedDropdown = async (query, filter) => {
  const { Item } = getBooksCrmModels();
  const { companyId } = filter;
  const matchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    'productionData.productionManageMethod': 'BOM_BASED',
    'productionData.bomBased.0': { $exists: true },
  };

  if (filter.isActive !== undefined) {
    matchFilter.isActive = filter.isActive;
  }

  const items = await Item.find(matchFilter).select('itemName itemType itemNo productionData.bomBased').lean();

  return items;
};

const getFgBomBasedItemsDropdown = async filter => {
  const { Item } = getBooksCrmModels();

  if (!filter.companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'companyId is required');
  }

  const matchFilter = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    itemType: 'FG',
    itemStatus: true,
    'productionData.productionManageMethod': PRODUCTION_MANAGE_METHOD.BOM_BASED,
  };

  if (filter.isActive !== undefined) {
    matchFilter.isActive = filter.isActive;
  }

  const items = await Item.find(matchFilter)
    .select('itemName itemNo itemType productionData.productionManageMethod productionData.bomBased isActive')
    .populate([
      {
        path: 'productionData.bomBased.item',
        select: 'itemName itemNo itemType',
      },
      {
        path: 'productionData.bomBased.itemGroup',
        select: 'name',
      },
    ])
    .lean();

  return items.map(item => {
    const bomBased = (item.productionData?.bomBased || []).map(bom => ({
      item: bom.item
        ? {
            _id: bom.item._id,
            itemName: bom.item.itemName,
            itemNo: bom.item.itemNo,
            itemType: bom.item.itemType,
          }
        : null,
      itemGroup: bom.itemGroup
        ? {
            _id: bom.itemGroup._id,
            name: bom.itemGroup.name,
          }
        : null,
      qtyPerItem: bom.qtyPerItem ?? null,
      reject: bom.reject ?? null,
      return: bom.return ?? null,
    }));

    return {
      _id: item._id,
      itemName: item.itemName,
      itemNo: item.itemNo,
      itemType: item.itemType,
      productionManageMethod: item.productionData?.productionManageMethod || null,
      bomBased,
    };
  });
};

const itemHistory = async (filter, options) => {
  const {
    DeliveryChallan,
    Invoice,
    PurchaseOrder,
    GrpoOrder,
    Bill,
    InventoryTransferRequest,
    ProductionOrder,
    CreditNote,
    DebitNote,
  } = getBooksModels();
  const { Quote, SalesOrder, Warehouse, Branch, Division, Item, ItemInventory, Customer, ItemUnit } = getBooksCrmModels();

  if (!filter.itemId || !mongoose.Types.ObjectId.isValid(filter.itemId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid itemId provided');
  }
  const itemId = new mongoose.Types.ObjectId(filter.itemId);
  // Normalize to the canonical lowercase-hex form so string comparisons against
  // doc.<field>.toString() can't miss when the request passes upper/mixed-case hex.
  const itemIdStr = itemId.toString();

  const [item, itemInventory] = await Promise.all([
    Item.findById(itemId).lean(),
    ItemInventory.findOne({ itemId, companyId: filter.companyId }).lean(),
  ]);
  if (!item) throw new ApiError(httpStatus.NOT_FOUND, 'Item not found');
  if (!itemInventory) throw new ApiError(httpStatus.NOT_FOUND, 'Item inventory not found');

  const openingBalance = filter.warehouseId
    ? itemInventory.warehouses?.find(w => w.warehouseId?.toString() === filter.warehouseId)?.openingStock || 0
    : itemInventory.warehouses?.reduce((sum, w) => sum + (w.openingStock || 0), 0) || 0;

  const itemRate = item.purchaseInformation?.costPrice || 0;

  const activeOrNotExistsFilter = { $or: [{ isActive: true }, { isActive: { $exists: false } }] };

  let searchQuery = {};
  if (filter.search) {
    const searchRegex = new RegExp(escapeRegex(filter.search.trim()), 'i');
    searchQuery = {
      $or: [
        { quoteId: searchRegex },
        { orderId: searchRegex },
        { challanId: searchRegex },
        { invoiceId: searchRegex },
        { poId: searchRegex },
        { grpoId: searchRegex },
        { billId: searchRegex },
        { creditNoteId: searchRegex },
        { debitNoteId: searchRegex },
        { transferId: searchRegex },
        { productionOrderCode: searchRegex },
      ],
    };
  }

  const splittableDocTypes = new Set(['Invoice', 'DebitNote', 'Bill', 'CreditNote']);

  const applySplitFilter = (query, docType) => {
    if (!splittableDocTypes.has(docType)) return;
    if (filter?.isSplit == undefined) query.isSplit = false;
    if (filter?.splitOnly) query.isSplit = true;
  };

  const DATE_FIELD = {
    Quote: 'quoteDate',
    SalesOrder: 'orderDate',
    DeliveryChallan: 'challanDate',
    Invoice: 'invoiceDate',
    PurchaseOrder: 'date',
    GrpoOrder: 'date',
    Bill: 'billDate',
    CreditNote: 'creditNoteDate',
    DebitNote: 'debitNoteDate',
    InventoryTransferRequest: 'createdAt',
    ProductionOrder: 'productionDate',
  };

  const REF_NO_FIELD = {
    Quote: 'quoteId',
    SalesOrder: 'orderId',
    DeliveryChallan: 'challanId',
    Invoice: 'invoiceId',
    PurchaseOrder: 'poId',
    GrpoOrder: 'grpoId',
    Bill: 'billId',
    CreditNote: 'creditNoteId',
    DebitNote: 'debitNoteId',
    InventoryTransferRequest: 'transferId',
    ProductionOrder: 'productionOrderCode',
  };

  const buildQuery = (docType, dateConstraint) => {
    const query = { companyId: filter.companyId };

    // Item-match condition. ProductionOrder & InventoryTransferRequest match the item across
    // several paths via $or; all other doc types match a single items.itemId field.
    let itemMatchOr = null;
    if (docType === 'ProductionOrder') {
      itemMatchOr = [
        { itemId },
        { 'rawMaterials.rawMaterialId': itemId },
        { 'processBased.processes.processRawMaterialInput.item': itemId },
        { 'processBased.processes.scrapOutProcess.item': itemId },
      ];
    } else if (docType === 'InventoryTransferRequest') {
      itemMatchOr = [{ itemId }, { 'rawMaterials.rawMaterialId': itemId }];
    } else {
      query['items.itemId'] = itemId;
    }

    // Warehouse-match condition. For the two $or-based doc types the warehouse also spans
    // multiple fields, so combine item-match AND warehouse-match via $and (overwriting the
    // item $or here would drop the item filter and fetch every doc in the warehouse).
    let warehouseMatchOr = null;
    if (filter.warehouseId) {
      const wId = new mongoose.Types.ObjectId(filter.warehouseId);
      if (docType === 'InventoryTransferRequest') {
        warehouseMatchOr = [{ fromWarehouseId: wId }, { toWarehouseId: wId }];
      } else if (docType === 'ProductionOrder') {
        warehouseMatchOr = [{ productionWarehouseId: wId }, { inventoryInwarehouseId: wId }];
      } else {
        query.warehouseId = wId;
      }
    }
    const minimumCreatedAtDate = new Date('2026-05-01');

    query.createdAt = {
      $gte: minimumCreatedAtDate,
    };

    if (itemMatchOr && warehouseMatchOr) {
      query.$and = [{ $or: itemMatchOr }, { $or: warehouseMatchOr }];
    } else if (itemMatchOr) {
      query.$or = itemMatchOr;
    } else if (warehouseMatchOr) {
      query.$or = warehouseMatchOr;
    }

    if (dateConstraint) {
      const dateField = DATE_FIELD[docType];
      if (dateField) query[dateField] = dateConstraint;
    }

    if (filter.branchId) {
      const ids = filter.branchId
        .split(',')
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id));
      if (ids.length) query.branchId = { $in: ids };
    }

    if (filter.divisionId) {
      const ids = filter.divisionId
        .split(',')
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id));
      if (ids.length) query.divisionId = { $in: ids };
    }

    if (filter.isActive !== undefined) query.isActive = filter.isActive;
    applySplitFilter(query, docType);
    return query;
  };

  const getStockEffectType = (doc, docType) => {
    if (docType === 'CreditNote') return 'IN';
    if (docType === 'DebitNote') return 'OUT';
    return doc?.inventoryConfig?.stockAddEnabled ? 'IN' : 'OUT';
  };

  const shouldIncludeStockMovement = (doc, docType) => {
    if (docType === 'CreditNote' || docType === 'DebitNote') return true;
    return (
      (doc?.inventoryConfig?.stockAddEnabled || doc?.inventoryConfig?.stockDeductEnabled) &&
      doc?.inventoryConfig?.stockHandledInBatch
    );
  };

  const getFinishedGoodsQty = doc => {
    if (doc.productionManageMethod === 'BOM_BASED') return doc.fgSubmittedQty || 0;
    if (doc.productionManageMethod === 'PROCESS_ROUTE') {
      const processes = doc.processBased?.processes;
      if (Array.isArray(processes) && processes.length > 0) {
        return processes[processes.length - 1].processOUT || 0;
      }
    }
    return 0;
  };

  // Build from whichever bounds are present. If only startDate is given, the lower bound must
  // still apply — otherwise pre-startDate docs land in both the opening-balance (historical)
  // set and the in-range results, double-counting them.
  let mainDateConstraint = null;
  if (filter.startDate || filter.endDate) {
    mainDateConstraint = {};
    if (filter.startDate) mainDateConstraint.$gte = new Date(filter.startDate);
    if (filter.endDate) mainDateConstraint.$lte = new Date(filter.endDate);
  }

  const [
    quotes,
    salesOrders,
    deliveryChallans,
    invoices,
    purchaseOrders,
    grpoOrders,
    bills,
    transferRequests,
    productionOrders,
    creditNotes,
    debitNotes,
  ] = await Promise.all([
    Quote.find({ ...buildQuery('Quote', mainDateConstraint), ...searchQuery }).lean(),
    SalesOrder.find({ ...buildQuery('SalesOrder', mainDateConstraint), ...searchQuery, ...activeOrNotExistsFilter }).lean(),
    DeliveryChallan.find({
      ...buildQuery('DeliveryChallan', mainDateConstraint),
      ...searchQuery,
      ...activeOrNotExistsFilter,
    }).lean(),
    Invoice.find({ ...buildQuery('Invoice', mainDateConstraint), ...searchQuery }).lean(),
    PurchaseOrder.find({ ...buildQuery('PurchaseOrder', mainDateConstraint), ...searchQuery }).lean(),
    GrpoOrder.find({ ...buildQuery('GrpoOrder', mainDateConstraint), ...searchQuery }).lean(),
    Bill.find({ ...buildQuery('Bill', mainDateConstraint), ...searchQuery }).lean(),
    InventoryTransferRequest.find({ ...buildQuery('InventoryTransferRequest', mainDateConstraint), ...searchQuery }).lean(),
    ProductionOrder.find({ ...buildQuery('ProductionOrder', mainDateConstraint), ...searchQuery }).lean(),
    CreditNote.find({ ...buildQuery('CreditNote', mainDateConstraint), ...searchQuery, type: 'GOODS_RETURN' }).lean(),
    DebitNote.find({ ...buildQuery('DebitNote', mainDateConstraint), ...searchQuery, type: 'GOODS_RETURN' }).lean(),
  ]);

  const allMovements = [];

  const warehouseIds = new Set();
  const branchIds = new Set();
  const divisionIds = new Set();
  const customerIds = new Set();

  const collectIds = docs => {
    docs.forEach(doc => {
      if (doc.warehouseId && mongoose.Types.ObjectId.isValid(doc.warehouseId)) {
        warehouseIds.add(doc.warehouseId.toString());
      }
      if (doc.fromWarehouseId && mongoose.Types.ObjectId.isValid(doc.fromWarehouseId)) {
        warehouseIds.add(doc.fromWarehouseId.toString());
      }
      if (doc.toWarehouseId && mongoose.Types.ObjectId.isValid(doc.toWarehouseId)) {
        warehouseIds.add(doc.toWarehouseId.toString());
      }
      if (doc.productionWarehouseId && mongoose.Types.ObjectId.isValid(doc.productionWarehouseId)) {
        warehouseIds.add(doc.productionWarehouseId.toString());
      }
      if (doc.inventoryInwarehouseId && mongoose.Types.ObjectId.isValid(doc.inventoryInwarehouseId)) {
        warehouseIds.add(doc.inventoryInwarehouseId.toString());
      }
      if (doc.branchId && mongoose.Types.ObjectId.isValid(doc.branchId)) {
        branchIds.add(doc.branchId.toString());
      }
      if (doc.divisionId && mongoose.Types.ObjectId.isValid(doc.divisionId)) {
        divisionIds.add(doc.divisionId.toString());
      }
      if (doc.customerId && mongoose.Types.ObjectId.isValid(doc.customerId)) {
        customerIds.add(doc.customerId.toString());
      }
      if (doc.vendor && mongoose.Types.ObjectId.isValid(doc.vendor)) {
        customerIds.add(doc.vendor.toString());
      }
      if (doc.vendorId && mongoose.Types.ObjectId.isValid(doc.vendorId)) {
        customerIds.add(doc.vendorId.toString());
      }
    });
  };

  [
    quotes,
    salesOrders,
    deliveryChallans,
    invoices,
    purchaseOrders,
    grpoOrders,
    bills,
    transferRequests,
    productionOrders,
    creditNotes,
    debitNotes,
  ].forEach(collectIds);

  const [warehouses, branches, divisions, customers] = await Promise.all([
    Warehouse.find({ _id: { $in: Array.from(warehouseIds).map(id => new mongoose.Types.ObjectId(id)) } })
      .select('name')
      .lean(),
    Branch.find({ _id: { $in: Array.from(branchIds).map(id => new mongoose.Types.ObjectId(id)) } })
      .select('name')
      .lean(),
    Division.find({ _id: { $in: Array.from(divisionIds).map(id => new mongoose.Types.ObjectId(id)) } })
      .select('name')
      .lean(),
    Customer.find({ _id: { $in: Array.from(customerIds).map(id => new mongoose.Types.ObjectId(id)) } })
      .select('customerDisplayName')
      .lean(),
  ]);

  const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w.name]));
  const branchMap = new Map(branches.map(b => [b._id.toString(), b.name]));
  const divisionMap = new Map(divisions.map(d => [d._id.toString(), d.name]));
  const customerMap = new Map(customers.map(c => [c._id.toString(), c.customerDisplayName]));

  const collectMovementsFromDoc = (doc, docType, target, maps) => {
    const isHistorical = !maps;
    const docDate = doc[DATE_FIELD[docType]];

    const push = ({
      quantity,
      amount,
      rate: r,
      effectType,
      warehouseId,
      branchId,
      divisionId,
      customerId: custId,
      itemUnitId,
      date,
      notes,
    }) => {
      const entryDate = date ?? docDate;
      if (isHistorical) {
        target.push({ date: entryDate, quantity, amount, effectType, warehouseId, referenceType: docType });
      } else {
        target.push({
          date: entryDate,
          createdAt: doc.createdAt || new Date(),
          refType: docType,
          refId: doc._id,
          refNo: doc[REF_NO_FIELD[docType]] ?? null,
          quantity,
          rate: r ?? 0,
          amount,
          status: doc.status,
          warehouseId,
          warehouseName: warehouseId ? maps.warehouseMap.get(warehouseId?.toString()) : null,
          branchId: branchId ?? null,
          branchName: branchId ? maps.branchMap.get(branchId?.toString()) : null,
          divisionId: divisionId ?? null,
          divisionName: divisionId ? maps.divisionMap.get(divisionId?.toString()) : null,
          partyName: custId ? maps.customerMap.get(custId?.toString()) || '' : '',
          effectType,
          itemUnitId: itemUnitId ?? null,
          referenceType: docType,
          referenceId: doc._id,
          referenceWarehouseId: warehouseId?.toString(),
          ...(notes ? { notes } : {}),
        });
      }
    };

    if (docType === 'InventoryTransferRequest') {
      if (doc.isProductionOrderReq && Array.isArray(doc.rawMaterials)) {
        const rm = doc.rawMaterials.find(r => r.rawMaterialId.toString() === itemIdStr);
        if (rm && doc.status === 'APPROVED') {
          const qty = rm.productionOrderRequiredUnit;
          const amt = isHistorical ? 0 : itemRate * qty;
          push({
            quantity: qty,
            amount: amt,
            rate: itemRate,
            effectType: 'OUT',
            warehouseId: doc.fromWarehouseId,
            notes: doc.notes || 'Raw material transfer out',
          });
          push({
            quantity: qty,
            amount: amt,
            rate: itemRate,
            effectType: 'IN',
            warehouseId: doc.toWarehouseId,
            notes: doc.notes || 'Raw material transfer in',
          });
        }
      } else if (doc.itemId?.toString() === itemIdStr && doc.status === 'APPROVED') {
        const qty = doc.quantity;
        const amt = isHistorical ? 0 : itemRate * qty;
        push({
          quantity: qty,
          amount: amt,
          rate: itemRate,
          effectType: 'OUT',
          warehouseId: doc.fromWarehouseId,
          itemUnitId: doc.itemUnitId,
          notes: doc.notes || 'Transfer out',
        });
        push({
          quantity: qty,
          amount: amt,
          rate: itemRate,
          effectType: 'IN',
          warehouseId: doc.toWarehouseId,
          itemUnitId: doc.itemUnitId,
          notes: doc.notes || 'Transfer in',
        });
      }
    } else if (docType === 'ProductionOrder') {
      const isFinishedGood = doc.itemId?.toString() === itemIdStr;
      const isRawMaterial =
        doc.productionManageMethod === 'BOM_BASED' &&
        Array.isArray(doc.rawMaterials) &&
        doc.rawMaterials.some(rm => rm.rawMaterialId.toString() === itemIdStr);
      const isProcessItem =
        doc.productionManageMethod === 'PROCESS_ROUTE' &&
        doc.processBased?.processes &&
        doc.processBased.processes.some(
          p =>
            p.processRawMaterialInput?.some(i => i.item?.toString() === itemIdStr) ||
            p.scrapOutProcess?.some(s => s.item?.toString() === itemIdStr),
        );

      if (!isFinishedGood && !isRawMaterial && !isProcessItem) return;

      if (isFinishedGood && doc.status === 'COMPLETED') {
        const qty = getFinishedGoodsQty(doc);
        if (qty > 0) {
          const amt = isHistorical ? 0 : itemRate * qty;
          push({
            quantity: qty,
            amount: amt,
            rate: itemRate,
            effectType: 'IN',
            warehouseId: doc.inventoryInwarehouseId,
            branchId: doc.branchId,
            divisionId: doc.divisionId,
            notes: 'Finished goods production completed',
          });
        }
      }

      if (isRawMaterial && doc.productionManageMethod === 'BOM_BASED' && Array.isArray(doc.rawMaterials)) {
        doc.rawMaterials.forEach(rawMaterial => {
          if (rawMaterial.rawMaterialId.toString() !== itemIdStr) return;
          const qty = rawMaterial.productionOrderSubmittedUnit + (rawMaterial.rejectQty || 0);
          if (qty > 0) {
            const amt = isHistorical ? 0 : itemRate * qty;
            push({
              quantity: qty,
              amount: amt,
              rate: itemRate,
              effectType: 'OUT',
              warehouseId: doc.productionWarehouseId,
              branchId: doc.branchId,
              divisionId: doc.divisionId,
              notes: 'Raw material consumed in production',
            });
          }
        });
      }

      if (isProcessItem && doc.productionManageMethod === 'PROCESS_ROUTE' && doc.processBased?.processes) {
        doc.processBased.processes.forEach(process => {
          if (!process.endDatetime) return;
          const processLabel = process.processName || process.processNo || 'Unknown Process';

          process.processRawMaterialInput?.forEach(input => {
            if (input.item?.toString() === itemIdStr && input.value > 0) {
              const amt = isHistorical ? 0 : itemRate * input.value;
              push({
                date: process.endDatetime,
                quantity: input.value,
                amount: amt,
                rate: itemRate,
                effectType: 'OUT',
                warehouseId: doc.productionWarehouseId,
                branchId: doc.branchId,
                divisionId: doc.divisionId,
                notes: `Raw material consumed in process: ${processLabel}`,
              });
            }
          });

          process.scrapOutProcess?.forEach(scrap => {
            if (scrap.item?.toString() === itemIdStr && scrap.value > 0) {
              const amt = isHistorical ? 0 : itemRate * scrap.value;
              push({
                date: process.endDatetime,
                quantity: scrap.value,
                amount: amt,
                rate: itemRate,
                effectType: 'IN',
                warehouseId: doc.productionWarehouseId,
                branchId: doc.branchId,
                divisionId: doc.divisionId,
                notes: `Scrap output from process: ${processLabel}`,
              });
            }
          });
        });
      }
    } else {
      if (!doc.items) return;
      const docItem = doc.items.find(i => i.itemId.toString() === itemIdStr);
      if (!docItem || !shouldIncludeStockMovement(doc, docType)) return;
      push({
        quantity: docItem.quantity,
        rate: docItem.rate,
        amount: docItem.amount,
        effectType: getStockEffectType(doc, docType),
        warehouseId: doc.warehouseId,
        branchId: doc.branchId,
        divisionId: doc.divisionId,
        customerId: doc.customerId || doc.vendor || doc.vendorId,
        itemUnitId: docItem.itemUnitId,
      });
    }
  };

  const maps = { warehouseMap, branchMap, divisionMap, customerMap };

  quotes.forEach(doc => collectMovementsFromDoc(doc, 'Quote', allMovements, maps));
  salesOrders.forEach(doc => collectMovementsFromDoc(doc, 'SalesOrder', allMovements, maps));
  deliveryChallans.forEach(doc => collectMovementsFromDoc(doc, 'DeliveryChallan', allMovements, maps));
  invoices.forEach(doc => collectMovementsFromDoc(doc, 'Invoice', allMovements, maps));
  purchaseOrders.forEach(doc => collectMovementsFromDoc(doc, 'PurchaseOrder', allMovements, maps));
  grpoOrders.forEach(doc => collectMovementsFromDoc(doc, 'GrpoOrder', allMovements, maps));
  bills.forEach(doc => collectMovementsFromDoc(doc, 'Bill', allMovements, maps));
  transferRequests.forEach(doc => collectMovementsFromDoc(doc, 'InventoryTransferRequest', allMovements, maps));
  productionOrders.forEach(doc => collectMovementsFromDoc(doc, 'ProductionOrder', allMovements, maps));
  creditNotes.forEach(doc => collectMovementsFromDoc(doc, 'CreditNote', allMovements, maps));
  debitNotes.forEach(doc => collectMovementsFromDoc(doc, 'DebitNote', allMovements, maps));

  const movementUnitIds = [...new Set(allMovements.map(m => m.itemUnitId?.toString()).filter(Boolean))];
  if (movementUnitIds.length) {
    const movementUnits = await ItemUnit.find({ _id: { $in: movementUnitIds } })
      .select('name')
      .lean();
    const movementUnitMap = new Map(movementUnits.map(u => [u._id.toString(), u]));
    allMovements.forEach(m => {
      if (m.itemUnitId) m.itemUnitId = movementUnitMap.get(m.itemUnitId.toString()) || m.itemUnitId;
    });
  }

  allMovements.sort((a, b) => {
    const dateComparison = new Date(a.date) - new Date(b.date);
    if (dateComparison !== 0) return dateComparison;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });

  let calculatedOpeningBalance = openingBalance;
  let closingBalance = openingBalance;

  let historicalMovements = [];

  if (filter.startDate) {
    const historicalDateConstraint = { $lt: new Date(filter.startDate) };

    const [
      historicalQuotes,
      historicalSalesOrders,
      historicalDeliveryChallans,
      historicalInvoices,
      historicalPurchaseOrders,
      historicalGrpoOrders,
      historicalBills,
      historicalTransferRequests,
      historicalProductionOrders,
      historicalCreditNotes,
      historicalDebitNotes,
    ] = await Promise.all([
      Quote.find(buildQuery('Quote', historicalDateConstraint)).lean(),
      SalesOrder.find({ ...buildQuery('SalesOrder', historicalDateConstraint), ...activeOrNotExistsFilter }).lean(),
      DeliveryChallan.find({ ...buildQuery('DeliveryChallan', historicalDateConstraint), ...activeOrNotExistsFilter }).lean(),
      Invoice.find(buildQuery('Invoice', historicalDateConstraint)).lean(),
      PurchaseOrder.find(buildQuery('PurchaseOrder', historicalDateConstraint)).lean(),
      GrpoOrder.find(buildQuery('GrpoOrder', historicalDateConstraint)).lean(),
      Bill.find(buildQuery('Bill', historicalDateConstraint)).lean(),
      InventoryTransferRequest.find(buildQuery('InventoryTransferRequest', historicalDateConstraint)).lean(),
      ProductionOrder.find(buildQuery('ProductionOrder', historicalDateConstraint)).lean(),
      CreditNote.find({ ...buildQuery('CreditNote', historicalDateConstraint), type: 'GOODS_RETURN' }).lean(),
      DebitNote.find({ ...buildQuery('DebitNote', historicalDateConstraint), type: 'GOODS_RETURN' }).lean(),
    ]);

    historicalQuotes.forEach(doc => collectMovementsFromDoc(doc, 'Quote', historicalMovements, null));
    historicalSalesOrders.forEach(doc => collectMovementsFromDoc(doc, 'SalesOrder', historicalMovements, null));
    historicalDeliveryChallans.forEach(doc => collectMovementsFromDoc(doc, 'DeliveryChallan', historicalMovements, null));
    historicalInvoices.forEach(doc => collectMovementsFromDoc(doc, 'Invoice', historicalMovements, null));
    historicalPurchaseOrders.forEach(doc => collectMovementsFromDoc(doc, 'PurchaseOrder', historicalMovements, null));
    historicalGrpoOrders.forEach(doc => collectMovementsFromDoc(doc, 'GrpoOrder', historicalMovements, null));
    historicalBills.forEach(doc => collectMovementsFromDoc(doc, 'Bill', historicalMovements, null));
    historicalTransferRequests.forEach(doc =>
      collectMovementsFromDoc(doc, 'InventoryTransferRequest', historicalMovements, null),
    );
    historicalProductionOrders.forEach(doc => collectMovementsFromDoc(doc, 'ProductionOrder', historicalMovements, null));
    historicalCreditNotes.forEach(doc => collectMovementsFromDoc(doc, 'CreditNote', historicalMovements, null));
    historicalDebitNotes.forEach(doc => collectMovementsFromDoc(doc, 'DebitNote', historicalMovements, null));

    let historicalNetEffect = 0;
    historicalMovements.forEach(m => {
      historicalNetEffect += m.effectType === 'IN' ? m.quantity : -m.quantity;
    });

    calculatedOpeningBalance = openingBalance + historicalNetEffect;
  }

  let netMovementsInRange = 0;
  allMovements.forEach(m => {
    netMovementsInRange += m.effectType === 'IN' ? m.quantity : -m.quantity;
  });
  closingBalance = calculatedOpeningBalance + netMovementsInRange;

  let runningBalance = calculatedOpeningBalance;
  allMovements.forEach(movement => {
    runningBalance += movement.effectType === 'IN' ? movement.quantity : -movement.quantity;
    movement.QuantityBalance = runningBalance;
  });

  let openingAmount = 0;
  historicalMovements.forEach(m => {
    openingAmount += m.effectType === 'IN' ? m.amount || 0 : -(m.amount || 0);
  });

  let runningAmount = openingAmount;
  allMovements.forEach(movement => {
    runningAmount += movement.effectType === 'IN' ? movement.amount || 0 : -(movement.amount || 0);
    movement.RunningAmount = runningAmount;
  });
  const closingAmount = runningAmount;

  const page = parseInt(options.page, 10) || 1;
  const limit = parseInt(options.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const paginatedMovements = allMovements.slice(startIndex, startIndex + limit);

  let broughtForward = 0;
  let broughtForwardAmount = 0;

  if (page > 1) {
    let previousPageNetQuantity = 0;
    let previousPageNetAmount = 0;
    allMovements.slice(0, startIndex).forEach(m => {
      if (m.effectType === 'IN') {
        previousPageNetQuantity += m.quantity;
        previousPageNetAmount += m.amount || 0;
      } else {
        previousPageNetQuantity -= m.quantity;
        previousPageNetAmount -= m.amount || 0;
      }
    });
    broughtForward = calculatedOpeningBalance + previousPageNetQuantity;
    broughtForwardAmount = openingAmount + previousPageNetAmount;
  }

  let carriedOver = broughtForward;
  let carriedOverAmount = broughtForwardAmount;

  if (paginatedMovements.length > 0) {
    const lastMovement = paginatedMovements[paginatedMovements.length - 1];
    carriedOver = lastMovement.QuantityBalance || broughtForward;
    carriedOverAmount = lastMovement.RunningAmount !== undefined ? lastMovement.RunningAmount : broughtForwardAmount;
  }

  return {
    results: paginatedMovements,
    page,
    limit,
    totalPages: Math.ceil(allMovements.length / limit),
    totalResults: allMovements.length,
    openingBalance: calculatedOpeningBalance,
    closingBalance,
    broughtForward,
    carriedOver,
    netMovements: netMovementsInRange,
    openingAmount,
    closingAmount,
    broughtForwardAmount,
    carriedOverAmount,
  };
};

/**
 * Get available stock for specific item(s) in a specific warehouse
 * @param {Object} query - Query parameters containing companyId, itemId (single or comma-separated), warehouseId
 * @returns {Promise<Object>} Available stock information
 */
const getAvailableStock = async query => {
  const { Item, ItemInventory } = getBooksCrmModels();
  const { companyId, itemId, warehouseId } = query;

  if (!companyId || !itemId || !warehouseId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'companyId, itemId, and warehouseId are required');
  }

  // Handle multiple itemIds (comma-separated)
  const itemIds = itemId
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (itemIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one valid itemId is required');
  }

  // Convert to ObjectIds
  const itemObjectIds = itemIds.map(id => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Invalid itemId: ${id}`);
    }
    return new mongoose.Types.ObjectId(id);
  });

  // Find all items and get stock information for the specific warehouse
  const items = await Item.find({
    _id: { $in: itemObjectIds },
    companyId: companyId,
    'itemCategory.isService': { $ne: true },
  }).select('itemName itemNo');

  if (items.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No items found');
  }

  // Process each item
  const results = await Promise.all(
    items.map(async item => {
      const itemInventory = await ItemInventory.findOne({ itemId: item._id, companyId });

      // Find the specific warehouse branch
      const branch = itemInventory?.warehouses?.find(
        branch => branch.warehouseId && branch.warehouseId.toString() === warehouseId.toString(),
      );

      if (!branch) {
        return {
          itemId: item._id,
          itemName: item.itemName,
          itemNo: item.itemNo,
          warehouseId: warehouseId,
          availableStock: 0,
          openingStock: 0,
          isActive: false,
        };
      }

      return {
        itemId: item._id,
        itemName: item.itemName,
        itemNo: item.itemNo,
        warehouseId: warehouseId,
        availableStock: branch.availableStock || 0,
        openingStock: branch.openingStock || 0,
        isActive: branch.isActive || false,
      };
    }),
  );

  // Always return array for consistency
  return {
    items: results,
    totalItems: results.length,
    warehouseId: warehouseId,
  };
};

const updateStatus = async (id, isActive, companyId) => {
  const { Item, Customer, Quote, SalesOrder } = getBooksCrmModels();
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

  const salesOrder_restictedStatus = [SALES_ORDER_STATUS.COMPLETED, SALES_ORDER_STATUS.CANCELLED];

  const deliveryChallan_restictedStatus = [DELIVERY_CHALLAN_STATUS.DELIVERED, DELIVERY_CHALLAN_STATUS.CANCELLED];

  const invoice_restictedStatus = [INVOICE_STATUS.PAID, INVOICE_STATUS.CANCELLED];

  const creditNote_restictedStatus = [CREDIT_NOTE_STATUS.USED, CREDIT_NOTE_STATUS.CANCELLED, CREDIT_NOTE_STATUS.CLOSED];

  const purchaseOrder_restictedStatus = [PO_STATUSES.REJECTED, PO_STATUSES.CONVERTED, PO_STATUSES.CANCELLED];

  const grpoOrder__restictedStatus = [GRPO_STATUSES.CONVERTED, GRPO_STATUSES.CANCELLED];

  const bill_restictedStatus = [BILL_STATUSES.PAID, BILL_STATUSES.OVERDUE, BILL_STATUSES.CANCELLED];

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
    Quote.countDocuments({ status: { $nin: quote_restictedStatus }, companyId, 'items.itemId': id }),
    SalesOrder.countDocuments({ status: { $nin: salesOrder_restictedStatus }, companyId, 'items.itemId': id }),
    DeliveryChallan.countDocuments({ status: { $nin: deliveryChallan_restictedStatus }, companyId, 'items.itemId': id }),
    Invoice.countDocuments({ status: { $nin: invoice_restictedStatus }, companyId, 'items.itemId': id }),
    PurchaseOrder.countDocuments({ status: { $nin: purchaseOrder_restictedStatus }, companyId, 'items.itemId': id }),
    GrpoOrder.countDocuments({ status: { $nin: grpoOrder__restictedStatus }, companyId, 'items.itemId': id }),
    Bill.countDocuments({ status: { $nin: bill_restictedStatus }, companyId, 'items.itemId': id }),
    RecurringInvoice.countDocuments({
      'items.itemId': id,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringExpense.countDocuments({
      'items.itemId': id,
      companyId,
      status: 'ACTIVE',
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    RecurringBills.countDocuments({
      'items.itemId': id,
      status: 'ACTIVE',
      companyId,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    }),
    ProductionOrder.countDocuments({ itemId: id, companyId, status: { $nin: [PRODUCTION_ORDER_STATUS.COMPLETED] } }),
    InventoryTransferRequest.countDocuments({ itemId: id, companyId, status: INVENTORY_TRANSFER_REQUEST.PENDING }),
    InventoryAdjustment.countDocuments({ 'items.itemId': id, companyId, status: 'DRAFT' }),
    DebitNote.countDocuments({ status: { $nin: debitNote_restictedStatus }, companyId, 'items.itemId': id }),
    CreditNote.countDocuments({ status: { $nin: creditNote_restictedStatus }, companyId, 'items.itemId': id }),
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
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item cannot be deactivated because it is used in active documents');
  }

  const item = await Item.findOneAndUpdate({ _id: id, companyId }, { itemStatus: isActive });

  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return item;
};

const exportInventoryStock = async (query, filter, options) => {
  const { Item } = getBooksCrmModels();
  const { companyId, itemId } = filter;
  const includeZeroInventory = query.includeZeroInventory === true || query.includeZeroInventory === 'true';
  const matchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    'itemCategory.isService': { $ne: true },
  };

  if (itemId) {
    matchFilter._id = new mongoose.Types.ObjectId(itemId);
  }

  if (query.search) {
    const searchRegex = new RegExp(escapeRegex(query.search.trim()), 'i');

    matchFilter.$or = [
      { itemName: searchRegex },
      { itemType: searchRegex },
      { itemNo: searchRegex },
      { itemModelNo: searchRegex },
    ];
  }
  if (query.itemType) {
    const itemTypes = query.itemType.split(',').filter(Boolean);
    if (itemTypes.length > 0) {
      matchFilter.itemType = { $in: itemTypes };
    }
  }
  if (query.itemGroup) {
    const itemGroups = query.itemGroup.split(',').filter(Boolean);
    if (itemGroups.length > 0) {
      matchFilter.itemGroup = { $in: itemGroups.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (filter.isActive !== undefined) {
    matchFilter.isActive = filter.isActive;
  }

  let warehouseFilter = null;
  let branchFilter = null;
  let divisionFilter = null;

  if (query.warehouseId) {
    const warehouseIds = query.warehouseId.split(',').filter(Boolean);
    if (warehouseIds.length > 0) {
      warehouseFilter = warehouseIds.map(id => new mongoose.Types.ObjectId(id));
    }
  }
  if (query.branchId) {
    const branchIds = query.branchId.split(',').filter(Boolean);
    if (branchIds.length > 0) {
      branchFilter = branchIds.map(id => new mongoose.Types.ObjectId(id));
    }
  }
  if (query.divisionId) {
    const divisionIds = query.divisionId.split(',').filter(Boolean);
    if (divisionIds.length > 0) {
      divisionFilter = divisionIds.map(id => new mongoose.Types.ObjectId(id));
    }
  }

  const inventoryLookupPipeline = [{ $unwind: { path: '$warehouses', preserveNullAndEmptyArrays: true } }];
  if (warehouseFilter?.length || branchFilter?.length || divisionFilter?.length) {
    const matchConditions = {};
    if (warehouseFilter?.length) matchConditions['warehouses.warehouseId'] = { $in: warehouseFilter };
    if (branchFilter?.length) matchConditions['warehouses.branchId'] = { $in: branchFilter };
    if (divisionFilter?.length) matchConditions['warehouses.divisionId'] = { $in: divisionFilter };
    inventoryLookupPipeline.push({ $match: matchConditions });
  }
  inventoryLookupPipeline.push({
    $group: {
      _id: '$itemId',
      totalAvailableStock: { $sum: { $ifNull: ['$warehouses.availableStock', 0] } },
      totalInventoryValue: { $sum: { $ifNull: ['$warehouses.inventoryValue', 0] } },
    },
  });

  const pipeline = [
    { $match: matchFilter },
    {
      $lookup: {
        from: 'itemgroups',
        localField: 'itemGroup',
        foreignField: '_id',
        as: 'itemGroupInfo',
      },
    },
    {
      $unwind: {
        path: '$itemGroupInfo',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: 'iteminventories',
        localField: '_id',
        foreignField: 'itemId',
        as: 'inventoryData',
        pipeline: inventoryLookupPipeline,
      },
    },
    {
      $unwind: {
        path: '$inventoryData',
        preserveNullAndEmptyArrays: true,
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: 'itembatches',
        let: { itemId: '$_id', cid: matchFilter.companyId },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$itemId', '$$itemId'] }, { $eq: ['$companyId', '$$cid'] }] } } },
          { $sort: { createdAt: -1 } },
          { $limit: 1 },
          { $project: { purchasePrice: 1 } },
        ],
        as: 'latestBatch',
      },
    },
    {
      $project: {
        _id: 1,
        itemId: '$itemNo',
        itemName: 1,
        itemType: 1,
        itemModelNo: 1,
        itemGroup: '$itemGroupInfo.name',
        totalAvailableQty: { $ifNull: ['$inventoryData.totalAvailableStock', 0] },
        totalValuation: { $ifNull: ['$inventoryData.totalInventoryValue', 0] },
        latestPrice: { $ifNull: [{ $arrayElemAt: ['$latestBatch.purchasePrice', 0] }, null] },
      },
    },
    ...(!includeZeroInventory ? [{ $match: { totalAvailableQty: { $gt: 0 } } }] : []),
  ];

  const items = await Item.aggregate(pipeline);
  const totalCount = items.length;

  return {
    results: items,
    totalResults: totalCount,
  };
};

const getItemsUsingRawMaterial = async (itemId, companyId) => {
  const { Item } = getBooksCrmModels();

  if (!itemId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item ID is required');
  }

  const itemObjectId = new mongoose.Types.ObjectId(itemId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const itemExists = await Item.exists({
    _id: itemObjectId,
    companyId: companyObjectId,
  });

  if (!itemExists) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Item not found');
  }

  const pipeline = [
    {
      $match: {
        companyId: companyObjectId,
        'productionData.productionManageMethod': 'BOM_BASED',
        'productionData.bomBased': {
          $elemMatch: {
            item: itemObjectId,
          },
        },
      },
    },
    {
      $lookup: {
        from: 'itemgroups',
        localField: 'itemGroup',
        foreignField: '_id',
        as: 'itemGroupData',
      },
    },
    {
      $unwind: {
        path: '$itemGroupData',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        _id: 1,
        itemName: 1,
        itemNo: 1,
        itemType: 1,
        itemGroup: '$itemGroupData.name',
        itemStatus: 1,
        itemUnit: 1,
      },
    },
  ];

  const items = await Item.aggregate(pipeline);
  return items;
};

const createProductionData = async (itemId, productionDataBody, filter, userId) => {
  const { Item } = getBooksCrmModels();
  const item = await Item.findOneAndUpdate(
    {
      _id: itemId,
      companyId: filter.companyId,
    },
    {
      $set: { productionData: productionDataBody, updatedBy: userId },
    },
    { new: true, runValidators: true },
  );

  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return item;
};

const viewItem = async (id, filter) => {
  const { Item, ItemInventory, Warehouse } = getBooksCrmModels();
  const { companyId } = filter;

  const item = await Item.findOne({ _id: id, companyId })
    .populate({ path: 'itemGroup', select: 'name' })
    .select(
      'itemNo itemName itemType itemModelNo itemGroup itemUnit description itemStatus trackInventory itemCategory hsnCode gst salesInformation purchaseInformation',
    )
    .lean();

  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const itemInventory = await ItemInventory.findOne({ itemId: id, companyId }).lean();

  let inventoryData = {
    totalOpeningStock: 0,
    totalAvailableStock: 0,
    warehouses: [],
  };

  if (itemInventory) {
    const warehouseIds = [...new Set((itemInventory.warehouses || []).map(w => w.warehouseId).filter(Boolean))];
    const warehouses = warehouseIds.length
      ? await Warehouse.find({ _id: { $in: warehouseIds } })
          .select('name warehouseId')
          .lean()
      : [];
    const warehouseMap = new Map(warehouses.map(w => [w._id.toString(), w]));

    inventoryData = {
      totalOpeningStock: itemInventory.totalOpeningStock ?? 0,
      totalAvailableStock: itemInventory.totalAvailableStock ?? 0,
      warehouses: (itemInventory.warehouses || []).map(wh => {
        const warehouse = warehouseMap.get(wh.warehouseId?.toString());
        return {
          warehouseId: wh.warehouseId,
          warehouseNo: warehouse?.warehouseId ?? null,
          warehouseName: warehouse?.name ?? null,
          openingStock: wh.openingStock ?? 0,
          availableStock: wh.availableStock ?? 0,
          openingStockRate: wh.openingStockRate ?? 0,
          isActive: wh.isActive ?? true,
        };
      }),
    };
  }

  return { ...item, inventoryData };
};

const getPendingPurchaseOrderQty = async query => {
  const { companyId, itemId } = query;
  const { Item, Quote, SalesOrder } = getBooksCrmModels();
  const { PurchaseOrder, GrpoOrder, Bill, DeliveryChallan, Invoice } = getBooksModels();
  const { CompanySettings } = getCommonModels();

  const item = await Item.findOne({ _id: itemId, companyId }).select('_id').lean();
  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const itemObjectId = new mongoose.Types.ObjectId(itemId);

  const companySettings = await CompanySettings.findOne({ companyId }).select('inventoryConfig').lean();
  const stockAddSource = companySettings?.inventoryConfig?.purchaseFlowStockAddSource;
  const stockDeductSource = companySettings?.inventoryConfig?.salesFlowStockDeductSource;

  const sumConvertedQtyByReference = async (Model, referenceIds, excludedStatuses) => {
    const rows = await Model.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          'items.referenceId': { $in: referenceIds },
          status: { $nin: excludedStatuses },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.referenceId': { $in: referenceIds }, 'items.itemId': itemObjectId } },
      { $group: { _id: '$items.referenceId', qty: { $sum: '$items.quantity' } } },
    ]);
    return new Map(rows.map(row => [row._id.toString(), row.qty]));
  };

  const itemQtyIn = doc =>
    (doc.items || []).filter(line => line.itemId?.toString() === itemId).reduce((sum, line) => sum + (line.quantity || 0), 0);

  const allPurchaseOrders = await PurchaseOrder.find({
    companyId: companyObjectId,
    status: { $in: [PO_STATUSES.DRAFT, PO_STATUSES.ACCEPTED, PO_STATUSES.PARTIALLY_RECORDED] },
    'items.itemId': itemObjectId,
  })
    .select('items status')
    .lean();

  const purchaseOrders = allPurchaseOrders.filter(po => po.status !== PO_STATUSES.DRAFT);

  let poPendingQty = 0;
  let poCount = 0;
  let poDraftQty = 0;
  let poDraftCount = 0;
  let grpoPendingQty = 0;
  let grpoCount = 0;

  for (const po of allPurchaseOrders.filter(doc => doc.status === PO_STATUSES.DRAFT)) {
    const qty = itemQtyIn(po);
    poDraftQty += qty;
    if (qty > 0) poDraftCount += 1;
  }

  if (purchaseOrders.length) {
    const poIds = purchaseOrders.map(po => po._id);
    const [grpoQtyByPO, billQtyByPO] = await Promise.all([
      sumConvertedQtyByReference(GrpoOrder, poIds, [GRPO_STATUSES.CANCELLED, GRPO_STATUSES.DRAFT]),
      sumConvertedQtyByReference(Bill, poIds, [BILL_STATUSES.CANCELLED, BILL_STATUSES.DRAFT]),
    ]);

    for (const po of purchaseOrders) {
      const convertedQty = (grpoQtyByPO.get(po._id.toString()) || 0) + (billQtyByPO.get(po._id.toString()) || 0);
      const pending = Math.max(0, itemQtyIn(po) - convertedQty);
      poPendingQty += pending;
      if (pending > 0) poCount += 1;
    }
  }

  if (stockAddSource === MODULE_NAMES.BILL) {
    const recordedGrpos = await GrpoOrder.find({
      companyId: companyObjectId,
      status: GRPO_STATUSES.RECORDED,
      'inventoryConfig.stockAddEnabled': false,
      'items.itemId': itemObjectId,
    })
      .select('items')
      .lean();

    if (recordedGrpos.length) {
      const grpoIds = recordedGrpos.map(grpo => grpo._id);
      const billQtyByGrpo = await sumConvertedQtyByReference(Bill, grpoIds, [BILL_STATUSES.CANCELLED, BILL_STATUSES.DRAFT]);

      for (const grpo of recordedGrpos) {
        const billedQty = billQtyByGrpo.get(grpo._id.toString()) || 0;
        const pending = Math.max(0, itemQtyIn(grpo) - billedQty);
        grpoPendingQty += pending;
        if (pending > 0) grpoCount += 1;
      }
    }
  }

  let quotePendingQty = 0;
  let quoteCount = 0;
  let quoteDraftQty = 0;
  let quoteDraftCount = 0;
  let salesOrderPendingQty = 0;
  let salesOrderCount = 0;
  let salesOrderDraftQty = 0;
  let salesOrderDraftCount = 0;
  let deliveryChallanPendingQty = 0;
  let deliveryChallanCount = 0;
  let deliveryChallanDraftQty = 0;
  let deliveryChallanDraftCount = 0;

  const quotes = await Quote.find({
    companyId: companyObjectId,
    status: { $in: [QUOTE_STATUS.DRAFT, QUOTE_STATUS.SENT, QUOTE_STATUS.ACCEPTED] },
    'items.itemId': itemObjectId,
  })
    .select('items status')
    .lean();

  for (const quote of quotes) {
    const qty = itemQtyIn(quote);
    if (quote.status === QUOTE_STATUS.DRAFT) {
      quoteDraftQty += qty;
      if (qty > 0) quoteDraftCount += 1;
    } else {
      quotePendingQty += qty;
      if (qty > 0) quoteCount += 1;
    }
  }

  const allSalesOrders = await SalesOrder.find({
    companyId: companyObjectId,
    status: { $in: [SALES_ORDER_STATUS.DRAFT, SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.PARTIALLY_RECORDED] },
    'items.itemId': itemObjectId,
  })
    .select('items status')
    .lean();

  const salesOrders = allSalesOrders.filter(so => so.status !== SALES_ORDER_STATUS.DRAFT);

  for (const so of allSalesOrders.filter(doc => doc.status === SALES_ORDER_STATUS.DRAFT)) {
    const qty = itemQtyIn(so);
    salesOrderDraftQty += qty;
    if (qty > 0) salesOrderDraftCount += 1;
  }

  if (salesOrders.length) {
    const soIds = salesOrders.map(so => so._id);
    const [dcQtyBySO, invoiceQtyBySO] = await Promise.all([
      sumConvertedQtyByReference(DeliveryChallan, soIds, [DELIVERY_CHALLAN_STATUS.CANCELLED, DELIVERY_CHALLAN_STATUS.DRAFT]),
      sumConvertedQtyByReference(Invoice, soIds, [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.DRAFT]),
    ]);

    for (const so of salesOrders) {
      const convertedQty = (dcQtyBySO.get(so._id.toString()) || 0) + (invoiceQtyBySO.get(so._id.toString()) || 0);
      const pending = Math.max(0, itemQtyIn(so) - convertedQty);
      salesOrderPendingQty += pending;
      if (pending > 0) salesOrderCount += 1;
    }
  }

  if (stockDeductSource === MODULE_NAMES.INVOICE) {
    const pendingDeliveryChallans = await DeliveryChallan.find({
      companyId: companyObjectId,
      status: { $in: [DELIVERY_CHALLAN_STATUS.DRAFT, DELIVERY_CHALLAN_STATUS.SENT] },
      'inventoryConfig.stockDeductEnabled': false,
      $or: [{ salesOrders: { $exists: false } }, { salesOrders: { $size: 0 } }],
      'items.itemId': itemObjectId,
    })
      .select('items status')
      .lean();

    for (const dc of pendingDeliveryChallans) {
      const qty = itemQtyIn(dc);
      if (dc.status === DELIVERY_CHALLAN_STATUS.DRAFT) {
        deliveryChallanDraftQty += qty;
        if (qty > 0) deliveryChallanDraftCount += 1;
      } else {
        deliveryChallanPendingQty += qty;
        if (qty > 0) deliveryChallanCount += 1;
      }
    }
  }

  return {
    itemId,
    pendingQty: Math.round((poPendingQty + grpoPendingQty) * 1000) / 1000,
    poPendingQty,
    poCount,
    poDraftQty,
    poDraftCount,
    grpoPendingQty,
    grpoCount,
    pendingSalesQty: Math.round((quotePendingQty + salesOrderPendingQty + deliveryChallanPendingQty) * 1000) / 1000,
    quotePendingQty,
    quoteCount,
    quoteDraftQty,
    quoteDraftCount,
    salesOrderPendingQty,
    salesOrderCount,
    salesOrderDraftQty,
    salesOrderDraftCount,
    deliveryChallanPendingQty,
    deliveryChallanCount,
    deliveryChallanDraftQty,
    deliveryChallanDraftCount,
    draftQty: Math.round((poDraftQty + quoteDraftQty + salesOrderDraftQty + deliveryChallanDraftQty) * 1000) / 1000,
    draftCount: Math.round((poDraftCount + quoteDraftCount + salesOrderDraftCount + deliveryChallanDraftCount) * 1000) / 1000,
  };
};

// Number of digits after the decimal point in the raw input, without float-precision noise.
const getDecimalPlaces = value => {
  if (value === null || value === undefined || value === '') return 0;
  const str = String(value);
  return str.includes('.') ? str.split('.')[1].length : 0;
};

const validateBulkItemInventory = async (itemInventory, companyId) => {
  const { Item, Warehouse, ItemBatch } = getBooksCrmModels();

  itemInventory.forEach(entry => {
    if (typeof entry.itemNo === 'string') {
      entry.itemNo = entry.itemNo.trim();
    }
    (entry.warehouses || []).forEach(warehouse => {
      if (typeof warehouse.warehouseName === 'string') {
        warehouse.warehouseName = warehouse.warehouseName.trim();
      }
    });
  });

  const itemNos = [...new Set(itemInventory.map(entry => entry.itemNo).filter(Boolean))];
  const warehouseNames = [
    ...new Set(itemInventory.flatMap(entry => (entry.warehouses || []).map(w => w.warehouseName)).filter(Boolean)),
  ];

  const [existingItems, existingWarehouses] = await Promise.all([
    itemNos.length ? Item.find({ companyId, itemNo: { $in: itemNos } }).lean() : [],
    warehouseNames.length ? Warehouse.find({ companyId, name: { $in: warehouseNames } }).lean() : [],
  ]);

  const itemByNo = new Map(existingItems.map(item => [item.itemNo, item]));
  const warehouseByName = new Map(existingWarehouses.map(warehouse => [warehouse.name, warehouse]));

  // Only pairs that actually resolve to a real item + warehouse can be checked against ItemBatch.
  const resolvablePairs = [];
  itemInventory.forEach(entry => {
    const item = itemByNo.get(entry.itemNo);
    if (!item) return;
    (entry.warehouses || []).forEach(warehouse => {
      const warehouseDoc = warehouseByName.get(warehouse.warehouseName);
      if (warehouseDoc) resolvablePairs.push({ itemId: item._id, warehouseId: warehouseDoc._id });
    });
  });

  const existingBatches = resolvablePairs.length
    ? await ItemBatch.find({
        companyId,
        itemId: { $in: resolvablePairs.map(pair => pair.itemId) },
        warehouseId: { $in: resolvablePairs.map(pair => pair.warehouseId) },
      })
        .select('itemId warehouseId')
        .lean()
    : [];
  const existingBatchSet = new Set(existingBatches.map(batch => `${batch.itemId}_${batch.warehouseId}`));

  // ---- Duplicate item + warehouse pair within the sheet ----
  const pairCountInSheet = {};
  itemInventory.forEach(entry => {
    (entry.warehouses || []).forEach(warehouse => {
      if (!entry.itemNo || !warehouse.warehouseName) return;
      const key = `${entry.itemNo}__${warehouse.warehouseName}`;
      pairCountInSheet[key] = (pairCountInSheet[key] || 0) + 1;
    });
  });

  const invalidRecords = [];
  const validRecords = [];
  const rows = [];

  itemInventory.forEach((entry, index) => {
    const errors = [];
    const itemNo = entry.itemNo;
    const item = itemByNo.get(itemNo);

    if (!itemNo) {
      errors.push({ name: 'ITEM_NO_REQUIRED', message: 'Item No is required.' });
    } else if (!item) {
      errors.push({ name: 'ITEM_NOT_FOUND', message: `Item does not exist: ${itemNo}` });
    } else if (item?.trackInventory === false) {
      errors.push({
        name: 'TRACK_INVENTORY_DISABLED',
        message: `Inventory tracking is not enabled for item: ${itemNo}. Opening stock import is not supported for this item.`,
      });
    }

    if (!Array.isArray(entry.warehouses) || entry.warehouses.length === 0) {
      errors.push({ name: 'WAREHOUSES_REQUIRED', message: 'At least one warehouse is required.' });
    } else {
      entry.warehouses.forEach((warehouse, warehouseIndex) => {
        const label = `Warehouse ${warehouseIndex + 1}`;
        const warehouseDoc = warehouseByName.get(warehouse.warehouseName);
        const stockNum = Number(warehouse.stock);
        const valueNum = Number(warehouse.value);
        // A warehouse can be registered against the item with zero opening stock — no batch
        // gets created for that row, so stock/value are only required to both be > 0, or both 0.
        const isZeroEntry = stockNum === 0 && valueNum === 0;

        if (!warehouse.warehouseName) {
          errors.push({ name: 'WAREHOUSE_NAME_REQUIRED', message: `${label}: Warehouse Name is required.` });
        } else if (!warehouseDoc) {
          errors.push({
            name: 'WAREHOUSE_NOT_FOUND',
            message: `${label}: Warehouse does not exist: ${warehouse.warehouseName}`,
          });
        }

        if (!isZeroEntry && !(stockNum > 0 && valueNum > 0)) {
          errors.push({
            name: 'STOCK_VALUE_MISMATCH',
            message: `${label}: Stock and Value must either both be 0, or both be greater than 0.`,
          });
        }

        if (getDecimalPlaces(warehouse.stock) > 3) {
          errors.push({ name: 'STOCK_PRECISION_INVALID', message: `${label}: Stock must have at most 3 decimal places.` });
        }

        if (getDecimalPlaces(warehouse.value) > 3) {
          errors.push({ name: 'VALUE_PRECISION_INVALID', message: `${label}: Value must have at most 3 decimal places.` });
        }

        if (itemNo && warehouse.warehouseName) {
          const pairKey = `${itemNo}__${warehouse.warehouseName}`;
          if (pairCountInSheet[pairKey] > 1) {
            errors.push({
              name: 'DUPLICATE_ITEM_WAREHOUSE_IN_SHEET',
              message: `${label}: Duplicate item + warehouse in sheet: ${itemNo} / ${warehouse.warehouseName}`,
            });
          }

          // A zero-stock row never creates a batch, so a pre-existing batch doesn't conflict with it.
          if (!isZeroEntry && item && warehouseDoc && existingBatchSet.has(`${item._id}_${warehouseDoc._id}`)) {
            errors.push({
              name: 'ITEM_BATCH_ALREADY_EXISTS',
              message: `${label}: Item batch already exists for item ${itemNo} and warehouse ${warehouse.warehouseName}`,
            });
          }
        }
      });
    }

    if (errors.length > 0) {
      invalidRecords.push({ rowNumber: index + 1, itemNo: itemNo || null, warehouses: entry.warehouses || null, errors });
    } else {
      validRecords.push(entry);
      entry.warehouses.forEach(warehouse => {
        const stockNum = Number(warehouse.stock) || 0;
        const valueNum = Number(warehouse.value) || 0;
        // 0 opening stock / 0 value is a valid no-op — skip it entirely, no ItemBatch, no ItemInventory change.
        if (stockNum === 0 && valueNum === 0) return;
        rows.push({
          item,
          warehouse: warehouseByName.get(warehouse.warehouseName),
          stock: stockNum,
          value: valueNum,
        });
      });
    }
  });

  return {
    totalRecords: itemInventory.length,
    validCount: validRecords.length,
    invalidCount: invalidRecords.length,
    invalidRecords,
    validRecords,
    rows,
  };
};

const createBulkItemInventory = async (reqBody, userId) => {
  const { ItemInventory } = getBooksCrmModels();
  const { itemInventory, companyId } = reqBody;

  if (!Array.isArray(itemInventory) || itemInventory.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item inventory array is empty or invalid.');
  }

  // ---- Bail out before creating anything if any record has errors ----
  const validation = await validateBulkItemInventory(itemInventory, companyId);

  if (validation.invalidRecords.length > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Bulk item inventory validation failed.', 0, {
      errors: validation.invalidRecords,
    });
  }

  const { rows } = validation;
  const connection = await getClientConnection();
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    // Items touched in this request — their opening-balance journal is recomputed once at the end.
    const touchedItems = new Map();

    // Zero opening stock / zero value rows are filtered out already — every row here has
    // actual stock and value, so each one gets a batch and an ItemInventory update.
    for (const row of rows) {
      const { item, warehouse, stock, value } = row;
      // `value` is the total opening value for this stock — the per-unit purchase rate is derived from it.
      const inventoryValue = value;
      const purchasePrice = stock > 0 ? Math.round((value / stock) * 1000) / 1000 : 0;

      touchedItems.set(item._id.toString(), item);

      await handleWarehouseStock({
        action: 'addOpeningStockBatch',
        stockData: {
          itemId: item._id,
          companyId,
          branchId: warehouse.branchId,
          divisionId: warehouse.divisionId,
          warehouseId: warehouse._id,
          quantity: stock,
          purchasePrice,
          sourceType: 'OPENING_STOCK',
          sourceId: item._id,
          addedBy: userId,
        },
        session,
      });

      const itemInventoryDoc = await ItemInventory.findOne({ itemId: item._id, companyId }).session(session).lean();

      const warehouseEntry = {
        warehouseId: warehouse._id,
        branchId: warehouse.branchId,
        divisionId: warehouse.divisionId,
        isActive: true,
        openingStock: stock,
        openingStockRate: purchasePrice,
        availableStock: stock,
        inventoryValue,
      };

      if (!itemInventoryDoc) {
        await ItemInventory.create(
          [
            {
              itemId: item._id,
              companyId,
              totalOpeningStock: stock,
              totalAvailableStock: stock,
              totalInventoryValue: inventoryValue,
              warehouses: [warehouseEntry],
              addedBy: userId,
              updatedBy: userId,
            },
          ],
          { session },
        );
        continue;
      }

      const existingWarehouse = itemInventoryDoc.warehouses.find(w => w.warehouseId?.toString() === warehouse._id.toString());

      if (existingWarehouse) {
        // Re-derive openingStockRate as a weighted average so openingStock * openingStockRate
        // keeps matching inventoryValue after this warehouse has received stock more than once.
        const newOpeningStock = (existingWarehouse.openingStock || 0) + stock;
        const newInventoryValue = (existingWarehouse.inventoryValue || 0) + inventoryValue;
        const newOpeningStockRate = newOpeningStock > 0 ? Math.round((newInventoryValue / newOpeningStock) * 1000) / 1000 : 0;

        await ItemInventory.updateOne(
          { _id: itemInventoryDoc._id, 'warehouses.warehouseId': warehouse._id },
          {
            $set: {
              'warehouses.$.openingStock': newOpeningStock,
              'warehouses.$.openingStockRate': newOpeningStockRate,
              // A warehouse receiving opening stock is in use — make sure it isn't left inactive.
              'warehouses.$.isActive': true,
              updatedBy: userId,
            },
            $inc: {
              'warehouses.$.availableStock': stock,
              'warehouses.$.inventoryValue': inventoryValue,
              totalOpeningStock: stock,
              totalAvailableStock: stock,
              totalInventoryValue: inventoryValue,
            },
          },
          { session },
        );
      } else {
        await ItemInventory.updateOne(
          { _id: itemInventoryDoc._id },
          {
            $push: { warehouses: warehouseEntry },
            $set: { updatedBy: userId },
            $inc: {
              totalOpeningStock: stock,
              totalAvailableStock: stock,
              totalInventoryValue: inventoryValue,
            },
          },
          { session },
        );
      }
    }

    // Account effect — same as item creation: Dr Inventory Account / Cr Opening Balance
    // Adjustment for each item's total opening stock value, once per item touched.
    for (const item of touchedItems.values()) {
      const itemInventoryDoc = await ItemInventory.findOne({ itemId: item._id, companyId })
        .select('warehouses')
        .session(session)
        .lean();
      await syncItemOpeningStockJournal(item, itemInventoryDoc?.warehouses, userId, session);
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return { processedCount: rows.length };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const verifyBulkItemInventory = async reqBody => {
  const { itemInventory, companyId } = reqBody;

  if (!Array.isArray(itemInventory) || itemInventory.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item inventory array is empty or invalid.');
  }

  const { rows, ...result } = await validateBulkItemInventory(itemInventory, companyId);
  return result;
};

const ITEM_TRANSACTION_TYPE_CONFIG = {
  Quote: {
    source: 'crm',
    modelName: 'Quote',
    dateField: 'quoteDate',
    refNoField: 'quoteId',
    partyField: 'customerId',
    statuses: Object.values(QUOTE_STATUS),
    excludeSplit: false,
  },
  SalesOrder: {
    source: 'crm',
    modelName: 'SalesOrder',
    dateField: 'orderDate',
    refNoField: 'orderId',
    partyField: 'customerId',
    statuses: Object.values(SALES_ORDER_STATUS),
    excludeSplit: false,
  },
  Invoice: {
    source: 'books',
    modelName: 'Invoice',
    dateField: 'invoiceDate',
    refNoField: 'invoiceId',
    partyField: 'customerId',
    statuses: Object.values(SALES_ORDER_INVOICE_STATUS),
    excludeSplit: true,
  },
  DeliveryChallan: {
    source: 'books',
    modelName: 'DeliveryChallan',
    dateField: 'challanDate',
    refNoField: 'challanId',
    partyField: 'customerId',
    statuses: Object.values(DELIVERY_CHALLAN_STATUS),
    excludeSplit: false,
  },
  CreditNote: {
    source: 'books',
    modelName: 'CreditNote',
    dateField: 'creditNoteDate',
    refNoField: 'creditNoteId',
    partyField: 'customerId',
    statuses: Object.values(CREDIT_NOTE_STATUS),
    excludeSplit: true,
  },
  PurchaseOrder: {
    source: 'books',
    modelName: 'PurchaseOrder',
    dateField: 'date',
    refNoField: 'purchaseOrderId',
    partyField: 'vendor',
    statuses: Object.values(PO_STATUSES),
    excludeSplit: false,
  },
  GrpoOrder: {
    source: 'books',
    modelName: 'GrpoOrder',
    dateField: 'date',
    refNoField: 'grpoOrderId',
    partyField: 'vendor',
    statuses: Object.values(GRPO_STATUSES),
    excludeSplit: false,
  },
  Bill: {
    source: 'books',
    modelName: 'Bill',
    dateField: 'billDate',
    refNoField: 'billId',
    partyField: 'vendor',
    statuses: Object.values(BILL_STATUSES),
    excludeSplit: true,
  },
  DebitNote: {
    source: 'books',
    modelName: 'DebitNote',
    dateField: 'debitNoteDate',
    refNoField: 'debitNoteId',
    partyField: 'vendorId',
    statuses: Object.values(DEBIT_NOTE_STATUS),
    excludeSplit: true,
  },
};

const getItemTransactions = async (itemId, filter, options = {}) => {
  if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid itemId provided');
  }
  if (!filter?.companyId || !mongoose.Types.ObjectId.isValid(filter.companyId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid companyId provided');
  }

  const typeConfig = ITEM_TRANSACTION_TYPE_CONFIG[filter.type];
  if (!typeConfig) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid transaction type');
  }

  if (filter.customerId != null && filter.customerId !== '' && !mongoose.Types.ObjectId.isValid(filter.customerId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid customerId provided');
  }
  if (filter.vendorId != null && filter.vendorId !== '' && !mongoose.Types.ObjectId.isValid(filter.vendorId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid vendorId provided');
  }

  const { Item, Customer } = getBooksCrmModels();
  const itemObjectId = new mongoose.Types.ObjectId(itemId);
  const companyObjectId = new mongoose.Types.ObjectId(filter.companyId);

  const item = await Item.findOne({ _id: itemObjectId, companyId: companyObjectId }).select('_id').lean();
  if (!item) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const models = typeConfig.source === 'crm' ? getBooksCrmModels() : getBooksModels();
  const Model = models[typeConfig.modelName];
  if (!Model) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Model ${typeConfig.modelName} not available`);
  }

  const query = {
    companyId: companyObjectId,
    'items.itemId': itemObjectId,
  };

  if (typeConfig.excludeSplit) {
    query.isSplit = { $ne: true };
  }

  const partyId = filter.vendorId || filter.customerId;
  if (partyId) {
    query[typeConfig.partyField] = new mongoose.Types.ObjectId(partyId);
  }

  const statusValue = filter.status && String(filter.status).trim();
  if (statusValue && statusValue.toLowerCase() !== 'all') {
    const statusArray = statusValue
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (statusArray.length === 1) {
      query.status = statusArray[0];
    } else if (statusArray.length > 1) {
      query.status = { $in: statusArray };
    }
  }

  const page = Math.max(parseInt(options.page, 10) || 1, 1);
  const limit = Math.max(parseInt(options.limit, 10) || 10, 1);
  const partyField = typeConfig.partyField;

  const paginateOptions = {
    page,
    limit,
    sortBy: `${typeConfig.dateField}:desc`,
    select: `${typeConfig.refNoField} ${typeConfig.dateField} status ${partyField} currency items.itemId items.quantity items.rate items.amount`,
  };

  const paginated = await Model.paginate(query, paginateOptions);
  const docs = (paginated.results || []).map(doc => (doc.toObject ? doc.toObject() : doc));
  const totalResults = paginated.totalResults || 0;

  const partyIds = [...new Set(docs.map(d => d[partyField]?.toString()).filter(Boolean))];
  const currencyIds = [...new Set(docs.map(d => d.currency?.toString()).filter(Boolean))];

  const [parties, currencyMasters] = await Promise.all([
    partyIds.length
      ? Customer.find({ _id: { $in: partyIds } })
          .select('customerDisplayName companyName')
          .lean()
      : Promise.resolve([]),
    currencyIds.length ? getCurrency(companyObjectId, currencyIds) : Promise.resolve([]),
  ]);

  const partyMap = new Map(parties.map(c => [c._id.toString(), c.customerDisplayName || c.companyName || '']));
  const currencySymbolMap = new Map(currencyMasters.map(c => [c._id.toString(), c.symbol]));
  const itemIdStr = itemObjectId.toString();

  const results = docs.map(doc => {
    const matchingLines = (doc.items || []).filter(line => line.itemId?.toString() === itemIdStr);
    const quantity = matchingLines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
    const amount = matchingLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
    let rate = 0;
    if (matchingLines.length === 1) {
      rate = Number(matchingLines[0].rate) || 0;
    } else if (matchingLines.length > 1) {
      rate = quantity > 0 ? amount / quantity : Number(matchingLines[0].rate) || 0;
    }
    const partyIdStr = doc[partyField]?.toString() || null;
    const docCurrencyId = doc.currency?.toString();

    return {
      id: doc._id?.toString(),
      type: filter.type,
      refNo: doc[typeConfig.refNoField] || null,
      date: doc[typeConfig.dateField] || null,
      status: doc.status || null,
      customerId: partyIdStr,
      customerName: partyIdStr ? partyMap.get(partyIdStr) || '' : '',
      quantity,
      rate,
      amount,
      currencySymbol: (docCurrencyId && currencySymbolMap.get(docCurrencyId)) || null,
    };
  });

  return {
    results,
    page: paginated.page || page,
    limit: paginated.limit || limit,
    totalPages: paginated.totalPages || Math.ceil(totalResults / limit) || 1,
    totalResults,
    statuses: ['All', ...typeConfig.statuses],
    type: filter.type,
  };
};

module.exports = {
  createItem: withTransientRetry(createItem),
  queryItems,
  viewItem,
  getItemsForDropdown,
  getFgBomBasedItemsDropdown,
  getItemById,
  getItemInventoryStatus,
  getItemInventoryDetails,
  getItemInventoryBatches,
  getItemInventoryBatchById,
  updateItemById,
  deleteItemById,
  updateItemStock,
  getStockMovements,
  getBranchStock,
  addItemStock,
  adjustStock,
  createBulkItems,
  verifyBulkItemCreation,
  getProductionDataByItemId,
  queryItemsExports,
  itembomBasedDropdown,
  itemHistory,
  getItemTransactions,
  getAvailableStock,
  updateStatus,
  exportInventoryStock,
  getItemsUsingRawMaterial,
  createProductionData,
  getPendingPurchaseOrderQty,
  createBulkItemInventory,
  verifyBulkItemInventory,
  ITEM_BATCH_POPULATE,
  ITEM_BATCH_DETAILS_POPULATE,
  enrichBatchesWithDocNo,
  getConvertedStockDetails,
  getItemUnitConversions,
  buildItemBatchDetails,
  populateAuditUsers,
};
