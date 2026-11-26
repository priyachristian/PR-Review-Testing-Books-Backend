const { getBooksModels, getBooksCrmModels } = require('./model.service');

const CRM_ITEMLINE_MODELS = ['Quote', 'SalesOrder', 'PriceList'];
const BOOKS_ITEMLINE_MODELS = [
  'Invoice',
  'DeliveryChallan',
  'CreditNote',
  'RecurringInvoice',
  'Bill',
  'GrpoOrder',
  'PurchaseOrder',
  'DebitNote',
  'CustomerOrder',
  'InventoryAdjustment',
];

const ITEM_OWNED_CRM_MODELS = ['ItemInventory', 'ItemBatch', 'ItemHistory'];
const ITEM_OWNED_BOOKS_MODELS = ['InventoryLogs'];

const existsCheck = (Model, filter) => (Model ? Model.exists(filter) : Promise.resolve(false));

const productionOrderItemFilter = (companyId, idMatch) => ({
  companyId,
  $or: [
    { itemId: idMatch },
    { 'rawMaterials.rawMaterialId': idMatch },
    { 'processBased.processes.processRawMaterialInput.item': idMatch },
    { 'processBased.processes.scrapOutProcess.item': idMatch },
    { 'submissionHistory.rawMaterialsConsumed.rawMaterialId': idMatch },
  ],
});

const itemsInUse = async (itemIds, companyId) => {
  if (!itemIds || !itemIds.length) return false;
  const crm = getBooksCrmModels();
  const books = getBooksModels();
  const idIn = { $in: itemIds };

  const checks = [
    ...CRM_ITEMLINE_MODELS.map(name => existsCheck(crm[name], { companyId, 'items.itemId': idIn })),
    ...BOOKS_ITEMLINE_MODELS.map(name => existsCheck(books[name], { companyId, 'items.itemId': idIn })),
    existsCheck(books.RecurringBills, { companyId, $or: [{ 'items.itemId': idIn }, { 'inventoryConfig.items.itemId': idIn }] }),
    existsCheck(books.InventoryTransferRequest, { companyId, $or: [{ itemId: idIn }, { 'rawMaterials.rawMaterialId': idIn }] }),
    existsCheck(books.ProductionOrder, productionOrderItemFilter(companyId, idIn)),
    existsCheck(books.RejectionOrder, {
      companyId,
      $or: [{ 'items.itemId': idIn }, { 'items.componentRecoveries.componentItemId': idIn }],
    }),
    existsCheck(crm.Item, {
      companyId,
      _id: { $nin: itemIds },
      $or: [{ 'productionData.bomBased.item': idIn }, { 'productionData.productionScrapOutInventory.scrapItemName': idIn }],
    }),
    existsCheck(crm.IncentiveScheme, { companyId, 'docTypes.items': idIn }),
  ];

  const results = await Promise.all(checks);
  return results.some(Boolean);
};

const cleanupItemOwnedRecords = async (itemIds, companyId, session = null) => {
  if (!itemIds || !itemIds.length) return;
  const crm = getBooksCrmModels();
  const books = getBooksModels();
  const idIn = { $in: itemIds };
  const options = { session };

  const models = [...ITEM_OWNED_CRM_MODELS.map(name => crm[name]), ...ITEM_OWNED_BOOKS_MODELS.map(name => books[name])];

  for (const Model of models) {
    if (Model) await Model.deleteMany({ itemId: idIn, companyId }, options);
  }
};

const itemHasBatchOrProductionOrder = async (itemId, companyId, session = null) => {
  const booksCrm = getBooksCrmModels();
  const books = getBooksModels();

  const batchQuery = booksCrm.ItemBatch.exists({ companyId, itemId });
  const productionQuery = books.ProductionOrder.exists(productionOrderItemFilter(companyId, itemId));
  if (session) {
    batchQuery.session(session);
    productionQuery.session(session);
  }

  const [hasBatch, inProduction] = await Promise.all([batchQuery, productionQuery]);
  return Boolean(hasBatch || inProduction);
};

module.exports = { itemsInUse, cleanupItemOwnedRecords, itemHasBatchOrProductionOrder };
