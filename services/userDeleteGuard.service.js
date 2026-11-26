const { getBooksModels, getBooksCrmModels } = require('./model.service');

const BOOKS_ADDED_BY_MODELS = [
  'Account',
  'AccountLedger',
  'AccountOpeningBalance',
  'Bill',
  'CreditNote',
  'DebitNote',
  'DeliveryChallan',
  'Expenses',
  'GrpoOrder',
  'Gst',
  'InventoryTransferRequest',
  'Invoice',
  'InvoiceDispatch',
  'LedgerEntry',
  'ManualJournal',
  'PaymentMade',
  'Process',
  'PurchaseOrder',
  'QualityMaster',
  'Recipe',
  'RecurringBills',
  'RecurringExpense',
  'RecurringInvoice',
  'RejectionOrder',
  'RejectionReason',
  'TransportCourier',
];

const BOOKS_CREATED_BY_MODELS = [
  'DevelopmentUpdate',
  'GeneralSalesAnalytics',
  'InventoryAdjustment',
  'InventoryLogs',
  'ProductionOrder',
];

const BOOKS_CRM_ADDED_BY_MODELS = [
  'Branch',
  'Customer',
  'Division',
  'Item',
  'ItemBatch',
  'ItemInventory',
  'ItemUnit',
  'PaymentReceived',
  'Quote',
  'SalesOrder',
  'Warehouse',
];

const BOOKS_CRM_CREATED_BY_MODELS = ['IncentiveScheme', 'SalesOrderTag'];

const existsCheck = (Model, filter) => (Model ? Model.exists(filter) : Promise.resolve(false));

const userHasCreatedDocs = async (userId, companyId) => {
  if (!userId || !companyId) return false;
  const books = getBooksModels();
  const crm = getBooksCrmModels();

  const checks = [
    ...BOOKS_ADDED_BY_MODELS.map(name => existsCheck(books[name], { companyId, addedBy: userId })),
    ...BOOKS_CREATED_BY_MODELS.map(name => existsCheck(books[name], { companyId, createdBy: userId })),
    ...BOOKS_CRM_ADDED_BY_MODELS.map(name => existsCheck(crm[name], { companyId, addedBy: userId })),
    ...BOOKS_CRM_CREATED_BY_MODELS.map(name => existsCheck(crm[name], { companyId, createdBy: userId })),
    existsCheck(books.CustomerOrder, { companyId, addedBy: userId, addedByType: 'User' }),
  ];

  const results = await Promise.all(checks);
  return results.some(Boolean);
};

module.exports = { userHasCreatedDocs };
