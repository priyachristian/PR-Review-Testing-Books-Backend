const {
  TAX_TYPES,
  BANK_TYPES,
  PAYMENT_TERMS,
  PAYMENT_MODES,
  DEPOSIT_TYPES,
  REPEAT_PERIODS,
  EXPENSEACCOUNTS,
  PAIDTHROUGHOPTIONS,
  ACCOUNT_TYPES,
  SOURCE_TYPES,
  QUOTE_STATUS,
  DELIVERY_CHALLAN_STATUS,
  REJECTION_ORDER_STATUS,
  REJECTION_CONVERT_TYPE,
  SALES_ORDER_INVOICE_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  BILL_STATUSES,
  CREDIT_NOTE_STATUS,
  DEBIT_NOTE_STATUS,
  INVENTORY_TRANSFER_REQUEST,
  COMPANY_FEATURES,
  PRODUCTION_ORDER_STATUS,
  PROCESS_STATUS,
  PRODUCTION_ORDER_ACTIVITY_TYPE,
  PRODUCTION_ORDER_INVENTORY_EVENT_TYPE,
  CREDIT_NOTE_TYPE,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  CHEQUE_STATUS,
  REPORTING_METHODS,
  STOCK_UPDATE_REASONS,
  GENERAL_SALES_ANALYTICS_BASIS,
  GENERAL_SALES_ANALYTICS_MODULES,
  LEDGER_SOURCE_MODULES,
  LEDGER_PARTY_TYPES,
  SYSTEM_ACCOUNT_KEYS,
  BALANCE_TYPES,
  COA_ACCOUNT_TYPES,
  ACCOUNT_CATEGORIES,
  PAYMENT_ACCOUNT_CATEGORIES,
  BANK_TYPE_BY_ACCOUNT_CATEGORY,
  ACCOUNT_CATEGORY_BY_BANK_TYPE,
  SUBSCRIPTION_STATUS,
  ITEM_BATCH_SOURCE_TYPE,
  ITEM_BATCH_DEDUCTED_SOURCE_TYPE,
  PLAN_FEATURES,
} = require('@smit9313/abss-models-core/src/utils/enum');

const MODULE_NAMES = {
  ITEM: 'ITEM',
  QUOTATION: 'QUOTATION',
  SALES_ORDER: 'SALES_ORDER',
  DELIVERY_CHALLAN: 'DELIVERY_CHALLAN',
  INVOICE: 'INVOICE',
  PRODUCTION_ORDER: 'PRODUCTION_ORDER',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  CREDIT_NOTE: 'CREDIT_NOTE',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  GRPO: 'GRPO',
  BILL: 'BILL',
  PAYMENT_MADE: 'PAYMENT_MADE',
  DEBIT_NOTE: 'DEBIT_NOTE',
  EXPENSE: 'EXPENSE',
  SPLIT_BILL: 'SPLIT_BILL',
  SPLIT_INVOICE: 'SPLIT_INVOICE',
  SPLIT_PAYMENT_RECEIVED: 'SPLIT_PAYMENT_RECEIVED',
  SPLIT_PAYMENT_MADE: 'SPLIT_PAYMENT_MADE',
  SPLIT_CREDIT_NOTE: 'SPLIT_CREDIT_NOTE',
  SPLIT_DEBIT_NOTE: 'SPLIT_DEBIT_NOTE',
  RECURRING_INVOICE: 'RECURRING_INVOICE',
  RECURRING_BILL: 'RECURRING_BILL',
  RECURRING_EXPENSE: 'RECURRING_EXPENSE',
  ACCOUNT_PARTNER: 'ACCOUNT_PARTNER',
  MANUAL_JOURNAL: 'MANUAL_JOURNAL',
  INVENTORY_ADJUSTMENT: 'INVENTORY_ADJUSTMENT',
  CUSTOMER: 'CUSTOMER',
  VENDOR: 'VENDOR',
  QUALITY_MASTER: 'QUALITY_MASTER',
  PROCESS: 'PROCESS',
  RECIPE: 'RECIPE',
  PRICE_LIST: 'PRICE_LIST',
  MANPOWER: 'MANPOWER',
  PRODUCTION_ORDER: 'PRODUCTION_ORDER',
  ITEMGROUP: 'ITEMGROUP',
  SALES_ORDER_TAG: 'SALES_ORDER_TAG',
  CUSTOMER_ORDER: 'CUSTOMER_ORDER',
  SAMPLE_CATALOG: 'SAMPLE_CATALOG',
  REJECTION_ORDER: 'REJECTION_ORDER',
  REJECTION_REASON: 'REJECTION_REASON',
  PROBLEM_LIST: 'PROBLEM_LIST',
  COMPLAINTS: 'COMPLAINTS',
  COMPLAINTS_REPORTS: 'COMPLAINTS_REPORTS',
  DISPATCH: 'DISPATCH',
  MACHINE: 'MACHINE',
  MAINTENANCE_REQUEST: 'MAINTENANCE_REQUEST',
  SPARE_PART: 'SPARE_PART',
};

const HARD_HIDDEN_PLAN_FEATURES = ['INCENTIVE', 'REJECTION_ORDER', 'COMPLAINTS', 'CUSTOMER_ORDER', 'MACHINE_MAINTENANCE'];

const GST_DOCUMENT_USAGE_MODELS = ['Invoice', 'CreditNote', 'DebitNote', 'DeliveryChallan'];

const GST_PLAN_FEATURE_USAGE = {
  E_INVOICE_AND_E_WAY_BILL: ['eInvoice', 'eWayBill'],
  ONLY_E_WAY_BILL: ['eWayBill'],
};

const DOCUMENT_EXPORT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const DOCUMENT_EXPORT_FORMAT = {
  PDF: 'pdf',
};

const DOCUMENT_EXPORT_PDF_VARIANT = {
  DOCUMENT: 'document',
  E_INVOICE: 'eInvoice',
  E_WAY_BILL: 'eWayBill',
  E_INVOICE_AND_E_WAY_BILL: 'eInvoiceAndEWayBill',
};

const SETTINGS_PLAN_FEATURES = ['INCENTIVE', 'REJECTION_ORDER', 'WHATSAPP_CONFIG'];

const BULK_BODY_ARRAY_KEY = {
  CUSTOMER: 'customers',
  VENDOR: 'customers',
  ITEM: 'items',
};

const AGGREGATION_EXCLUDED_STATUSES = [
  SUBSCRIPTION_STATUS.CANCELLED,
  SUBSCRIPTION_STATUS.COMPLETED,
  SUBSCRIPTION_STATUS.EXPIRED,
  SUBSCRIPTION_STATUS.AUTHENTICATED,
  SUBSCRIPTION_STATUS.INACTIVE,
];

/** Maximum length NIC accepts for a document number on e-invoice and e-way bill payloads. */
const NIC_DOC_NUMBER_MAX_LENGTH = 15;

/** Maximum number of attachment files allowed per upload field (used across quote, invoice, bill, etc.) */
const ATTACHMENT_MAX_COUNT = 3;
const ATTACHMENT_ONE_COUNT = 1;
const MAX_FILE_SIZE = 1024 * 1024 * 5;
const IMAGE_UPLOAD_FIELDS = ['logo', 'companyLogo', 'authorizedSignature', 'photo'];

const ATTACHMENT_UPLOAD_FIELDS = [
  'attachment',
  'purchasingData.attachment',
  'salesData.attachment',
  'bookingCopyImage',
  'truck_goodsImage',
  'vehicle_goodsImage',
];

const OTP_TYPE = {
  VERIFY_EMAIL: 'verifyEmail',
  RESET_PASSWORD: 'resetPassword',
  ACCOUNT_PARTNER: 'ACCOUNT_PARTNER',
};

const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
};

const INVOICE_STATUS = {
  DRAFT: 'DRAFT',
  UNPAID: 'UNPAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  OVERDUE: 'OVERDUE',
  VOID: 'VOID',
  SENT: 'SENT',
  CANCELLED: 'CANCELLED',
};

const SALES_ORDER_STATUS = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
  PARTIALLY_RECORDED: 'PARTIALLY_RECORDED',
  COMPLETED: 'COMPLETED',
};

const RECURRING_INVOICE_STATUS = {
  ACTIVE: 'ACTIVE',
  DRAFT: 'DRAFT',
  PAUSED: 'PAUSED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED',
};

const PRODUCTION_MANAGE_METHOD = {
  PROCESS_ROUTE: 'PROCESS_ROUTE',
  BOM_BASED: 'BOM_BASED',
};

const RAW_MATERIAL_STATUS = {
  AVAILABLE: 'AVAILABLE',
  PARTIALLY_AVAILABLE: 'PARTIALLY_AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
};

// Sales order list badges: for quantity still to produce, whether the raw materials cover all, part or none of it.
const SALES_ORDER_MATERIAL_STATUS = {
  AVAILABLE: 'AVAILABLE',
  PARTIALLY_READY: 'PARTIALLY_READY',
  ISSUES: 'ISSUES',
};

const RIGHTS = {
  CREATE: 'create',
  EDIT: 'edit',
  VIEW: 'view',
  DELETE: 'delete',
};

const MODULE_LIST = {
  SALES_ORDER: 'Sales Orders',
  PURCHASE_ORDER: 'Purchase Orders',
  QUOTES: 'Quotes',
  DELIVERY_CHALLANS: 'Delivery Challans',
  INVOICES: 'Invoices',
  PAYMENT_RECEIVED: 'Payments Received',
  CREDIT_NOTES: 'Credit Notes',
  GRPO: 'GRPO',
  BILLS: 'Bills',
  PAYMENT_MADE: 'Payments Made',
  DEBIT_NOTES: 'Debit Notes',
  BANK: 'Banks',
  ROLES: 'Roles',
  QUALITY_MASTER: 'Quality Master',
  DIVISION: 'Division',
  BRANCH: 'Branch',
  WAREHOUSE_MASTER: 'Warehouse Master',
  MACHINE: 'Machine',
  SPARE_PART: 'Spare Part',
  MAINTENANCE_REQUEST: 'Maintenance Request',
  PART_REQUEST: 'Part Request',
  PROCESS: 'Process',
  RECIPE: 'Recipe',
  PRICE_LIST: 'Price List',
  PROJECTS: 'Projects',
  TIMESHEET: 'Timesheet',
  CUSTOMER_MASTER: 'Customer Master',
  USERS: 'Users',
  RECURRING_INVOICE: 'Recurring Invoices',
  EXPENSES: 'Expenses',
  RECURRING_EXPENSES: 'Recurring Expenses',
  RECURRING_BILLS: 'Recurring Bills',
  ITEM_MASTER: 'Item Master',
  PRODUCTION: 'View Inventory',
  ADD_INVENTORY: 'Add Inventory',
  INVENTORY_TRANSFER_REQUEST: 'Inventory Transfer',
  SUBMIT_PRODUCTION: 'Submit Production',
  ACCOUNTANT: 'Accountant',
  VENDORS: 'Vendors',
  ITEM_GROUP_ANALYTICS_CONFIG: 'Item Group Analytics Config',
};

const CURRENCIES = {
  INR: 'INR',
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
};

const CANCELLATION_REASONS = {
  1: {
    value: '1',
    label: 'Duplicate E-Invoice',
  },
  2: {
    value: '2',
    label: 'Data Entry Mistake',
  },
  3: {
    value: '3',
    label: 'Order Cancelled',
  },
  4: {
    value: '4',
    label: 'Other',
  },
};

const E_WAY_BILL_CANCELLATION_REASONS = {
  1: {
    value: '1',
    label: 'Duplicate E-Invoice',
  },
  2: {
    value: '2',
    label: 'Data Entry Mistake',
  },
};

const MASTERS_INDIA_EWB_CANCEL_REASONS = {
  1: 'Duplicate',
  2: 'Data Entry Mistake',
};
const MASTERS_INDIA_EWB_CANCEL_REASON_DEFAULT = 'Others';

const E_INVOICE_STATUS = {
  ACT: {
    label: 'Active',
    value: 'ACT',
  },
  CNL: {
    label: 'Cancelled',
    value: 'CNL',
  },
  EXP: {
    label: 'Expired',
    value: 'EXP',
  },
};

const E_WAY_BILL_STATUS = {
  ACT: {
    label: 'Active',
    value: 'ACT',
  },
  CNL: {
    label: 'Cancelled',
    value: 'CNL',
  },
  DIS: {
    label: 'Discarded',
    value: 'DIS',
  },
};

// NIC e-way bill document types; `mastersIndiaName` is the label Masters India expects for the same type.
const E_WAY_BILL_DOCUMENT_TYPES = {
  INV: { value: 'INV', label: 'Tax Invoice', mastersIndiaName: 'Tax Invoice' },
  BIL: { value: 'BIL', label: 'Bill of Supply', mastersIndiaName: 'Bill of Supply' },
  CHL: { value: 'CHL', label: 'Delivery Challan', mastersIndiaName: 'Delivery Challan' },
  BOE: { value: 'BOE', label: 'Bill of Entry', mastersIndiaName: 'Bill of Entry' },
  CNT: { value: 'CNT', label: 'Credit Note', mastersIndiaName: 'Credit Note' },
  OTH: { value: 'OTH', label: 'Others', mastersIndiaName: 'Others' },
};

/**
 * Document types NIC accepts for each supply type ('O' outward, 'I' inward) and sub supply type; any other combination
 * is rejected with NIC error 611. Credit Note (CNT) is in NIC's master list but valid for no combination.
 */
const E_WAY_BILL_DOCUMENT_TYPE_RULES = {
  O: {
    1: ['INV', 'BIL'], // Supply
    3: ['INV', 'BIL'], // Export
    4: ['CHL'], // Job Work
    5: ['CHL'], // For Own Use
    8: ['CHL', 'OTH'], // Others
    9: ['INV', 'BIL', 'CHL'], // SKD/CKD/Lots
    10: ['CHL'], // Line Sales
    11: ['CHL', 'OTH'], // Recipient Not Known
    12: ['CHL'], // Exhibition or Fairs
  },
  I: {
    1: ['INV', 'BIL'], // Supply
    2: ['BOE'], // Import
    5: ['CHL'], // For Own Use
    6: ['CHL'], // Job Work Returns
    7: ['CHL'], // Sales Return
    8: ['CHL', 'OTH'], // Others
    9: ['BOE', 'INV', 'BIL', 'CHL'], // SKD/CKD/Lots
    12: ['CHL'], // Exhibition or Fairs
  },
};

const PARTY_ACCOUNT_TYPES = {
  ACCOUNTS_RECEIVABLE: SYSTEM_ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
  ACCOUNTS_PAYABLE: SYSTEM_ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
  BRANCH_DIVISIONS: SYSTEM_ACCOUNT_KEYS.BRANCH_DIVISIONS,
};

const PARTY_ACCOUNT_TYPES_BY_ROLE = {
  CUSTOMER: [PARTY_ACCOUNT_TYPES.ACCOUNTS_RECEIVABLE, PARTY_ACCOUNT_TYPES.BRANCH_DIVISIONS],
  VENDOR: [PARTY_ACCOUNT_TYPES.ACCOUNTS_PAYABLE],
};

/**
 * Documents an e-invoice / e-way bill can be generated for.
 * - `nicDocType`: e-invoice document type; null means the document cannot have an e-invoice.
 * - `partyIsSender`: true when the goods move from the customer back to the company (a sales return).
 * - `partyBillingAddress`: true when the document's `addressId` is not a party address (a debit note's points to the
 *   company's own address), so the party side of the movement is the party's billing address, which also decided the tax.
 * - `canBeStockTransfer`: the document can be an internal stock transfer, whose goods are dispatched from its From
 *   warehouse to its To warehouse.
 * - `eWayBillDefaults`: what the standalone e-way bill form opens on; `stockTransferEWayBillDefaults` replaces it for
 *   an internal stock transfer.
 */
const GST_DOCUMENT_TYPES = {
  INVOICE: {
    key: 'INVOICE',
    modelName: 'Invoice',
    numberField: 'invoiceId',
    dateField: 'invoiceDate',
    partyField: 'customerId',
    label: 'Invoice',
    nicDocType: 'INV',
    partyIsSender: false,
    eWayBillDefaults: { supplyType: 'O', subSupplyType: '1', subSupplyDesc: '', documentType: 'INV' },
  },
  CREDIT_NOTE: {
    key: 'CREDIT_NOTE',
    modelName: 'CreditNote',
    numberField: 'creditNoteId',
    dateField: 'creditNoteDate',
    partyField: 'customerId',
    label: 'Credit Note',
    nicDocType: 'CRN',
    partyIsSender: true,
    // NIC accepts only a Delivery Challan for an inward sales return.
    eWayBillDefaults: { supplyType: 'I', subSupplyType: '7', subSupplyDesc: '', documentType: 'CHL' },
  },
  DEBIT_NOTE: {
    key: 'DEBIT_NOTE',
    modelName: 'DebitNote',
    numberField: 'debitNoteId',
    dateField: 'debitNoteDate',
    partyField: 'vendorId',
    label: 'Debit Note',
    nicDocType: null,
    partyIsSender: false,
    partyBillingAddress: true,
    eWayBillDefaults: { supplyType: 'O', subSupplyType: '8', subSupplyDesc: 'Purchase Return', documentType: 'OTH' },
  },
  DELIVERY_CHALLAN: {
    key: 'DELIVERY_CHALLAN',
    modelName: 'DeliveryChallan',
    numberField: 'challanId',
    dateField: 'challanDate',
    partyField: 'customerId',
    label: 'Delivery Challan',
    nicDocType: null,
    partyIsSender: false,
    canBeStockTransfer: true,
    eWayBillDefaults: { supplyType: 'O', subSupplyType: '4', subSupplyDesc: '', documentType: 'CHL' },
    stockTransferEWayBillDefaults: { supplyType: 'O', subSupplyType: '5', subSupplyDesc: '', documentType: 'CHL' },
  },
};

// SAC sent for invoice additional charges (freight and similar) unless the user picks another one.
const DEFAULT_ADDITIONAL_CHARGE_HSN = '996511';

const THIRD_PARTY_PROVIDERS = {
  GST_HERO: 'GST Hero',
  FYNAMICS: 'Fynamics',
  MASTERS_INDIA: 'Masters India',
};

const EINVOICE_PROVIDERS = {
  MASTERS_INDIA: 'MASTERS_INDIA',
  FYNAMICS: 'FYNAMICS',
};

const PROVIDER_ERROR_CATEGORY = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROVIDER_5XX: 'PROVIDER_5XX',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  NIC_BUSINESS_ERROR: 'NIC_BUSINESS_ERROR',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
};

const THIRD_PARTY_API_USAGE_FEATURE_NAME = 'THIRD_PARTY_API_CALLS';

// Usage row names for the split E_INVOICE_AND_E_WAY_BILL / ONLY_E_WAY_BILL plan features
const GST_USAGE_ROW_NAMES = {
  E_INVOICE: 'E-Invoice',
  E_WAY_BILL: 'E-Way Bill',
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const USAGE_WARNING_PERCENT = 80;

const USAGE_STATUS = {
  OK: 'OK',
  WARNING: 'WARNING',
  EXCEEDED: 'EXCEEDED',
  UNLIMITED: 'UNLIMITED',
};

// Order here is the order of the usage rings on the subscription page
const USAGE_HIGHLIGHT_FEATURES = [
  PLAN_FEATURES.INVOICE,
  PLAN_FEATURES.BILL,
  PLAN_FEATURES.USER,
  PLAN_FEATURES.CUSTOMER,
  PLAN_FEATURES.ITEM,
  GST_USAGE_ROW_NAMES.E_INVOICE,
  THIRD_PARTY_API_USAGE_FEATURE_NAME,
];

// Key order is the display order of feature groups on the subscription page
const PLAN_FEATURE_SECTIONS = {
  SALES: 'Sales',
  PURCHASES: 'Purchases',
  ACCOUNTANT: 'Accountant',
  INVENTORY: 'Inventory & Production',
  GST: 'GST & Compliance',
  REPORTS: 'Reports',
  GENERAL: 'General',
  SUPPORT: 'Support',
  INTEGRATIONS: 'Integrations',
};

const DEFAULT_PLAN_FEATURE_SECTION = 'GENERAL';

// Fallback label and section when Plan.limits has no label/section set
const PLAN_FEATURE_META = {
  [PLAN_FEATURES.QUOTATION]: { label: 'Quotes', section: 'SALES' },
  [PLAN_FEATURES.SALES_ORDER]: { label: 'Sales Orders', section: 'SALES' },
  [PLAN_FEATURES.INVOICE]: { label: 'Invoices', section: 'SALES' },
  [PLAN_FEATURES.PAYMENT_RECEIVED]: { label: 'Payments Received', section: 'SALES' },
  [PLAN_FEATURES.RECURRING_INVOICE]: { label: 'Recurring Invoices', section: 'SALES' },
  [PLAN_FEATURES.CREDIT_NOTES]: { label: 'Credit Notes', section: 'SALES' },
  [PLAN_FEATURES.DELIVERY_CHALLAN]: { label: 'Delivery Challans', section: 'SALES' },
  [PLAN_FEATURES.CUSTOMER]: { label: 'Customers', section: 'SALES' },
  [PLAN_FEATURES.CUSTOMER_ORDER]: { label: 'Customer Orders', section: 'SALES' },
  [PLAN_FEATURES.INCENTIVE]: { label: 'Incentives', section: 'SALES' },
  [PLAN_FEATURES.COMPLAINTS]: { label: 'Complaints', section: 'SALES' },
  [PLAN_FEATURES.VENDOR]: { label: 'Vendors', section: 'PURCHASES' },
  [PLAN_FEATURES.PURCHASE_ORDER]: { label: 'Purchase Orders', section: 'PURCHASES' },
  [PLAN_FEATURES.GRPO]: { label: 'GRPO', section: 'PURCHASES' },
  [PLAN_FEATURES.BILL]: { label: 'Bills', section: 'PURCHASES' },
  [PLAN_FEATURES.PAYMENT_MADE]: { label: 'Payments Made', section: 'PURCHASES' },
  [PLAN_FEATURES.RECURRING_BILL]: { label: 'Recurring Bills', section: 'PURCHASES' },
  [PLAN_FEATURES.DEBIT_NOTES]: { label: 'Debit Notes', section: 'PURCHASES' },
  [PLAN_FEATURES.EXPENSES]: { label: 'Expenses', section: 'PURCHASES' },
  [PLAN_FEATURES.RECURRING_EXPENSES]: { label: 'Recurring Expenses', section: 'PURCHASES' },
  [PLAN_FEATURES.MANUAL_JOURNAL]: { label: 'Manual Journals', section: 'ACCOUNTANT' },
  [PLAN_FEATURES.ACCOUNT_LEDGER]: { label: 'Account Ledgers', section: 'ACCOUNTANT' },
  [PLAN_FEATURES.ITEM]: { label: 'Items', section: 'INVENTORY' },
  [PLAN_FEATURES.ITEM_GROUP]: { label: 'Item Groups', section: 'INVENTORY' },
  [PLAN_FEATURES.WAREHOUSE]: { label: 'Warehouses', section: 'INVENTORY' },
  [PLAN_FEATURES.INVENTORY]: { label: 'Inventory', section: 'INVENTORY' },
  [PLAN_FEATURES.PRODUCTION]: { label: 'Production', section: 'INVENTORY' },
  [PLAN_FEATURES.PRODUCTION_ORDER]: { label: 'Production Orders', section: 'INVENTORY' },
  [PLAN_FEATURES.REJECTION_ORDER]: { label: 'Rejection Orders', section: 'INVENTORY' },
  [PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL]: { label: 'E-Invoice & E-Way Bill', section: 'GST' },
  [PLAN_FEATURES.ONLY_E_WAY_BILL]: { label: 'E-Way Bill', section: 'GST' },
  [GST_USAGE_ROW_NAMES.E_INVOICE]: { label: 'E-Invoice', section: 'GST' },
  [GST_USAGE_ROW_NAMES.E_WAY_BILL]: { label: 'E-Way Bill', section: 'GST' },
  [THIRD_PARTY_API_USAGE_FEATURE_NAME]: { label: 'NIC API Calls', section: 'GST' },
  [PLAN_FEATURES.STANDARD_REPORTS]: { label: 'Standard Reports', section: 'REPORTS' },
  [PLAN_FEATURES.ADVANCED_REPORTS]: { label: 'Advanced Reports', section: 'REPORTS' },
  [PLAN_FEATURES.USER]: { label: 'Users', section: 'GENERAL' },
  [PLAN_FEATURES.DIVISION]: { label: 'Divisions', section: 'GENERAL' },
  [PLAN_FEATURES.BRANCH]: { label: 'Branches', section: 'GENERAL' },
  [PLAN_FEATURES.DASHBOARD]: { label: 'Dashboard', section: 'GENERAL' },
  [PLAN_FEATURES.EMAIL_SUPPORT]: { label: 'Email', section: 'SUPPORT' },
  [PLAN_FEATURES.CHAT_SUPPORT]: { label: 'Chat', section: 'SUPPORT' },
  [PLAN_FEATURES.VOICE_SUPPORT]: { label: 'Voice', section: 'SUPPORT' },
  [PLAN_FEATURES.PRIORITY_SUPPORT]: { label: 'Priority Support', section: 'SUPPORT' },
  [PLAN_FEATURES.WHATSAPP_CONFIG]: { label: 'WhatsApp', section: 'INTEGRATIONS' },
};

const THIRD_PARTY_API_LOG_REFERENCE_TYPES = {
  INVOICE: 'Invoice',
  CUSTOMER: 'Customer',
};

const STOCK_STATUS = {
  NORMAL: 'NORMAL',
  BELOW_MINIMUM: 'BELOW_MINIMUM',
  ABOVE_MAXIMUM: 'ABOVE_MAXIMUM',
  NO_RANGE: 'NO_RANGE',
};

const RIGHT_LIST = {
  BANK: 'banks',
  BANK_TRANSFER_LOG: 'bankTransferLogs',
  ITEM_MASTER: 'items',
  USERS: 'users',
  ROLES: 'roles',
  QUALITY_MASTER: 'qualityMaster',
  DIVISION: 'division',
  BRANCH: 'branch',
  WAREHOUSE_MASTER: 'warehouseMaster',
  PROCESS: 'process',
  RECIPE: 'recipe',
  PRICE_LIST: 'priceList',
  ITEM_GROUP: 'itemGroup',
  MANPOWER: 'manPower',
  MACHINE: 'machine',
  SPARE_PART: 'sparePart',
  MAINTENANCE_REQUEST: 'maintenanceRequest',
  PART_REQUEST: 'partRequest',
  MAINTENANCE_PURCHASE: 'maintenancePurchase',
  SPARE_STOCK_LEDGER: 'spareStockLedger',
  CUSTOMER_MASTER: 'customers',
  QUOTES: 'quotations',
  SALES_ORDER: 'salesOrders',
  SALES_ORDER_TAG: 'salesOrderTag',
  DELIVERY_CHALLANS: 'deliveryChallan',
  INVOICES: 'invoices',
  PAYMENT_RECEIVED: 'paymentReceived',
  RECURRING_INVOICE: 'recurringInvoices',
  CREDIT_NOTES: 'creditNote',
  VENDORS: 'vendor',
  EXPENSES: 'expenses',
  RECURRING_EXPENSES: 'recurringExpense',
  PURCHASE_ORDER: 'purchaseOrder',
  GRPO: 'grpo',
  BILLS: 'bill',
  PAYMENT_MADE: 'paymentMade',
  RECURRING_BILLS: 'recurringBills',
  DEBIT_NOTE: 'debitNote',
  CHARTS_OF_ACCOUNT: 'chartOfAccounts',
  ACCOUNT_LEDGER: 'accountLedger',
  MANUAL_JOURNAL: 'manualJournals',
  VIEW_INVENTORY: 'viewInventory',
  ADD_INVENTORY: 'addInventory',
  INVENTORY_TRANSFER_REQUEST: 'inventoryTransfer',
  ANALYTICS: 'analytics',
  INVENTORY_ADJUSTMENT: 'inventoryAdjustment',
  REPORTS: 'reports',
  DASHBOARD: 'dashboard',
  PRODUCTION: 'addProduction',
  SUPPORT: 'support',
  CUSTOMER_ORDER: 'customerOrders',
  BOOK_REJECTION: 'bookRejection',
  REJECTION_ANALYSIS: 'rejectionAnalysis',
  REJECTION_INVENTORY: 'rejectionInventory',
  COMPLAINTS: 'complaints',
  PROBLEM_LIST: 'problemList',
  COMPLAINTS_LIST: 'complaintsList',
  COMPLAINTS_REPORTS: 'complaintsReports',
  CUSTOMER_PAYMENT: 'customerPayment',
  SAMPLE_CATALOG: 'sampleCatalog',
  ITEM_BATCH: 'itemBatch',
  CUSTOMER_APP: 'customerApp',
  CUSTOMER_APP_DASHBOARD: 'customerAppDashboard',
};

const REPORT_LIST = {
  GENERAL_LEDGER: 'generalLedger',
  ITEM_LEDGER: 'itemLedger',
  BANK_LEDGER: 'bankLedger',
  SALES_LEDGER: 'salesLedger',
  PURCHASE_LEDGER: 'purchaseLedger',
  CREDITORS_LEDGER: 'creditorsLedger',
  DEBTORS_LEDGER: 'debtorsLedger',
  GROSS_PROFIT: 'grossProfit',
};

const MODULE_LABELS = {
  [GENERAL_SALES_ANALYTICS_MODULES.QUOTE]: 'Quotes',
  [GENERAL_SALES_ANALYTICS_MODULES.SALES_ORDER]: 'Sales Orders',
  [GENERAL_SALES_ANALYTICS_MODULES.DELIVERY_CHALLAN]: 'Delivery Challan',
  [GENERAL_SALES_ANALYTICS_MODULES.INVOICE]: 'Invoices',
};

const MODULE_DATA_KEYS = {
  [GENERAL_SALES_ANALYTICS_MODULES.QUOTE]: 'quote',
  [GENERAL_SALES_ANALYTICS_MODULES.SALES_ORDER]: 'salesOrder',
  [GENERAL_SALES_ANALYTICS_MODULES.DELIVERY_CHALLAN]: 'deliveryChallan',
  [GENERAL_SALES_ANALYTICS_MODULES.INVOICE]: 'invoice',
};

const ANALYTICS_RIGHTS = {
  ITEM_ANALYTICS: 'itemAnalytics',
  GROUP_ITEM_ANALYTICS: 'groupItemAnalytics',
  SALES_ORDERS_ANALYTICS: 'salesOrdersAnalytics',
  ITEM_WISE_SALES_ORDERS_ANALYTICS: 'itemWiseSalesOrdersAnalytics',
  CUSTOMER_WISE_SALES_ORDERS_ANALYTICS: 'customerWiseSalesOrdersAnalytics',
  NEW_VS_OLD_CUSTOMER_REPORT: 'newVsOldCustomerReport',
  TOP_CUSTOMERS_OF_SALES: 'topCustomersOfSales',
  TOP_ITEMS_OF_SALES: 'topItemsOfSales',
  RM_ANALYTICS: 'rmAnalytics',
  ITEM_WISE_RM_ANALYTICS: 'itemWiseRmAnalytics',
  SALES_ORDER_WISE_RM_ANALYTICS: 'soWiseRmAnalytics',
  TOP_VENDORS_BY_AMOUNT_PURCHASE: 'topVendorsByAmountPurchase',
  VENDORS_BY_PURCHASE: 'vendorsByPurchase',
  TOP_ITEM_OF_PURCHASE: 'topItemOfPurchase',
  TOP_CUSTOMER_BY_AMOUNT_COLLECTION: 'topCustomerByAmountCollection',
  UPCOMING_RECEIVABLES_INVOICE: 'upcomingReceivablesInvoice',
  RECENTLY_RECEIVED_PAYMENTS: 'recentlyReceivedPayments',
  OVERDUE_INVOICES: 'overdueInvoices',
  TOP_VENDORS_BY_AMOUNT_PAYMENTS: 'topVendorsByAmountPayments',
  UPCOMING_PAYABLES_BILLS: 'upcomingPayablesBills',
  RECENTLY_PAYMENTS_MADE: 'recentlyPaymentsMade',
  OVERDUE_BILLS: 'overdueBills',
  CUSTOMER_ONE_INVOICE: 'customeroneinvoice',
  GENERAL_SALES_ANALYTICS: 'generalSalesAnalytics',
  REJECTION_ANALYTICS: 'rejectionAnalytics',
  REJECTION_ANALYTICS_BY_ITEM: 'rejectionAnalyticsByItem',
  ITEM_PROCESS_ANALYTICS: 'itemProcessAnalytics',
  MONTHLY_PRODUCTION_REPORT: 'monthlyProductionReport',
  STOCK_SUMMARY: 'stockSummary',
  PARTY_WISE_BUSINESS_PERFORMANCE: 'partyWiseBusinessPerformance',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DOCUMENT_TYPE_LABELS = {
  OUTWARD_SUPPLY_INVOICE: 'Invoices for Outward Supply',
  INWARD_SUPPLY_UNREGISTERED: 'Invoices for inward supply from unregistered person',
  DEBIT_NOTE: 'Debit Note',
  CREDIT_NOTE: 'Credit Note',
  DELIVERY_CHALLAN: 'Delivery Challan',
};

const NIL_BUCKET_KEYS = ['inter_registered', 'inter_unregistered', 'intra_registered', 'intra_unregistered'];
const BUCKET_LABELS = {
  inter_registered: 'Inter-State supplies to registered persons',
  inter_unregistered: 'Inter-State supplies to unregistered persons',
  intra_registered: 'Intra-State supplies to registered persons',
  intra_unregistered: 'Intra-State supplies to unregistered persons',
};

const ALLOWED_STATUSES_FOR_CLOSE = [
  PRODUCTION_ORDER_STATUS.PENDING,
  PRODUCTION_ORDER_STATUS.PARTIAL,
  PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED,
  PRODUCTION_ORDER_STATUS.INVENTORY_REJECTED,
  PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL,
];

const PRODUCTION_ORDER_STATUS_ACTION = {
  UNHOLD: 'UNHOLD',
  REVERT_MANUAL_COMPLETION: 'REVERT_MANUAL_COMPLETION',
};

const TRANSACTION_TYPE = {
  OPENING_RECEIVABLE: 'opening_receivable',
  OPENING_PAYABLE: 'opening_payable',
  CUSTOMER_CREDIT: 'customer_credit',
  VENDOR_CREDIT: 'vendor_credit',
};

const CONTACT_TYPE = {
  CUSTOMER: 'customer',
  VENDOR: 'vendor',
};

const OB_PAYMENT_ENTRY_SOURCE = {
  PAYMENT_RECEIVED: 'payment_received',
  INVOICE_CREDIT: 'invoice_credit',
  PAYMENT_MADE: 'payment_made',
  BILL_CREDIT: 'bill_credit',
};

const CUSTOMER_ORDER_NOTIFICATION_TYPE = {
  CUSTOMER_ORDER_ACCEPTED: 'CUSTOMER_ORDER_ACCEPTED',
  CUSTOMER_ORDER_REJECTED: 'CUSTOMER_ORDER_REJECTED',
  CUSTOMER_ORDER_COMPLETED: 'CUSTOMER_ORDER_COMPLETED',
};

const CUSTOMER_ORDER_TYPE = {
  REGULAR: 'REGULAR',
  SAMPLE: 'SAMPLE',
};

const ADDRESS_TYPE = {
  BILLING: 'billing',
  SHIPPING: 'shipping',
};

const ADDRESS_VALIDATION_ERRORS = {
  BILLING_COUNTRY_NOT_FOUND: 'BILLING_COUNTRY_NOT_FOUND',
  BILLING_STATE_NOT_FOUND: 'BILLING_STATE_NOT_FOUND',
  BILLING_CITY_NOT_FOUND: 'BILLING_CITY_NOT_FOUND',
  BILLING_STATE_REQUIRED: 'BILLING_STATE_REQUIRED',
  BILLING_CITY_REQUIRED: 'BILLING_CITY_REQUIRED',
  BILLING_COUNTRY_REQUIRED: 'BILLING_COUNTRY_REQUIRED',
  SHIPPING_COUNTRY_NOT_FOUND: 'SHIPPING_COUNTRY_NOT_FOUND',
  SHIPPING_STATE_NOT_FOUND: 'SHIPPING_STATE_NOT_FOUND',
  SHIPPING_CITY_NOT_FOUND: 'SHIPPING_CITY_NOT_FOUND',
  SHIPPING_STATE_REQUIRED: 'SHIPPING_STATE_REQUIRED',
  SHIPPING_CITY_REQUIRED: 'SHIPPING_CITY_REQUIRED',
  SHIPPING_COUNTRY_REQUIRED: 'SHIPPING_COUNTRY_REQUIRED',
};

const ITEM_BATCH_SOURCE_LABELS = {
  [MODULE_NAMES.CREDIT_NOTE]: 'Credit Note',
  [MODULE_NAMES.SPLIT_CREDIT_NOTE]: 'Split Credit Note',
  [MODULE_NAMES.SPLIT_BILL]: 'Split Bill',
  PRODUCTION_ORDER: 'Production Order',
  EXISTING_INVENTORY: 'Existing Inventory',
  MANUAL_STOCK_ADD: 'Manual Stock Addition',
  MANUAL_STOCK_TRANSFER: 'Manual Stock Transfer',
  PRODUCTIONORDER_STOCK_TRANSFER: 'Production Order Transfer',
  [ITEM_BATCH_SOURCE_TYPE.DELIVERY_CHALLAN_STOCK_TRANSFER]: 'Delivery Challan Transfer',
  OPENING_STOCK: 'Opening Stock',
  INVENTORY_ADJUSTMENT: 'Inventory Adjustment',
  REJECTION_RECOVERY: 'Rejection Recovery',
};

const SMTP_HOSTS = {
  GMAIL: 'smtp.gmail.com',
  OUTLOOK: 'smtp.office365.com',
  ZOHO: 'smtp.zoho.com',
  YAHOO: 'smtp.mail.yahoo.com',
  ICLOUD: 'smtp.mail.me.com',
  AMAZON_SES: 'email-smtp.amazonaws.com',
  SENDGRID: 'smtp.sendgrid.net',
  MAILGUN: 'smtp.mailgun.org',
  BREVO: 'smtp-relay.brevo.com',
};

const OB_TYPE_BALANCE = {
  [TRANSACTION_TYPE.OPENING_RECEIVABLE]: BALANCE_TYPES.DEBIT,
  [TRANSACTION_TYPE.VENDOR_CREDIT]: BALANCE_TYPES.DEBIT,
  [TRANSACTION_TYPE.OPENING_PAYABLE]: BALANCE_TYPES.CREDIT,
  [TRANSACTION_TYPE.CUSTOMER_CREDIT]: BALANCE_TYPES.CREDIT,
};

const SOURCE_DOCUMENTS = {
  GRPO: {
    modelKey: 'GrpoOrder',
    dateField: 'date',
    noField: 'grpoOrderId',
    partyFields: ['vendor', 'vendorId'],
    label: 'GRPO',
    navType: 'GrpoOrder',
  },
  BILL: {
    modelKey: 'Bill',
    dateField: 'billDate',
    noField: 'billId',
    partyFields: ['vendor', 'vendorId'],
    label: 'Bill',
    navType: 'Bill',
  },
  SPLIT_BILL: {
    modelKey: 'Bill',
    dateField: 'billDate',
    noField: 'billId',
    partyFields: ['vendor', 'vendorId'],
    label: 'Split Bill',
    navType: 'Bill',
  },
  DEBIT_NOTE: {
    modelKey: 'DebitNote',
    dateField: 'debitNoteDate',
    noField: 'debitNoteId',
    partyFields: ['vendor', 'vendorId'],
    label: 'Debit Note',
    navType: 'DebitNote',
  },
  SPLIT_DEBIT_NOTE: {
    modelKey: 'DebitNote',
    dateField: 'debitNoteDate',
    noField: 'debitNoteId',
    partyFields: ['vendor', 'vendorId'],
    label: 'Split Debit Note',
    navType: 'DebitNote',
  },
  PAYMENT_MADE: {
    modelKey: 'PaymentMade',
    dateField: 'paymentDate',
    noField: 'paymentMadeId',
    partyFields: ['vendorId'],
    label: 'Payment Made',
    navType: 'PaymentMade',
  },
  SPLIT_PAYMENT_MADE: {
    modelKey: 'PaymentMade',
    dateField: 'paymentDate',
    noField: 'paymentMadeId',
    partyFields: ['vendorId'],
    label: 'Split Payment Made',
    navType: 'PaymentMade',
  },
  INVOICE: {
    modelKey: 'Invoice',
    dateField: 'invoiceDate',
    noField: 'invoiceId',
    partyFields: ['customerId'],
    label: 'Invoice',
    navType: 'Invoice',
  },
  SPLIT_INVOICE: {
    modelKey: 'Invoice',
    dateField: 'invoiceDate',
    noField: 'invoiceId',
    partyFields: ['customerId'],
    label: 'Split Invoice',
    navType: 'Invoice',
  },
  DELIVERY_CHALLAN: {
    modelKey: 'DeliveryChallan',
    dateField: 'challanDate',
    noField: 'challanId',
    partyFields: ['customerId'],
    label: 'Delivery Challan',
    navType: 'DeliveryChallan',
  },
  CREDIT_NOTE: {
    modelKey: 'CreditNote',
    dateField: 'creditNoteDate',
    noField: 'creditNoteId',
    partyFields: ['customerId'],
    label: 'Credit Note',
    navType: 'CreditNote',
  },
  SPLIT_CREDIT_NOTE: {
    modelKey: 'CreditNote',
    dateField: 'creditNoteDate',
    noField: 'creditNoteId',
    partyFields: ['customerId'],
    label: 'Split Credit Note',
    navType: 'CreditNote',
  },
  PAYMENT_RECEIVED: {
    modelKey: 'PaymentReceived',
    db: 'booksCrm',
    dateField: 'paymentDate',
    noField: 'paymentReceivedId',
    partyFields: ['customerId'],
    label: 'Payment Received',
    navType: 'PaymentReceived',
  },
  SPLIT_PAYMENT_RECEIVED: {
    modelKey: 'PaymentReceived',
    db: 'booksCrm',
    dateField: 'paymentDate',
    noField: 'paymentReceivedId',
    partyFields: ['customerId'],
    label: 'Split Payment Received',
    navType: 'PaymentReceived',
  },
  PRODUCTION_ORDER: {
    modelKey: 'ProductionOrder',
    dateField: 'productionDate',
    noField: 'productionOrderCode',
    partyFields: [],
    label: 'Production Order',
    navType: 'ProductionOrder',
  },
  PRODUCTION: {
    modelKey: 'ProductionOrder',
    dateField: 'productionDate',
    noField: 'productionOrderCode',
    partyFields: [],
    label: 'Production',
    navType: 'ProductionOrder',
  },
  PRODUCTIONORDER_STOCK_TRANSFER: {
    modelKey: 'ProductionOrder',
    dateField: 'productionDate',
    noField: 'productionOrderCode',
    partyFields: [],
    label: 'Production Stock Transfer',
    navType: null,
  },
  INVENTORY_ADJUSTMENT: {
    modelKey: 'InventoryAdjustment',
    dateField: 'adjustmentDate',
    noField: 'inventoryAdjustmentNumber',
    partyFields: [],
    label: 'Inventory Adjustment',
    navType: null,
  },
  MANUAL_STOCK_TRANSFER: {
    modelKey: 'InventoryTransferRequest',
    dateField: 'date',
    noField: 'transferId',
    partyFields: [],
    label: 'Stock Transfer',
    navType: 'InventoryTransferRequest',
  },
  [ITEM_BATCH_SOURCE_TYPE.DELIVERY_CHALLAN_STOCK_TRANSFER]: {
    modelKey: 'DeliveryChallan',
    dateField: 'challanDate',
    noField: 'challanId',
    partyFields: [],
    label: 'Delivery Challan Transfer',
    navType: 'DeliveryChallan',
  },
  EXPENSE: {
    modelKey: 'Expenses',
    dateField: 'date',
    noField: 'expenseId',
    partyFields: ['party'],
    accountFields: ['expenseAccount'],
    label: 'Expense',
    navType: 'Expense',
  },
  MANUAL_JOURNAL: {
    modelKey: 'ManualJournal',
    dateField: 'date',
    noField: 'manualJournalId',
    partyFields: [],
    label: 'Manual Journal',
    navType: 'ManualJournal',
  },
  BANK_TRANSFER: {
    modelKey: 'BankTransferLog',
    db: 'booksCrm',
    dateField: 'date',
    noField: null,
    partyFields: [],
    label: 'Bank Transfer',
    navType: null,
  },
  BANK_DEPOSIT: {
    modelKey: 'BankTransferLog',
    db: 'booksCrm',
    dateField: 'date',
    noField: null,
    partyFields: [],
    label: 'Bank Deposit',
    navType: null,
  },
  BANK_WITHDRAWAL: {
    modelKey: 'BankTransferLog',
    db: 'booksCrm',
    dateField: 'date',
    noField: null,
    partyFields: [],
    label: 'Bank Withdrawal',
    navType: null,
  },
  OPENING_BALANCE: {
    modelKey: 'AccountOpeningBalance',
    dateField: 'openingBalanceDate',
    noField: null,
    noFrom: 'account',
    partyFields: [],
    accountFields: ['accountId'],
    label: 'Opening Balance',
    navType: 'Account',
    navFrom: 'accountId',
  },
  OPENING_BALANCE_PARTY: {
    modelKey: 'OpeningBalanceTransaction',
    db: 'booksCrm',
    dateField: 'date',
    noField: null,
    noFrom: 'party',
    partyFields: ['contactId'],
    partyTypeField: 'contactType',
    label: 'Opening Balance',
    navType: 'Customer',
    navFrom: 'partyId',
  },
  OPENING_STOCK: {
    modelKey: 'Item',
    db: 'booksCrm',
    dateField: 'createdAt',
    noField: 'itemNo',
    nameField: 'itemName',
    partyFields: [],
    label: 'Opening Stock',
    navType: 'Item',
  },
  EXISTING_INVENTORY: { modelKey: null, label: 'Existing Inventory' },
  MANUAL_STOCK_ADD: { modelKey: null, label: 'Manual Stock Add' },
  REJECTION_RECOVERY: { modelKey: null, label: 'Rejection Recovery' },
};

const STOCK_MOVEMENT_DOCUMENT_TYPE = {
  INVOICE: 'INVOICE',
  DELIVERY_CHALLAN: 'DELIVERY_CHALLAN',
  GRPO: 'GRPO',
  BILL: 'BILL',
  CREDIT_NOTE: 'CREDIT_NOTE',
  DEBIT_NOTE: 'DEBIT_NOTE',
  PRODUCTION_ORDER: 'PRODUCTION_ORDER',
  INVENTORY_ADJUSTMENT: 'INVENTORY_ADJUSTMENT',
  INVENTORY_TRANSFER: 'INVENTORY_TRANSFER',
  REJECTION_ORDER: 'REJECTION_ORDER',
};

const VERIFICATION_LINK_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
};

const TRANSACTION_RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 50,
  JITTER_MS: 100,
};

const UPLOAD_LEDGER = {
  KEY_PREFIX: 'upload:req:',
  TTL_SECONDS: 300,
};

// Customer address role used by the sales document list filter: billing vs shipping (incl. additional shipping)
const ADDRESS_TYPES = { BILL_TO: 'billTo', SHIP_TO: 'shipTo' };

module.exports = {
  ADDRESS_TYPES,
  STOCK_MOVEMENT_DOCUMENT_TYPE,
  VERIFICATION_LINK_STATUS,
  LEDGER_SOURCE_MODULES,
  LEDGER_PARTY_TYPES,
  SYSTEM_ACCOUNT_KEYS,
  MODULE_NAMES,
  ITEM_BATCH_SOURCE_TYPE,
  ITEM_BATCH_DEDUCTED_SOURCE_TYPE,
  HARD_HIDDEN_PLAN_FEATURES,
  GST_DOCUMENT_USAGE_MODELS,
  GST_PLAN_FEATURE_USAGE,
  SETTINGS_PLAN_FEATURES,
  BULK_BODY_ARRAY_KEY,
  AGGREGATION_EXCLUDED_STATUSES,
  TAX_TYPES,
  PAYMENT_TERMS,
  PAYMENT_MODES,
  DEPOSIT_TYPES,
  PAYMENT_STATUS,
  INVOICE_STATUS,
  REPEAT_PERIODS,
  ACCOUNT_TYPES,
  EXPENSEACCOUNTS,
  PAIDTHROUGHOPTIONS,
  SOURCE_TYPES,
  BANK_TYPES,
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  REJECTION_ORDER_STATUS,
  REJECTION_CONVERT_TYPE,
  SALES_ORDER_INVOICE_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  BILL_STATUSES,
  CREDIT_NOTE_STATUS,
  DEBIT_NOTE_STATUS,
  INVENTORY_TRANSFER_REQUEST,
  COMPANY_FEATURES,
  OTP_TYPE,
  PRODUCTION_ORDER_STATUS,
  PROCESS_STATUS,
  PRODUCTION_ORDER_ACTIVITY_TYPE,
  PRODUCTION_ORDER_INVENTORY_EVENT_TYPE,
  RECURRING_INVOICE_STATUS,
  PRODUCTION_MANAGE_METHOD,
  RAW_MATERIAL_STATUS,
  SALES_ORDER_MATERIAL_STATUS,
  CREDIT_NOTE_TYPE,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  CHEQUE_STATUS,
  RIGHTS,
  MODULE_LIST,
  REPORTING_METHODS,
  CURRENCIES,
  CANCELLATION_REASONS,
  E_INVOICE_STATUS,
  E_WAY_BILL_STATUS,
  E_WAY_BILL_CANCELLATION_REASONS,
  MASTERS_INDIA_EWB_CANCEL_REASONS,
  MASTERS_INDIA_EWB_CANCEL_REASON_DEFAULT,
  E_WAY_BILL_DOCUMENT_TYPES,
  E_WAY_BILL_DOCUMENT_TYPE_RULES,
  GST_DOCUMENT_TYPES,
  PARTY_ACCOUNT_TYPES,
  PARTY_ACCOUNT_TYPES_BY_ROLE,
  DEFAULT_ADDITIONAL_CHARGE_HSN,
  THIRD_PARTY_PROVIDERS,
  EINVOICE_PROVIDERS,
  PROVIDER_ERROR_CATEGORY,
  THIRD_PARTY_API_LOG_REFERENCE_TYPES,
  THIRD_PARTY_API_USAGE_FEATURE_NAME,
  GST_USAGE_ROW_NAMES,
  ONE_DAY_MS,
  USAGE_WARNING_PERCENT,
  USAGE_STATUS,
  USAGE_HIGHLIGHT_FEATURES,
  PLAN_FEATURE_SECTIONS,
  PLAN_FEATURE_META,
  DEFAULT_PLAN_FEATURE_SECTION,
  STOCK_UPDATE_REASONS,
  STOCK_STATUS,
  RIGHT_LIST,
  REPORT_LIST,
  ANALYTICS_RIGHTS,
  MONTH_NAMES,
  DOCUMENT_TYPE_LABELS,
  GENERAL_SALES_ANALYTICS_BASIS,
  GENERAL_SALES_ANALYTICS_MODULES,
  MODULE_LABELS,
  MODULE_DATA_KEYS,
  ATTACHMENT_MAX_COUNT,
  NIC_DOC_NUMBER_MAX_LENGTH,
  ATTACHMENT_ONE_COUNT,
  IMAGE_UPLOAD_FIELDS,
  ATTACHMENT_UPLOAD_FIELDS,
  MAX_FILE_SIZE,
  NIL_BUCKET_KEYS,
  BUCKET_LABELS,
  ALLOWED_STATUSES_FOR_CLOSE,
  PRODUCTION_ORDER_STATUS_ACTION,
  TRANSACTION_TYPE,
  CONTACT_TYPE,
  OB_PAYMENT_ENTRY_SOURCE,
  CUSTOMER_ORDER_NOTIFICATION_TYPE,
  CUSTOMER_ORDER_TYPE,
  ADDRESS_TYPE,
  ADDRESS_VALIDATION_ERRORS,
  ITEM_BATCH_SOURCE_LABELS,
  SMTP_HOSTS,
  OB_TYPE_BALANCE,
  COA_ACCOUNT_TYPES,
  ACCOUNT_CATEGORIES,
  PAYMENT_ACCOUNT_CATEGORIES,
  BANK_TYPE_BY_ACCOUNT_CATEGORY,
  ACCOUNT_CATEGORY_BY_BANK_TYPE,
  SOURCE_DOCUMENTS,
  TRANSACTION_RETRY,
  UPLOAD_LEDGER,
  DOCUMENT_EXPORT_STATUS,
  DOCUMENT_EXPORT_FORMAT,
  DOCUMENT_EXPORT_PDF_VARIANT,
};
