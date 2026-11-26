const { getBooksModels, getBooksCrmModels } = require('./model.service');

const WAREHOUSE_CRM_MODELS = ['ItemBatch', 'ItemHistory', 'PaymentReceived', 'SalesOrder', 'Quote'];
const WAREHOUSE_BOOKS_MODELS = [
  'Invoice',
  'Bill',
  'DeliveryChallan',
  'GrpoOrder',
  'PurchaseOrder',
  'CreditNote',
  'DebitNote',
  'RecurringInvoice',
  'RecurringBills',
  'Expenses',
  'RecurringExpense',
  'PaymentMade',
  'ManualJournal',
  'Stock',
  'InventoryLogs',
  'InventoryAdjustment',
  'RejectionOrder',
];

const BRANCH_CRM_MODELS = ['ItemBatch', 'ItemHistory', 'PaymentReceived', 'SalesOrder', 'Quote', 'OpeningBalanceTransaction'];
const BRANCH_BOOKS_MODELS = [
  'Invoice',
  'Bill',
  'DeliveryChallan',
  'GrpoOrder',
  'PurchaseOrder',
  'CreditNote',
  'DebitNote',
  'RecurringInvoice',
  'RecurringBills',
  'Expenses',
  'RecurringExpense',
  'PaymentMade',
  'ManualJournal',
  'LedgerEntry',
  'Account',
  'Stock',
  'InventoryLogs',
  'InventoryAdjustment',
  'RejectionOrder',
  'ProductionOrder',
];

const DIVISION_CRM_MODELS = ['ItemBatch', 'ItemHistory', 'PaymentReceived', 'SalesOrder', 'Quote'];
const DIVISION_BOOKS_MODELS = BRANCH_BOOKS_MODELS;

const existsChecks = (modelMap, modelNames, filter) =>
  modelNames.map(name => {
    const Model = modelMap[name];
    return Model ? Model.exists(filter) : Promise.resolve(false);
  });

const anyReference = async promises => {
  const results = await Promise.all(promises);
  return results.some(Boolean);
};

const warehousesInUse = async (warehouseIds, companyId) => {
  if (!warehouseIds || !warehouseIds.length) return false;
  const crm = getBooksCrmModels();
  const books = getBooksModels();
  const idIn = { $in: warehouseIds };

  const checks = [
    ...existsChecks(crm, WAREHOUSE_CRM_MODELS, { warehouseId: idIn, companyId }),
    ...existsChecks(books, WAREHOUSE_BOOKS_MODELS, { warehouseId: idIn, companyId }),
    books.InventoryTransferRequest
      ? books.InventoryTransferRequest.exists({ companyId, $or: [{ fromWarehouseId: idIn }, { toWarehouseId: idIn }] })
      : Promise.resolve(false),
    books.ProductionOrder
      ? books.ProductionOrder.exists({
          companyId,
          $or: [
            { warehouseId: idIn },
            { dispatchWarehouseId: idIn },
            { inventoryInwarehouseId: idIn },
            { inStockWarehouseId: idIn },
            { productionWarehouseId: idIn },
          ],
        })
      : Promise.resolve(false),
  ];

  return anyReference(checks);
};

const branchesInUse = async (branchIds, companyId) => {
  if (!branchIds || !branchIds.length) return false;
  const crm = getBooksCrmModels();
  const books = getBooksModels();
  const idIn = { $in: branchIds };

  const checks = [
    ...existsChecks(crm, BRANCH_CRM_MODELS, { branchId: idIn, companyId }),
    ...existsChecks(books, BRANCH_BOOKS_MODELS, { branchId: idIn, companyId }),
  ];

  return anyReference(checks);
};

const divisionsInUse = async (divisionIds, companyId) => {
  if (!divisionIds || !divisionIds.length) return false;
  const crm = getBooksCrmModels();
  const books = getBooksModels();
  const idIn = { $in: divisionIds };

  const checks = [
    ...existsChecks(crm, DIVISION_CRM_MODELS, { divisionId: idIn, companyId }),
    ...existsChecks(books, DIVISION_BOOKS_MODELS, { divisionId: idIn, companyId }),
  ];

  return anyReference(checks);
};

module.exports = { warehousesInUse, branchesInUse, divisionsInUse };
