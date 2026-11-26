const httpStatus = require('http-status');
const pick = require('../../../utils/pick');
const catchAsync = require('../../../utils/catchAsync');
const itemService = require('./item.service');
const itemLedgerService = require('./itemLedger.service');
const { successResponse } = require('../../../services/response.service');
const { ITEM_MESSAGES } = require('../../../utils/messages');
const { getUploadedFiles, getRequestBody } = require('../../../utils/fileUploadHelper');
const itemTransformers = require('./item.transformer');

const createItem = catchAsync(
  async (req, res) => {
    const itemBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const uploadedPurchasingDataFiles = getUploadedFiles(req, 'purchasingData.attachment');
    const uploadedSalesDataFiles = getUploadedFiles(req, 'salesData.attachment');
    const item = await itemService.createItem(
      { ...itemBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
      uploadedPurchasingDataFiles,
      uploadedSalesDataFiles,
    );
    return successResponse(res, item, ITEM_MESSAGES.CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createItem',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const createBulkItems = catchAsync(
  async (req, res) => {
    const item = await itemService.createBulkItems({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, item, ITEM_MESSAGES.BULK_CREATE_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createBulkItems',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.BULK_CREATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const verifyBulkItemCreation = catchAsync(
  async (req, res) => {
    const result = await itemService.verifyBulkItemCreation({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, result, ITEM_MESSAGES.BULK_VERIFY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'verifyBulkItemCreation',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.BULK_VERIFY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItems = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'itemType',
      'itemGroup',
      'itemStatus',
      'status',
      'startDate',
      'endDate',
      'itemDate',
      'appName',
      'category',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await itemService.queryItems(req.query, filter, options);
    const { results, ...otherFields } = result;
    const transformedResults = itemTransformers.queryItems(results);
    return successResponse(res, transformedResults, ITEM_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'queryItems',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemsExports = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'itemType',
      'itemGroup',
      'subItemGroup',
      'itemStatus',
      'status',
      'startDate',
      'endDate',
      'itemDate',
      'appName',
      'category',
    ]);
    const result = await itemService.queryItemsExports(req.query, filter);
    const transformedResults = itemTransformers.queryItems(result);
    return successResponse(res, transformedResults, ITEM_MESSAGES.FETCH_ALL_SUCCESS, httpStatus.OK);
  },
  {
    service: 'queryItemsExports',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_ALL_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemsDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'itemGroup',
      'itemType',
      'isService',
      'warehouseId',
      'itemStatus',
      'trackInventory',
      'isSellable',
      'isPurchasable',
      'priceListId',
      'customerId',
      'includeZeroInventory',
      'includeInactive',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await itemService.getItemsForDropdown(req.query, filter, options);
    return successResponse(res, result, ITEM_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemsForDropdown',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getFgBomBasedDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'itemStatus']);
    const result = await itemService.getFgBomBasedItemsDropdown(filter);
    return successResponse(res, result, ITEM_MESSAGES.FETCH_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getFgBomBasedItemsDropdown',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_DROPDOWN_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItem = catchAsync(
  async (req, res) => {
    const item = await itemService.getItemById(req.params.itemId, req.query.companyId);
    return successResponse(res, item, ITEM_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemById',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemInventoryStatus = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'itemId',
      'warehouseId',
      'branchId',
      'divisionId',
      'includeZeroInventory',
      'includeBatches',
      'includeMovements',
      'fromDate',
      'toDate',
      'itemIds',
      'itemType',
      'itemGroup',
      'itemStatus',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await itemService.getItemInventoryStatus(req.query, filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, ITEM_MESSAGES.FETCH_INVENTORY_STATUS_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getItemInventoryStatus',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_INVENTORY_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemInventoryDetails = catchAsync(
  async (req, res) => {
    const { itemId } = req.params;
    const { companyId } = req.query;
    const result = await itemService.getItemInventoryDetails(itemId, companyId);
    return successResponse(res, result, ITEM_MESSAGES.FETCH_INVENTORY_DETAILS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemInventoryDetails',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_INVENTORY_DETAILS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemInventoryBatches = catchAsync(
  async (req, res) => {
    const { itemId } = req.params;
    const { companyId } = req.query;
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await itemService.getItemInventoryBatches(itemId, companyId, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, ITEM_MESSAGES.FETCH_INVENTORY_BATCHES_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'getItemInventoryBatches',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_INVENTORY_BATCHES_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemInventoryBatchById = catchAsync(
  async (req, res) => {
    const { itemId, batchId } = req.params;
    const { companyId } = req.query;
    const result = await itemService.getItemInventoryBatchById(itemId, batchId, companyId);
    return successResponse(res, result, ITEM_MESSAGES.FETCH_INVENTORY_BATCH_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemInventoryBatchById',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_INVENTORY_BATCH_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateItem = catchAsync(
  async (req, res) => {
    const itemBody = getRequestBody(req);
    const uploadedFiles = getUploadedFiles(req, 'attachment');
    const uploadedPurchasingDataFiles = getUploadedFiles(req, 'purchasingData.attachment');
    const uploadedSalesDataFiles = getUploadedFiles(req, 'salesData.attachment');
    const item = await itemService.updateItemById(
      req.params.itemId,
      { ...itemBody, companyId: req.query.companyId },
      req.user._id,
      uploadedFiles,
      uploadedPurchasingDataFiles,
      uploadedSalesDataFiles,
    );
    return successResponse(res, item, ITEM_MESSAGES.UPDATE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateItemById',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.UPDATE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const deleteItem = catchAsync(
  async (req, res) => {
    await itemService.deleteItemById(req.params.itemId, req.query.companyId);
    return successResponse(res, {}, ITEM_MESSAGES.DELETE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'deleteItemById',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.DELETE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const addItemStock = catchAsync(
  async (req, res) => {
    const { itemId, divisionId, branchId, warehouseId, quantity, referenceNumber, notes, price } = req.body;
    const userId = req.user._id;
    const companyId = req.query?.companyId;
    await itemService.addItemStock(
      { itemId, companyId, divisionId, branchId, warehouseId, quantity, referenceNumber, notes, price },
      userId,
      companyId,
    );
    return successResponse(res, {}, ITEM_MESSAGES.ADD_STOCK_SUCCESS, httpStatus.OK);
  },
  {
    service: 'addItemStock',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.ADD_STOCK_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getProductionData = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'itemId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await itemService.getProductionDataByItemId(req.query, filter, options);
    return successResponse(res, result, ITEM_MESSAGES.FETCH_PRODUCTION_DATA_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getProductionDataByItemId',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_PRODUCTION_DATA_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const itembomBasedDropdown = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'itemStatus']);
    const result = await itemService.itembomBasedDropdown(req.query, filter);
    return successResponse(res, result, ITEM_MESSAGES.BOM_DROPDOWN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'itembomBasedDropdown',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.BOM_DROPDOWN_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const itemHistory = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'itemId',
      'startDate',
      'endDate',
      'warehouseId',
      'branchId',
      'divisionId',
      'companyId',
      'search',
      'itemStatus',
      'isSplit',
      'splitOnly',
    ]);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await itemService.itemHistory(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, ITEM_MESSAGES.ITEM_HISTORY_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'itemHistory',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.ITEM_HISTORY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const itemLedger = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['itemId', 'startDate', 'endDate', 'warehouseId', 'branchId', 'divisionId', 'companyId']);
    const options = pick(req.query, ['sortBy', 'limit', 'page', 'pagination']);
    const result = await itemLedgerService.itemLedger(filter, options);
    const { results, ...otherFields } = result;
    return successResponse(res, results, ITEM_MESSAGES.ITEM_HISTORY_SUCCESS, httpStatus.OK, otherFields);
  },
  {
    service: 'itemLedger',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.ITEM_HISTORY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemTransactions = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'type', 'status', 'customerId', 'vendorId']);
    const options = pick(req.query, ['limit', 'page']);
    const result = await itemService.getItemTransactions(req.params.itemId, filter, options);
    const { results, statuses, type, ...otherFields } = result;
    return successResponse(
      res,
      itemTransformers.itemTransactions(results),
      ITEM_MESSAGES.ITEM_TRANSACTIONS_SUCCESS,
      httpStatus.OK,
      {
        ...otherFields,
        statuses,
        type,
      },
    );
  },
  {
    service: 'getItemTransactions',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.ITEM_TRANSACTIONS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getAvailableStock = catchAsync(
  async (req, res) => {
    const result = await itemService.getAvailableStock(req.query);
    return successResponse(res, result, ITEM_MESSAGES.AVAILABLE_STOCK_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getAvailableStock',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.AVAILABLE_STOCK_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const updateStatus = catchAsync(
  async (req, res) => {
    const { isActive, companyId } = req.query;
    const { itemId } = req.params;
    const item = await itemService.updateStatus(itemId, isActive, companyId);
    return successResponse(res, item, ITEM_MESSAGES.UPDATE_ITEM_STATUS_SUCCESS, httpStatus.OK);
  },
  {
    service: 'updateStatus',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.UPDATE_ITEM_STATUS_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getItemsUsedIn = catchAsync(
  async (req, res) => {
    const { itemId, companyId } = req.query;
    const result = await itemService.getItemsUsingRawMaterial(itemId, companyId);
    return successResponse(res, result, ITEM_MESSAGES.GET_ITEMS_USED_IN_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getItemsUsingRawMaterial',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.GET_ITEMS_USED_IN_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const exportInventoryStock = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, [
      'companyId',
      'itemId',
      'warehouseId',
      'branchId',
      'divisionId',
      'includeZeroInventory',
      'includeBatches',
      'includeMovements',
      'fromDate',
      'toDate',
      'itemIds',
      'itemType',
      'itemGroup',
      'itemStatus',
    ]);
    const options = pick(req.query, ['sortBy']);
    const result = await itemService.exportInventoryStock(req.query, filter, options);
    return successResponse(res, result, ITEM_MESSAGES.EXPORT_INVENTORY_STOCK_SUCCESS, httpStatus.OK);
  },
  {
    service: 'exportInventoryStock',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.EXPORT_INVENTORY_STOCK_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const createProductionData = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const productionData = await itemService.createProductionData(req.params.id, req.body, filter, req.user._id);
    return successResponse(res, productionData, ITEM_MESSAGES.CREATE_PRODUCTION_DATA_SUCCESS, httpStatus.CREATED);
  },
  {
    service: 'createProductionData',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.CREATE_PRODUCTION_DATA_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const viewItem = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId']);
    const item = await itemService.viewItem(req.params.itemId, filter);
    const transformedItem = itemTransformers.viewItem(item);
    return successResponse(res, transformedItem, ITEM_MESSAGES.FETCH_ONE_SUCCESS, httpStatus.OK);
  },
  {
    service: 'viewItem',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.FETCH_ONE_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const getPendingPurchaseOrderQty = catchAsync(
  async (req, res) => {
    const filter = pick(req.query, ['companyId', 'itemId']);
    const result = await itemService.getPendingPurchaseOrderQty(filter);
    return successResponse(res, result, ITEM_MESSAGES.PENDING_PURCHASE_ORDER_QTY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'getPendingPurchaseOrderQty',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.PENDING_PURCHASE_ORDER_QTY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const createBulkItemInventory = catchAsync(
  async (req, res) => {
    const result = await itemService.createBulkItemInventory({ ...req.body, companyId: req.query.companyId }, req.user._id);
    return successResponse(res, result, ITEM_MESSAGES.UPDATE_ITEM_INVENTORY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'createBulkItemInventory',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.UPDATE_ITEM_INVENTORY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

const verifyBulkItemInventory = catchAsync(
  async (req, res) => {
    const result = await itemService.verifyBulkItemInventory({ ...req.body, companyId: req.query.companyId });
    return successResponse(res, result, ITEM_MESSAGES.BULK_ITEM_INVENTORY_VERIFY_SUCCESS, httpStatus.OK);
  },
  {
    service: 'verifyBulkItemInventory',
    controller: 'item',
    failureMessage: ITEM_MESSAGES.BULK_ITEM_INVENTORY_VERIFY_FAILURE,
    failureStatus: httpStatus.BAD_REQUEST,
  },
);

module.exports = {
  createItem,
  getItems,
  getItem,
  viewItem,
  getItemsDropdown,
  getFgBomBasedDropdown,
  getItemInventoryStatus,
  getItemInventoryDetails,
  getItemInventoryBatches,
  getItemInventoryBatchById,
  updateItem,
  deleteItem,
  addItemStock,
  createBulkItems,
  verifyBulkItemCreation,
  getProductionData,
  getItemsExports,
  itembomBasedDropdown,
  itemHistory,
  itemLedger,
  getItemTransactions,
  getAvailableStock,
  updateStatus,
  exportInventoryStock,
  getItemsUsedIn,
  createProductionData,
  getPendingPurchaseOrderQty,
  createBulkItemInventory,
  verifyBulkItemInventory,
};
