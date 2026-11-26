const { updateBranchCurrentBalance } = require('../services/customerValidation.service');
const { multipleDefaultBranchEntry } = require('./defaultCustomerBranchEntry');

const toId = value => {
  if (!value) return null;
  if (typeof value === 'object' && (value._id || value.id)) return value._id || value.id;
  return value;
};

const allocatePaymentBranchBalances = async ({
  customerId,
  paymentBranchId,
  unusedAmount = 0,
  applications = [],
  session,
  reverse = false,
}) => {
  if (!customerId || !paymentBranchId) return;

  const sign = reverse ? 1 : -1;
  const byBranch = new Map();

  const add = (branchId, amount) => {
    const id = toId(branchId);
    const amt = Number(amount) || 0;
    if (!id || !amt) return;
    byBranch.set(String(id), (byBranch.get(String(id)) || 0) + amt);
  };

  for (const app of applications) {
    add(app.branchId, app.amount);
  }
  add(paymentBranchId, unusedAmount);

  const branchIds = [...byBranch.keys()];
  if (branchIds.length) {
    await multipleDefaultBranchEntry(customerId, branchIds, session);
  }

  for (const [branchId, amount] of byBranch.entries()) {
    await updateBranchCurrentBalance({
      customerId,
      branchId,
      amount: sign * amount,
      session,
    });
  }
};

const moveAdvanceApplyBranchBalances = async ({
  customerId,
  paymentBranchId,
  documentBranchId,
  amount,
  session,
  reverse = false,
}) => {
  const paymentBranch = toId(paymentBranchId);
  const documentBranch = toId(documentBranchId);
  const amt = Number(amount) || 0;
  if (!customerId || !amt) return;
  // Nothing to track when neither side is branch-scoped.
  if (!paymentBranch && !documentBranch) return;
  // Same-branch application is a net-zero move; skip.
  if (paymentBranch && documentBranch && String(paymentBranch) === String(documentBranch)) return;

  const branchIdsToEnsure = [paymentBranch, documentBranch].filter(Boolean);
  await multipleDefaultBranchEntry(customerId, branchIdsToEnsure, session);

  const sign = reverse ? -1 : 1;
  // Relieve each side independently. When the document has no branch (or the credit has no branch), only
  // the branch-scoped side is adjusted — the unbranched side's balance isn't tracked per-branch, so a
  // one-sided relief keeps the credit's per-branch balance consistent instead of being silently dropped.
  if (paymentBranch) {
    await updateBranchCurrentBalance({
      customerId,
      branchId: paymentBranch,
      amount: sign * amt,
      session,
    });
  }
  if (documentBranch) {
    await updateBranchCurrentBalance({
      customerId,
      branchId: documentBranch,
      amount: -sign * amt,
      session,
    });
  }
};

const collectPaymentApplications = async (payment, { Invoice, Bill, OpeningBalanceTransaction, Expenses }, session) => {
  const applications = [];

  if (Invoice) {
    for (const line of payment.invoices || []) {
      const amount = (Number(line.amountApplied) || 0) + (Number(line.tdsAmount) || 0);
      if (!amount || !line.invoiceId) continue;
      const invoice = await Invoice.findById(line.invoiceId).select('branchId').session(session).lean();
      applications.push({ branchId: invoice?.branchId || payment.branchId, amount });
    }
  }

  if (Bill) {
    for (const line of payment.bills || []) {
      const amount = Number(line.amountApplied) || 0;
      if (!amount || !line.billId) continue;
      const bill = await Bill.findById(line.billId).select('branchId').session(session).lean();
      applications.push({ branchId: bill?.branchId || payment.branchId, amount });
    }
  }

  if (OpeningBalanceTransaction) {
    for (const line of payment.openingBalanceTransactions || []) {
      const amount = Number(line.amountApplied) || 0;
      if (!amount || !line.openingBalanceTransactionId) continue;
      const txn = await OpeningBalanceTransaction.findById(line.openingBalanceTransactionId)
        .select('branchId')
        .session(session)
        .lean();
      applications.push({ branchId: txn?.branchId || payment.branchId, amount });
    }
  }

  if (Expenses) {
    for (const line of payment.expenses || []) {
      const expense = await Expenses.findById(line.expenseId).select('branchId').session(session).lean();
      applications.push({ branchId: expense.branchId, amount: Number(line.amountApplied) });
    }
  }

  return applications;
};

module.exports = {
  allocatePaymentBranchBalances,
  moveAdvanceApplyBranchBalances,
  collectPaymentApplications,
};
