const logger = require('../config/logger');
const { getBooksCrmModels, getBooksModels, getCommonModels } = require('./model.service');
const { PAYMENT_STATUS, INVOICE_STATUS, BILL_STATUSES, CONTACT_TYPE, TRANSACTION_TYPE } = require('../utils/enum');
const { applyAdvancePaymentReceivedAgainstInvoice } = require('../modules/sales/paymentReceived/paymentReceived.service');
const { applyAdvancePaymentMadeAgainstBill } = require('../modules/purchase/paymentMade/paymentMade.service');

const AUTO_PAY_SCOPES = {
  ALL_BRANCHES: 'ALL_BRANCHES',
  BRANCH_WISE: 'BRANCH_WISE',
};

const ELIGIBLE_INVOICE_STATUSES = [
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.UNPAID,
  INVOICE_STATUS.PARTIALLY_PAID,
  INVOICE_STATUS.OVERDUE,
];

const ELIGIBLE_BILL_STATUSES = [BILL_STATUSES.OPEN, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.OVERDUE];

const getModuleConfig = (autoPayConfig, moduleKey) => {
  const moduleConfig = autoPayConfig?.[moduleKey] || {};
  return {
    isEnabled: Boolean(moduleConfig.isEnabled),
    scope: moduleConfig.scope === AUTO_PAY_SCOPES.BRANCH_WISE ? AUTO_PAY_SCOPES.BRANCH_WISE : AUTO_PAY_SCOPES.ALL_BRANCHES,
  };
};

const roundAmount = value => parseFloat(Number(value || 0).toFixed(2));

const getPendingOpeningReceivables = async (OpeningBalanceTransaction, { companyId, customerId, branchId, scope }) => {
  const $match = {
    companyId,
    contactId: customerId,
    contactType: CONTACT_TYPE.CUSTOMER,
    type: TRANSACTION_TYPE.OPENING_RECEIVABLE,
    remainingAmount: { $gt: 0 },
  };

  if (scope === AUTO_PAY_SCOPES.BRANCH_WISE) {
    $match.branchId = branchId;
  }

  return OpeningBalanceTransaction.aggregate([
    { $match },
    { $project: { _id: 1, transactionNo: 1, remainingAmount: 1, date: 1, createdAt: 1 } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
  ]);
};

const getPendingOpeningPayables = async (OpeningBalanceTransaction, { companyId, vendorId, branchId, scope }) => {
  const $match = {
    companyId,
    contactId: vendorId,
    contactType: CONTACT_TYPE.VENDOR,
    type: TRANSACTION_TYPE.OPENING_PAYABLE,
    remainingAmount: { $gt: 0 },
  };

  if (scope === AUTO_PAY_SCOPES.BRANCH_WISE) {
    $match.branchId = branchId;
  }

  return OpeningBalanceTransaction.aggregate([
    { $match },
    { $project: { _id: 1, transactionNo: 1, remainingAmount: 1, date: 1, createdAt: 1 } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
  ]);
};

const getPendingInvoices = async (Invoice, { companyId, customerId, branchId, isSplit, scope }) => {
  const $match = {
    companyId,
    customerId,
    isSplit: !!isSplit,
    balanceAmount: { $gt: 0 },
    status: { $in: ELIGIBLE_INVOICE_STATUSES },
  };

  if (scope === AUTO_PAY_SCOPES.BRANCH_WISE) {
    $match.branchId = branchId;
  }

  return Invoice.aggregate([
    { $match },
    { $project: { _id: 1, invoiceId: 1, balanceAmount: 1, dueDate: 1, createdAt: 1 } },
    { $sort: { dueDate: 1, createdAt: 1, _id: 1 } },
  ]);
};

const getPendingBills = async (Bill, { companyId, vendorId, branchId, isSplit, scope }) => {
  const $match = {
    companyId,
    vendor: vendorId,
    isSplit: !!isSplit,
    balanceAmount: { $gt: 0 },
    status: { $in: ELIGIBLE_BILL_STATUSES },
  };

  if (scope === AUTO_PAY_SCOPES.BRANCH_WISE) {
    $match.branchId = branchId;
  }

  return Bill.aggregate([
    { $match },
    { $project: { _id: 1, billId: 1, balanceAmount: 1, dueDate: 1, createdAt: 1 } },
    { $sort: { dueDate: 1, createdAt: 1, _id: 1 } },
  ]);
};

const applyAdvancesToOpeningBalances = async ({ payments, paymentUnusedMap, pendingOpeningBalances, applyFn, logContext }) => {
  if (!pendingOpeningBalances.length) {
    return;
  }

  const obRemainingMap = new Map(pendingOpeningBalances.map(ob => [ob._id.toString(), roundAmount(ob.remainingAmount)]));

  for (const payment of payments) {
    const paymentKey = payment._id.toString();
    let remainingPayment = paymentUnusedMap.get(paymentKey) || 0;
    if (remainingPayment <= 0) {
      continue;
    }

    const obToApply = [];
    const obDeductions = new Map();

    for (const obTxn of pendingOpeningBalances) {
      if (remainingPayment <= 0) {
        break;
      }

      const obKey = obTxn._id.toString();
      const obRemaining = obRemainingMap.get(obKey) || 0;
      if (obRemaining <= 0) {
        continue;
      }

      const amountApplied = roundAmount(Math.min(remainingPayment, obRemaining));
      if (amountApplied <= 0) {
        continue;
      }

      obToApply.push({ openingBalanceTransactionId: obTxn._id, amountApplied });
      obDeductions.set(obKey, amountApplied);
      remainingPayment = roundAmount(remainingPayment - amountApplied);
    }

    if (!obToApply.length) {
      continue;
    }

    try {
      await applyFn(payment, obToApply);
      paymentUnusedMap.set(paymentKey, remainingPayment);
      for (const [obId, deduction] of obDeductions) {
        obRemainingMap.set(obId, roundAmount((obRemainingMap.get(obId) || 0) - deduction));
      }
    } catch (error) {
      logger.error('Company Auto Pay failed while applying advance to opening balance', {
        ...logContext,
        paymentId: payment._id,
        message: error?.message,
      });
    }
  }
};

const applyAdvancesToDocuments = async ({
  payments,
  paymentUnusedMap,
  pendingDocuments,
  remainingMap,
  buildApplyPayload,
  applyFn,
  logContext,
}) => {
  if (!pendingDocuments.length) {
    return;
  }

  for (const payment of payments) {
    const paymentKey = payment._id.toString();
    let remainingPayment = paymentUnusedMap.get(paymentKey) || 0;
    if (remainingPayment <= 0) {
      continue;
    }

    for (const doc of pendingDocuments) {
      if (remainingPayment <= 0) {
        break;
      }

      const docKey = doc._id.toString();
      const docRemaining = remainingMap.get(docKey) || 0;
      if (docRemaining <= 0) {
        continue;
      }

      const amountApplied = roundAmount(Math.min(remainingPayment, docRemaining));
      if (amountApplied <= 0) {
        continue;
      }

      try {
        await applyFn(payment, buildApplyPayload(doc, amountApplied));
        remainingPayment = roundAmount(remainingPayment - amountApplied);
        remainingMap.set(docKey, roundAmount(docRemaining - amountApplied));
        paymentUnusedMap.set(paymentKey, remainingPayment);
      } catch (error) {
        logger.error('Company Auto Pay failed while applying advance to document', {
          ...logContext,
          documentId: doc._id,
          paymentId: payment._id,
          message: error?.message,
        });
      }
    }
  }
};

const tryAutoPayForInvoice = async ({ invoiceId, companyId, userId }) => {
  try {
    const { CompanySettings } = getCommonModels();
    const { Invoice } = getBooksModels();
    const { PaymentReceived, OpeningBalanceTransaction } = getBooksCrmModels();

    const settings = await CompanySettings.findOne({ companyId }).select('autoPayConfig').lean();
    const config = getModuleConfig(settings?.autoPayConfig, 'invoice');
    if (!config.isEnabled) {
      return;
    }

    const invoice = await Invoice.findOne({ _id: invoiceId, companyId }).lean();
    if (!invoice) {
      return;
    }

    if (!ELIGIBLE_INVOICE_STATUSES.includes(invoice.status)) {
      return;
    }

    if (!(Number(invoice.balanceAmount) > 0)) {
      return;
    }

    if (!invoice.customerId) {
      logger.warn('Company Auto Pay skipped: invoice missing customerId', { invoiceId, companyId });
      return;
    }

    if (config.scope === AUTO_PAY_SCOPES.BRANCH_WISE && !invoice.branchId) {
      logger.warn('Company Auto Pay skipped: BRANCH_WISE requires invoice branchId', { invoiceId, companyId });
      return;
    }

    const paymentMatch = {
      companyId: invoice.companyId,
      customerId: invoice.customerId,
      status: PAYMENT_STATUS.APPROVED,
      unusedAmount: { $gt: 0 },
      isSplit: !!invoice.isSplit,
    };

    if (config.scope === AUTO_PAY_SCOPES.BRANCH_WISE) {
      paymentMatch.branchId = invoice.branchId;
    }

    const payments = await PaymentReceived.find(paymentMatch).sort({ createdAt: 1, _id: 1 });
    if (!payments.length) {
      return;
    }

    const eligiblePayments = [];
    for (const payment of payments) {
      if (config.scope === AUTO_PAY_SCOPES.BRANCH_WISE && !payment.branchId) {
        logger.warn('Company Auto Pay skipped advance: BRANCH_WISE requires payment branchId', {
          invoiceId,
          companyId,
          paymentReceivedId: payment._id,
        });
        continue;
      }
      eligiblePayments.push(payment);
    }

    if (!eligiblePayments.length) {
      return;
    }

    const paymentUnusedMap = new Map(
      eligiblePayments.map(payment => [payment._id.toString(), roundAmount(payment.unusedAmount)]),
    );

    const pendingOpeningReceivables = await getPendingOpeningReceivables(OpeningBalanceTransaction, {
      companyId: invoice.companyId,
      customerId: invoice.customerId,
      branchId: invoice.branchId,
      scope: config.scope,
    });

    await applyAdvancesToOpeningBalances({
      payments: eligiblePayments,
      paymentUnusedMap,
      pendingOpeningBalances: pendingOpeningReceivables,
      applyFn: (payment, obToApply) => applyAdvancePaymentReceivedAgainstInvoice(payment._id, companyId, [], obToApply, userId),
      logContext: { invoiceId, companyId },
    });

    const pendingInvoices = await getPendingInvoices(Invoice, {
      companyId: invoice.companyId,
      customerId: invoice.customerId,
      branchId: invoice.branchId,
      isSplit: invoice.isSplit,
      scope: config.scope,
    });

    const invoiceRemainingMap = new Map(pendingInvoices.map(inv => [inv._id.toString(), roundAmount(inv.balanceAmount)]));

    await applyAdvancesToDocuments({
      payments: eligiblePayments,
      paymentUnusedMap,
      pendingDocuments: pendingInvoices,
      remainingMap: invoiceRemainingMap,
      buildApplyPayload: (inv, amountApplied) => [{ invoiceId: inv._id, invoiceNo: inv.invoiceId, amountApplied }],
      applyFn: (payment, invoicesToApply) =>
        applyAdvancePaymentReceivedAgainstInvoice(payment._id, companyId, invoicesToApply, [], userId),
      logContext: { invoiceId, companyId },
    });
  } catch (error) {
    logger.error('Company Auto Pay failed for invoice', {
      invoiceId,
      companyId,
      message: error?.message,
    });
  }
};

const tryAutoPayForBill = async ({ billId, companyId, userId }) => {
  try {
    const { CompanySettings } = getCommonModels();
    const { Bill, PaymentMade } = getBooksModels();
    const { OpeningBalanceTransaction } = getBooksCrmModels();

    const settings = await CompanySettings.findOne({ companyId }).select('autoPayConfig').lean();
    const config = getModuleConfig(settings?.autoPayConfig, 'bill');
    if (!config.isEnabled) {
      return;
    }

    const bill = await Bill.findOne({ _id: billId, companyId }).lean();
    if (!bill) {
      return;
    }

    if (!ELIGIBLE_BILL_STATUSES.includes(bill.status)) {
      return;
    }

    if (!(Number(bill.balanceAmount) > 0)) {
      return;
    }

    if (!bill.vendor) {
      logger.warn('Company Auto Pay skipped: bill missing vendor', { billId, companyId });
      return;
    }

    if (config.scope === AUTO_PAY_SCOPES.BRANCH_WISE && !bill.branchId) {
      logger.warn('Company Auto Pay skipped: BRANCH_WISE requires bill branchId', { billId, companyId });
      return;
    }

    const paymentMatch = {
      companyId: bill.companyId,
      vendorId: bill.vendor,
      status: PAYMENT_STATUS.APPROVED,
      unusedAmount: { $gt: 0 },
      isSplit: !!bill.isSplit,
    };

    if (config.scope === AUTO_PAY_SCOPES.BRANCH_WISE) {
      paymentMatch.branchId = bill.branchId;
    }

    const payments = await PaymentMade.find(paymentMatch).sort({ createdAt: 1, _id: 1 });
    if (!payments.length) {
      return;
    }

    const eligiblePayments = [];
    for (const payment of payments) {
      if (config.scope === AUTO_PAY_SCOPES.BRANCH_WISE && !payment.branchId) {
        logger.warn('Company Auto Pay skipped advance: BRANCH_WISE requires payment branchId', {
          billId,
          companyId,
          paymentMadeId: payment._id,
        });
        continue;
      }
      eligiblePayments.push(payment);
    }

    if (!eligiblePayments.length) {
      return;
    }

    const paymentUnusedMap = new Map(
      eligiblePayments.map(payment => [payment._id.toString(), roundAmount(payment.unusedAmount)]),
    );

    const pendingOpeningPayables = await getPendingOpeningPayables(OpeningBalanceTransaction, {
      companyId: bill.companyId,
      vendorId: bill.vendor,
      branchId: bill.branchId,
      scope: config.scope,
    });

    await applyAdvancesToOpeningBalances({
      payments: eligiblePayments,
      paymentUnusedMap,
      pendingOpeningBalances: pendingOpeningPayables,
      applyFn: (payment, obToApply) => applyAdvancePaymentMadeAgainstBill(payment._id, companyId, [], obToApply, userId),
      logContext: { billId, companyId },
    });

    const pendingBills = await getPendingBills(Bill, {
      companyId: bill.companyId,
      vendorId: bill.vendor,
      branchId: bill.branchId,
      isSplit: bill.isSplit,
      scope: config.scope,
    });

    const billRemainingMap = new Map(
      pendingBills.map(pendingBill => [pendingBill._id.toString(), roundAmount(pendingBill.balanceAmount)]),
    );

    await applyAdvancesToDocuments({
      payments: eligiblePayments,
      paymentUnusedMap,
      pendingDocuments: pendingBills,
      remainingMap: billRemainingMap,
      buildApplyPayload: (pendingBill, amountApplied) => [{ billId: pendingBill._id, billNo: pendingBill.billId, amountApplied }],
      applyFn: (payment, billsToApply) => applyAdvancePaymentMadeAgainstBill(payment._id, companyId, billsToApply, [], userId),
      logContext: { billId, companyId },
    });
  } catch (error) {
    logger.error('Company Auto Pay failed for bill', {
      billId,
      companyId,
      message: error?.message,
    });
  }
};

module.exports = {
  tryAutoPayForInvoice,
  tryAutoPayForBill,
};
