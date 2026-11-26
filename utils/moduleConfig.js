const { getBooksCrmModels, getBooksModels } = require('../services/model.service');
const { MODULE_NAMES, RIGHT_LIST } = require('./enum');

const COMMENT_SUPPORTED_MODULES = [
  MODULE_NAMES.QUOTATION,
  MODULE_NAMES.SALES_ORDER,
  MODULE_NAMES.DELIVERY_CHALLAN,
  MODULE_NAMES.INVOICE,
  MODULE_NAMES.PAYMENT_RECEIVED,
  MODULE_NAMES.CREDIT_NOTE,
  MODULE_NAMES.PURCHASE_ORDER,
  MODULE_NAMES.GRPO,
  MODULE_NAMES.BILL,
  MODULE_NAMES.PAYMENT_MADE,
  MODULE_NAMES.DEBIT_NOTE,
  MODULE_NAMES.EXPENSE,
  MODULE_NAMES.CUSTOMER,
  MODULE_NAMES.VENDOR,
  MODULE_NAMES.RECURRING_BILL,
  MODULE_NAMES.RECURRING_INVOICE,
  MODULE_NAMES.RECURRING_EXPENSE,
];

const getCommentModuleConfig = moduleName => {
  const booksCrm = getBooksCrmModels();
  const books = getBooksModels();

  const config = {
    [MODULE_NAMES.QUOTATION]: {
      model: booksCrm.Quote,
      right: RIGHT_LIST.QUOTES,
    },
    [MODULE_NAMES.SALES_ORDER]: {
      model: booksCrm.SalesOrder,
      right: RIGHT_LIST.SALES_ORDER,
    },
    [MODULE_NAMES.DELIVERY_CHALLAN]: {
      model: books.DeliveryChallan,
      right: RIGHT_LIST.DELIVERY_CHALLANS,
    },
    [MODULE_NAMES.INVOICE]: {
      model: books.Invoice,
      right: RIGHT_LIST.INVOICES,
    },
    [MODULE_NAMES.PAYMENT_RECEIVED]: {
      model: booksCrm.PaymentReceived,
      right: RIGHT_LIST.PAYMENT_RECEIVED,
    },
    [MODULE_NAMES.CREDIT_NOTE]: {
      model: books.CreditNote,
      right: RIGHT_LIST.CREDIT_NOTES,
    },
    [MODULE_NAMES.PURCHASE_ORDER]: {
      model: books.PurchaseOrder,
      right: RIGHT_LIST.PURCHASE_ORDER,
    },
    [MODULE_NAMES.GRPO]: {
      model: books.GrpoOrder,
      right: RIGHT_LIST.GRPO,
    },
    [MODULE_NAMES.BILL]: {
      model: books.Bill,
      right: RIGHT_LIST.BILLS,
    },
    [MODULE_NAMES.PAYMENT_MADE]: {
      model: books.PaymentMade,
      right: RIGHT_LIST.PAYMENT_MADE,
    },
    [MODULE_NAMES.DEBIT_NOTE]: {
      model: books.DebitNote,
      right: RIGHT_LIST.DEBIT_NOTE,
    },
    [MODULE_NAMES.EXPENSE]: {
      model: books.Expenses,
      right: RIGHT_LIST.EXPENSES,
    },
    [MODULE_NAMES.CUSTOMER]: {
      model: booksCrm.Customer,
      right: RIGHT_LIST.CUSTOMER_MASTER,
    },
    [MODULE_NAMES.VENDOR]: {
      model: booksCrm.Customer,
      right: RIGHT_LIST.VENDORS,
    },
    [MODULE_NAMES.RECURRING_INVOICE]: {
      model: books.RecurringInvoice,
      right: RIGHT_LIST.RECURRING_INVOICE,
    },
    [MODULE_NAMES.RECURRING_BILL]: {
      model: books.RecurringBills,
      right: RIGHT_LIST.RECURRING_BILLS,
    },
    [MODULE_NAMES.RECURRING_EXPENSE]: {
      model: books.RecurringExpense,
      right: RIGHT_LIST.RECURRING_EXPENSES,
    },
  };

  return config[moduleName] || null;
};

module.exports = {
  COMMENT_SUPPORTED_MODULES,
  getCommentModuleConfig,
};
