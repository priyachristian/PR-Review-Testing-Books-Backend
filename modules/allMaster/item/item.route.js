const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const itemValidation = require('./item.validation');
const itemController = require('./item.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight, checkReportRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS, REPORT_LIST, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');
const { multipleAttachmentUploadFields, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const parseFormData = require('../../../middlewares/parseFormData');
const { checkSubscription } = require('../../../middlewares/checkSubscription');

const router = express.Router();

const uploadFields = multipleAttachmentUploadFields([
  { name: 'purchasingData.attachment', maxCount: ATTACHMENT_MAX_COUNT },
  { name: 'salesData.attachment', maxCount: ATTACHMENT_MAX_COUNT },
  { name: 'attachment', maxCount: ATTACHMENT_MAX_COUNT },
]);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.ITEM),
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.CREATE),
    validate(itemValidation.createItem),
    itemController.createItem,
  )
  .get(checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.VIEW), validate(itemValidation.getItems), itemController.getItems);

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.VIEW),
    validate(itemValidation.getItemsExports),
    itemController.getItemsExports,
  );

router.route('/dropdown').get(validate(itemValidation.dropdown), itemController.getItemsDropdown);

router.route('/dropdown/fg-bom-based').get(validate(itemValidation.fgBomBasedDropdown), itemController.getFgBomBasedDropdown);

router
  .route('/item-history')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.ITEM_LEDGER, RIGHTS.VIEW),
    validate(itemValidation.itemHistory),
    itemController.itemHistory,
  );

router
  .route('/item-ledger')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.VIEW),
    checkReportRight(REPORT_LIST.ITEM_LEDGER, RIGHTS.VIEW),
    validate(itemValidation.itemLedger),
    itemController.itemLedger,
  );

router
  .route('/bulk/item-inventory')
  .post(
    checkRoleRight(RIGHT_LIST.ADD_INVENTORY, RIGHTS.EDIT),
    validate(itemValidation.createBulkItemInventory),
    itemController.createBulkItemInventory,
  );

router
  .route('/bulk/item-inventory/verify')
  .post(
    checkRoleRight(RIGHT_LIST.ADD_INVENTORY, RIGHTS.EDIT),
    validate(itemValidation.verifyBulkItemInventory),
    itemController.verifyBulkItemInventory,
  );

router
  .route('/bulk')
  .post(
    checkSubscription(PLAN_FEATURES.ITEM),
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.CREATE),
    validate(itemValidation.createBulkItems),
    itemController.createBulkItems,
  );

router
  .route('/bulk/verify')
  .post(
    checkSubscription(PLAN_FEATURES.ITEM),
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.CREATE),
    validate(itemValidation.verifyBulkItemCreation),
    itemController.verifyBulkItemCreation,
  );

router
  .route('/inventory-stock')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(itemValidation.getItemInventoryStatus),
    itemController.getItemInventoryStatus,
  );

router
  .route('/export-inventory-stock')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(itemValidation.getItemInventoryStatus),
    itemController.exportInventoryStock,
  );

router.route('/available-stock').get(validate(itemValidation.getAvailableStock), itemController.getAvailableStock);

router
  .route('/pending-purchase-order-qty')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(itemValidation.getPendingPurchaseOrderQty),
    itemController.getPendingPurchaseOrderQty,
  );

router
  .route('/add-stock')
  .post(
    checkRoleRight(RIGHT_LIST.ADD_INVENTORY, RIGHTS.EDIT),
    validate(itemValidation.addItemStock),
    itemController.addItemStock,
  );

router.route('/get-production-data').get(validate(itemValidation.getProductionData), itemController.getProductionData);

router.route('/get-bombased-dropdown').get(validate(itemValidation.bomBasedDropdown), itemController.itembomBasedDropdown);

router
  .route('/used-in')
  .get(checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.VIEW), validate(itemValidation.getUsedIn), itemController.getItemsUsedIn);

router
  .route('/:itemId/transactions')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.VIEW),
    validate(itemValidation.itemTransactions),
    itemController.getItemTransactions,
  );

router
  .route('/:itemId/inventory-details')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(itemValidation.getItemInventoryDetails),
    itemController.getItemInventoryDetails,
  );

router
  .route('/:itemId/inventory-details/batches')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(itemValidation.getItemInventoryBatches),
    itemController.getItemInventoryBatches,
  );

router
  .route('/:itemId/inventory-details/batches/:batchId')
  .get(
    checkRoleRight(RIGHT_LIST.VIEW_INVENTORY, RIGHTS.VIEW),
    validate(itemValidation.getItemInventoryBatchById),
    itemController.getItemInventoryBatchById,
  );

router.put(
  '/updateStatus/:itemId',
  checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.EDIT),
  validate(itemValidation.updateStatus),
  itemController.updateStatus,
);

router
  .route('/:itemId')
  .get(checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.VIEW), validate(itemValidation.getItem), itemController.getItem)
  .delete(checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.DELETE), validate(itemValidation.deleteItem), itemController.deleteItem)
  .put(
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(itemValidation.updateItem),
    itemController.updateItem,
  );

router
  .route('/production-data/:id')
  .post(
    checkRoleRight(RIGHT_LIST.ITEM_MASTER, RIGHTS.EDIT),
    validate(itemValidation.createProductionDataSchema),
    itemController.createProductionData,
  );

router.route('/viewItem/:itemId').get(validate(itemValidation.getItem), itemController.viewItem);

module.exports = router;
