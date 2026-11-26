const { getBooksCrmModels, getBooksModels } = require('../services/model.service');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');

/**
 * Maps each PLAN_FEATURES key to its corresponding Mongoose model.
 * Used by checkSubscription middleware and viewSubscription to resolve models dynamically.
 *
 * Format: { getModels: Function, modelName: string }
 * Usage: const model = FEATURE_MODEL_MAP[featureKey].getModels()[modelName]
 */
const FEATURE_MODEL_MAP = {
  [PLAN_FEATURES.ITEM]: { getModels: getBooksCrmModels, modelName: 'Item', isCommon: true },
  [PLAN_FEATURES.USER]: { getModels: getBooksModels, modelName: 'UserRole', isCommon: false },
  [PLAN_FEATURES.DIVISION]: { getModels: getBooksCrmModels, modelName: 'Division', isCommon: false },
  [PLAN_FEATURES.BRANCH]: { getModels: getBooksCrmModels, modelName: 'Branch', isCommon: false },
  [PLAN_FEATURES.WAREHOUSE]: { getModels: getBooksCrmModels, modelName: 'Warehouse', isCommon: false },
  [PLAN_FEATURES.CUSTOMER]: { getModels: getBooksCrmModels, modelName: 'Customer', isCommon: true },
  [PLAN_FEATURES.VENDOR]: { getModels: getBooksCrmModels, modelName: 'Customer', isCommon: false },
  [PLAN_FEATURES.QUOTATION]: { getModels: getBooksCrmModels, modelName: 'Quote', isCommon: true },
  [PLAN_FEATURES.SALES_ORDER]: { getModels: getBooksCrmModels, modelName: 'SalesOrder', isCommon: true },
  [PLAN_FEATURES.PAYMENT_RECEIVED]: { getModels: getBooksCrmModels, modelName: 'PaymentReceived', isCommon: true },
  [PLAN_FEATURES.INVOICE]: { getModels: getBooksModels, modelName: 'Invoice', isCommon: false },
  [PLAN_FEATURES.RECURRING_INVOICE]: { getModels: getBooksModels, modelName: 'RecurringInvoice', isCommon: false },
  [PLAN_FEATURES.CREDIT_NOTES]: { getModels: getBooksModels, modelName: 'CreditNote', isCommon: false },
  [PLAN_FEATURES.DELIVERY_CHALLAN]: { getModels: getBooksModels, modelName: 'DeliveryChallan', isCommon: false },
  [PLAN_FEATURES.EXPENSES]: { getModels: getBooksModels, modelName: 'Expenses', isCommon: false },
  [PLAN_FEATURES.RECURRING_EXPENSES]: { getModels: getBooksModels, modelName: 'RecurringExpense', isCommon: false },
  [PLAN_FEATURES.PURCHASE_ORDER]: { getModels: getBooksModels, modelName: 'PurchaseOrder', isCommon: false },
  [PLAN_FEATURES.GRPO]: { getModels: getBooksModels, modelName: 'GrpoOrder', isCommon: false },
  [PLAN_FEATURES.BILL]: { getModels: getBooksModels, modelName: 'Bill', isCommon: false },
  [PLAN_FEATURES.PAYMENT_MADE]: { getModels: getBooksModels, modelName: 'PaymentMade', isCommon: false },
  [PLAN_FEATURES.RECURRING_BILL]: { getModels: getBooksModels, modelName: 'RecurringBills', isCommon: false },
  [PLAN_FEATURES.DEBIT_NOTES]: { getModels: getBooksModels, modelName: 'DebitNote', isCommon: false },
  [PLAN_FEATURES.MANUAL_JOURNAL]: { getModels: getBooksModels, modelName: 'ManualJournal', isCommon: false },
  [PLAN_FEATURES.PRODUCTION_ORDER]: { getModels: getBooksModels, modelName: 'ProductionOrder', isCommon: false },
  [PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL]: { getModels: getBooksModels, modelName: 'Invoice', isCommon: false },
  [PLAN_FEATURES.ONLY_E_WAY_BILL]: { getModels: getBooksModels, modelName: 'Invoice', isCommon: false },
  [PLAN_FEATURES.ACCOUNT_LEDGER]: { getModels: getBooksModels, modelName: 'AccountLedger', isCommon: false },
  [PLAN_FEATURES.CUSTOMER_ORDER]: { getModels: getBooksModels, modelName: 'CustomerOrder', isCommon: false },
  [PLAN_FEATURES.REJECTION_ORDER]: { getModels: getBooksModels, modelName: 'RejectionOrder', isCommon: false },
  [PLAN_FEATURES.INCENTIVE]: { getModels: getBooksCrmModels, modelName: 'IncentiveScheme', isCommon: false },
  [PLAN_FEATURES.COMPLAINTS]: { getModels: getBooksModels, modelName: 'Complaint', isCommon: false },
};

module.exports = { FEATURE_MODEL_MAP };
