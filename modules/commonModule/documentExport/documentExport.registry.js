const { RIGHT_LIST, DOCUMENT_EXPORT_PDF_VARIANT } = require('../../../utils/enum');

const MODULE_TYPE_CONFIG = {
  quote: {
    right: RIGHT_LIST.QUOTES,
    pageType: 'quote',
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../sales/quote/quote.service');
      return { queryExports: svc.queryQuotesExports, getById: svc.getQuoteById };
    },
  },
  salesOrder: {
    right: RIGHT_LIST.SALES_ORDER,
    pageType: 'salesOrder',
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../sales/salesOrder/salesOrder.service');
      return { queryExports: svc.querySalesOrdersExports, getById: svc.getSalesOrderById };
    },
  },
  deliveryChallan: {
    right: RIGHT_LIST.DELIVERY_CHALLANS,
    pageType: 'deliveryChallan',
    pdfVariants: [DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL],
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../sales/deliveryChallan/deliveryChallan.service');
      return { queryExports: svc.queryDeliveryChallansExports, getById: svc.getDeliveryChallanById };
    },
  },
  invoice: {
    right: RIGHT_LIST.INVOICES,
    pageType: 'invoice',
    pdfVariants: [
      DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE,
      DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL,
      DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE_AND_E_WAY_BILL,
    ],
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../sales/invoice/invoice.service');
      return { queryExports: svc.queryInvoicesExports, getById: svc.getInvoiceById };
    },
  },
  paymentReceived: {
    right: RIGHT_LIST.PAYMENT_RECEIVED,
    pdfRenderer: 'payment',
    paymentVariant: 'received',
    getAdapters: () => {
      const svc = require('../../sales/paymentReceived/paymentReceived.service');
      return { queryExports: svc.queryPaymentsExports, getById: svc.getPaymentById };
    },
  },
  purchaseOrder: {
    right: RIGHT_LIST.PURCHASE_ORDER,
    pageType: 'purchaseOrder',
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../purchase/purchaseOrder/purchaseOrder.service');
      return { queryExports: svc.queryPurchaseOrdersExports, getById: svc.getPurchaseOrder };
    },
  },
  grpo: {
    right: RIGHT_LIST.GRPO,
    pageType: 'grpo',
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../purchase/grpo/grpoOrder.service');
      return { queryExports: svc.queryGrpoOrdersExports, getById: svc.getGrpoOrder };
    },
  },
  bill: {
    right: RIGHT_LIST.BILLS,
    pageType: 'bills',
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../purchase/bill/bill.service');
      return { queryExports: svc.queryBillsExports, getById: svc.getBillById };
    },
  },
  creditNote: {
    right: RIGHT_LIST.CREDIT_NOTES,
    pageType: 'creditNote',
    pdfVariants: [
      DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE,
      DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL,
      DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE_AND_E_WAY_BILL,
    ],
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../sales/creditNote/creditNote.service');
      return {
        queryExports: (filter, options) => svc.queryCreditNotesExports(filter, filter, options),
        getById: svc.getCreditNoteById,
      };
    },
  },
  debitNote: {
    right: RIGHT_LIST.DEBIT_NOTE,
    pageType: 'debitNote',
    pdfVariants: [DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL],
    pdfRenderer: 'document',
    getAdapters: () => {
      const svc = require('../../purchase/debitNote/debitNote.service');
      return {
        queryExports: (filter, options) => svc.queryDebitNotesExports(filter, filter, options),
        getById: svc.getDebitNoteById,
      };
    },
  },
  expense: {
    right: RIGHT_LIST.EXPENSES,
    pdfRenderer: 'expense',
    getAdapters: () => {
      const svc = require('../../purchase/expense/expense.service');
      return {
        queryExports: (filter, options) => svc.getExpensesExports(filter, filter, options),
        getById: svc.getExpenseById,
      };
    },
  },
  paymentMade: {
    right: RIGHT_LIST.PAYMENT_MADE,
    pdfRenderer: 'payment',
    paymentVariant: 'made',
    getAdapters: () => {
      const svc = require('../../purchase/paymentMade/paymentMade.service');
      return {
        queryExports: (filter, options) => svc.queryPaymentMadesExports({}, filter, options),
        getById: svc.getPaymentMadeById,
      };
    },
  },
};

const SUPPORTED_MODULE_TYPES = Object.keys(MODULE_TYPE_CONFIG);

const getModuleExportConfig = moduleType => MODULE_TYPE_CONFIG[moduleType] || null;

module.exports = {
  SUPPORTED_MODULE_TYPES,
  getModuleExportConfig,
};
