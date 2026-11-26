const mongoose = require('mongoose');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const {
  LEDGER_SOURCE_MODULES,
  SYSTEM_ACCOUNT_KEYS,
  LEDGER_PARTY_TYPES,
  ACCOUNT_CATEGORIES,
  CONTACT_TYPE,
  TAX_TYPES,
} = require('../../../utils/enum');
const { EXPENSE_TAX_SPLIT } = require('@smit9313/abss-models-core/src/utils/enum');
const { SOURCE_DOCUMENTS } = require('../../../utils/enum');
const { getUniqueIds, getNameMap } = require('../../../utils/helper');
const { BALANCE_TYPES } = require('@smit9313/abss-models-core/src/utils/enum');

// Convert rupees to paise so debit/credit totals can be compared without float drift.
const toPaise = value => Math.round((Number(value) || 0) * 100);

// Round currency values to two decimals before building journal line totals.
const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

// Resolve a company system account (Sales, COGS, GST, etc.) by its systemAccountKey.
const resolveSystemAccount = async (companyId, systemAccountKey, session = null) => {
  const { Account } = getBooksModels();
  const account = await Account.findOne({ companyId, systemAccountKey, isSystemAccount: true, isActive: true }).session(session);
  if (!account) {
    throw new ApiError(httpStatus.NOT_FOUND, `System account ${systemAccountKey} not found`);
  }
  return account;
};

// Resolve customer/vendor AR or AP control account from the party master accountId.
const resolvePartyControlAccount = async (companyId, partyId, session = null) => {
  if (!companyId || !partyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'companyId and partyId are required');
  }

  const { Customer } = getBooksCrmModels();
  const { Account } = getBooksModels();
  const party = await Customer.findOne({ _id: partyId, companyId }).select('accountId').session(session).lean();
  if (!party) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Customer or vendor not found');
  }
  if (!party.accountId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No receivable/payable account is assigned on this customer or vendor');
  }

  const account = await Account.findOne({ _id: party.accountId, companyId, isActive: true })
    .session(session)
    .select('_id')
    .lean();
  if (!account) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Assigned control account not found or inactive');
  }

  return account._id;
};

// Validate balanced journal lines and persist them as posted LedgerEntry rows.
// Every line carries the document's branch and division, so the ledger alone can answer
// "what happened at this branch" without going back to the documents.
const postJournal = async (
  {
    companyId,
    postingDate,
    sourceModule,
    sourceId,
    narration = null,
    lines = [],
    addedBy = null,
    isSplit = false,
    currencyId = null,
    exchangeRate = null,
  },
  session = null,
) => {
  if (!companyId || !postingDate || !sourceModule || !sourceId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Journal companyId, postingDate, sourceModule and sourceId are required');
  }
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A journal needs at least two lines');
  }

  // Validate each line has one side only and sum debits/credits in paise to avoid float mismatch.
  for (const line of lines) {
    const debit = toPaise(line.debit);
    const credit = toPaise(line.credit);
    if (!line.accountId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Every journal line needs an accountId');
    }
    if (debit < 0 || credit < 0 || (debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Every journal line must have exactly one of debit or credit');
    }
  }

  // Every line carries the branch and division of the document that raised the journal.
  const source = SOURCE_DOCUMENTS[sourceModule];
  let document = null;
  if (source?.modelKey) {
    const SourceModel = (source.db === 'booksCrm' ? getBooksCrmModels() : getBooksModels())[source.modelKey];
    if (SourceModel) {
      document = await SourceModel.findById(sourceId).select('branchId divisionId').session(session).lean();
    }
  }

  const rate = Number(exchangeRate) || 1;

  const toBase = (amount, line) => {
    if (line.inBaseCurrency) return round2(amount);
    return round2((Number(amount) || 0) * (Number(line.exchangeRate) || rate));
  };
  const converted = lines.map(line => ({
    line,
    debitBase: toBase(line.debit, line),
    creditBase: toBase(line.credit, line),
  }));

  const debitPaise = converted.reduce((sum, row) => sum + toPaise(row.debitBase), 0);
  const creditPaise = converted.reduce((sum, row) => sum + toPaise(row.creditBase), 0);
  const drift = debitPaise - creditPaise;

  const ROUNDING_TOLERANCE_PAISE = 5;
  if (drift !== 0) {
    if (Math.abs(drift) > ROUNDING_TOLERANCE_PAISE) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Journal is not balanced: debits ${debitPaise / 100} do not equal credits ${creditPaise / 100}`,
      );
    }
    const side = drift > 0 ? 'creditBase' : 'debitBase';
    const target = converted.filter(row => row[side] > 0).sort((a, b) => b[side] - a[side])[0];
    if (!target) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Journal cannot be balanced after currency conversion');
    }
    target[side] = round2(target[side] + Math.abs(drift) / 100);
  }

  // Build one LedgerEntry row per line under a shared journalId and insert as POSTED.
  const { LedgerEntry } = getBooksModels();
  const journalId = new mongoose.Types.ObjectId();

  // A journal is dated, not timed. Documents pass a plain date while payments and opening
  // balances pass "now", so without this two entries on the same day sort by whatever time
  // each module happened to send, and a newly created entry can land below an older one.
  // UTC, because that is where a plain date lands and what the period filters compare against.
  const entryDate = new Date(postingDate);
  entryDate.setUTCHours(0, 0, 0, 0);

  const rows = converted.map(({ line, debitBase, creditBase }) => ({
    companyId,
    journalId,
    accountId: line.accountId,
    postingDate: entryDate,
    debit: debitBase,
    credit: creditBase,
    currencyId: line.inBaseCurrency ? null : (line.currencyId ?? currencyId),
    foreignAmount: line.inBaseCurrency ? null : round2(line.debit) || round2(line.credit) || 0,
    exchangeRate: line.inBaseCurrency || !(line.currencyId ?? currencyId) ? null : Number(line.exchangeRate) || rate,
    sourceModule,
    sourceId,
    isSplit: isSplit === true,
    branchId: line.branchId ?? document?.branchId ?? null,
    divisionId: line.divisionId ?? document?.divisionId ?? null,
    partyId: line.partyId || null,
    partyType: line.partyType || null,
    narration: line.narration ?? narration,
    addedBy,
  }));

  await LedgerEntry.insertMany(rows, { session });
  return journalId;
};

// Remove a source document's entries from the books. Editing or cancelling a document
// replaces its journal instead of layering reversal entries on top, so the ledger only ever
// holds the current version of each document.
const deleteJournal = async ({ companyId, sourceModule, sourceId }, session = null) => {
  const { LedgerEntry } = getBooksModels();

  const result = await LedgerEntry.deleteMany({ companyId, sourceModule, sourceId }, { session });
  return result.deletedCount;
};

const postCrossBranchCreditApplyJournal = async (
  {
    companyId,
    partyId,
    partyType,
    creditBranchId,
    documentBranchId,
    creditDivisionId = null,
    documentDivisionId = null,
    amount,
    postingDate,
    sourceModule,
    sourceId,
    narration = null,
    addedBy = null,
    currencyId = null,
    exchangeRate = null,
  },
  session = null,
) => {
  const amt = round2(Math.abs(Number(amount) || 0));
  if (
    !companyId ||
    !partyId ||
    !partyType ||
    !creditBranchId ||
    !documentBranchId ||
    !postingDate ||
    !sourceModule ||
    !sourceId ||
    !amt
  ) {
    return null;
  }
  if (String(creditBranchId) === String(documentBranchId)) {
    return null;
  }

  const isVendor = partyType === LEDGER_PARTY_TYPES.VENDOR;
  const accountId = await resolvePartyControlAccount(companyId, partyId, session);

  const creditLine = {
    accountId,
    partyId,
    partyType,
    branchId: creditBranchId,
    divisionId: creditDivisionId,
  };
  const documentLine = {
    accountId,
    partyId,
    partyType,
    branchId: documentBranchId,
    divisionId: documentDivisionId,
  };

  if (isVendor) {
    creditLine.credit = amt;
    documentLine.debit = amt;
  } else {
    creditLine.debit = amt;
    documentLine.credit = amt;
  }

  return postJournal(
    {
      companyId,
      postingDate,
      sourceModule,
      sourceId,
      narration,
      lines: [creditLine, documentLine],
      addedBy,
      currencyId,
      exchangeRate,
    },
    session,
  );
};

// Post chart-of-account opening balance against the Opening Balance Adjustment system account.
const postOpeningBalanceJournal = async (
  {
    companyId,
    accountId,
    amount,
    balanceType,
    postingDate,
    sourceId,
    partyId = null,
    partyType = null,
    narration = 'Opening balance',
    addedBy = null,
    currencyId = null,
    exchangeRate = null,
    sourceModule,
    isSplit = false,
  },
  session = null,
) => {
  const normalizedAmount = Math.abs(Number(amount) || 0);
  if (!companyId || !accountId || !balanceType || !postingDate || !sourceId || !normalizedAmount) {
    return;
  }

  const adjustment = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.OPENING_BALANCE_ADJUSTMENT, session);

  const isDebit = balanceType === BALANCE_TYPES.DEBIT;
  const baseAmount = round2(normalizedAmount * (Number(exchangeRate) || 1));
  const lines = isDebit
    ? [
        { accountId, debit: normalizedAmount, partyId, partyType },
        { accountId: adjustment._id, credit: baseAmount, inBaseCurrency: true },
      ]
    : [
        { accountId: adjustment._id, debit: baseAmount, inBaseCurrency: true },
        { accountId, credit: normalizedAmount, partyId, partyType },
      ];

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule,
      sourceId,
      narration,
      lines,
      addedBy,
      currencyId,
      exchangeRate,
      isSplit: isSplit === true,
    },
    session,
  );
};

// Dr destination / Cr source: each leg uses its own currency and base rate; same-currency transfers stay a plain two-line entry.
const postBankTransferJournal = async (
  {
    companyId,
    postingDate,
    sourceId,
    sourceModule,
    narration = null,
    addedBy = null,
    debitAccountId,
    debitAmount,
    debitCurrencyId = null,
    debitExchangeRate = null,
    creditAccountId,
    creditAmount,
    creditCurrencyId = null,
    creditExchangeRate = null,
  },
  session = null,
) => {
  const toAmount = Math.abs(Number(debitAmount) || 0);
  const fromAmount = Math.abs(Number(creditAmount) || 0);
  if (!companyId || !debitAccountId || !creditAccountId || !postingDate || !sourceId || !toAmount || !fromAmount) {
    return;
  }

  const lines = [
    { accountId: debitAccountId, debit: toAmount, currencyId: debitCurrencyId, exchangeRate: debitExchangeRate },
    { accountId: creditAccountId, credit: fromAmount, currencyId: creditCurrencyId, exchangeRate: creditExchangeRate },
  ];

  // No FX line when both legs share the same base value; post gain/loss only when a real conversion makes the two sides differ.
  const debitBase = round2(toAmount * (Number(debitExchangeRate) || 1));
  const creditBase = round2(fromAmount * (Number(creditExchangeRate) || 1));
  const difference = round2(creditBase - debitBase);
  if (difference) {
    const fxAccount = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.EXCHANGE_GAIN_OR_LOSS, session);
    lines.push(
      difference > 0
        ? { accountId: fxAccount._id, debit: difference, inBaseCurrency: true }
        : { accountId: fxAccount._id, credit: Math.abs(difference), inBaseCurrency: true },
    );
  }

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule,
      sourceId,
      narration,
      lines,
      addedBy,
    },
    session,
  );
};

const buildAppliedAt = async (payment, session = null) => {
  const { Invoice, Bill, Expenses } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const appliedAt = [];

  for (const applied of [
    ...(payment.invoices || []).map(({ invoiceId, amountApplied, tdsAmount }) => ({
      id: invoiceId,
      amountApplied: (Number(amountApplied) || 0) + (Number(tdsAmount) || 0),
      Model: Invoice,
    })),
    ...(payment.bills || []).map(({ billId, amountApplied }) => ({ id: billId, amountApplied, Model: Bill })),
    ...(payment.openingBalanceTransactions || []).map(({ openingBalanceTransactionId, amountApplied }) => ({
      id: openingBalanceTransactionId,
      amountApplied,
      Model: OpeningBalanceTransaction,
    })),
    ...(payment.expenses || []).map(({ expenseId, amountApplied }) => ({ id: expenseId, amountApplied, Model: Expenses })),
  ]) {
    const amount = Number(applied.amountApplied) || 0;
    if (!amount) continue;

    const document = await applied.Model.findById(applied.id).select('exchangeRate branchId divisionId').session(session).lean();
    appliedAt.push({
      amount,
      exchangeRate: document?.exchangeRate ?? payment.exchangeRate ?? 1,
      branchId: document?.branchId || payment.branchId || null,
      divisionId: document?.divisionId || payment.divisionId || null,
    });
  }

  return appliedAt;
};

// Record customer payment: Dr bank for full receipt, Cr AR for applied amount and Unearned Revenue for advance.
const postPaymentReceivedJournal = async (
  {
    companyId,
    depositAccountId,
    appliedAmount,
    unusedAmount,
    partyId,
    postingDate,
    sourceId,
    narration = null,
    addedBy = null,
    isSplit = false,
    currencyId = null,
    exchangeRate = null,
    appliedAt = null,
  },
  session = null,
) => {
  // Same sub-paisa float-dust guard as payment made (see postPaymentMadeJournal).
  const applied = round2(Math.abs(Number(appliedAmount) || 0));
  const unused = round2(Math.abs(Number(unusedAmount) || 0));
  const total = round2(applied + unused);
  if (!companyId || !depositAccountId || !postingDate || !sourceId || !total) {
    return;
  }

  const { PaymentReceived } = getBooksCrmModels();
  const paymentDoc = await PaymentReceived.findById(sourceId)
    .select('branchId divisionId tdsAccountId invoices.tdsAmount')
    .session(session)
    .lean();
  const paymentBranchId = paymentDoc?.branchId || null;
  const paymentDivisionId = paymentDoc?.divisionId || null;
  // Income-tax TDS the customer withheld clears the receivable without cash.
  const tdsAmount = round2((paymentDoc?.invoices || []).reduce((sum, invoice) => sum + (Number(invoice.tdsAmount) || 0), 0));

  // Cash arrives at the rate on the day it was paid.
  const lines = [{ accountId: depositAccountId, debit: total, branchId: paymentBranchId, divisionId: paymentDivisionId }];
  if (tdsAmount > 0) {
    lines.push({
      accountId: paymentDoc.tdsAccountId,
      debit: tdsAmount,
      branchId: paymentBranchId,
      divisionId: paymentDivisionId,
    });
  }

  if (applied > 0) {
    const receivableAccountId = await resolvePartyControlAccount(companyId, partyId, session);
    const breakdown = (appliedAt || []).filter(part => round2(part.amount) > 0);
    if (breakdown.length) {
      for (const part of breakdown) {
        lines.push({
          accountId: receivableAccountId,
          credit: round2(part.amount),
          exchangeRate: part.exchangeRate,
          partyId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          branchId: part.branchId || paymentBranchId,
          divisionId: part.divisionId || paymentDivisionId,
        });
      }
    } else {
      lines.push({
        accountId: receivableAccountId,
        credit: round2(applied + tdsAmount),
        partyId,
        partyType: LEDGER_PARTY_TYPES.CUSTOMER,
        branchId: paymentBranchId,
        divisionId: paymentDivisionId,
      });
    }
  }
  if (unused > 0) {
    const unearnedRevenue = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.UNEARNED_REVENUE, session);
    lines.push({
      accountId: unearnedRevenue._id,
      credit: unused,
      partyId,
      partyType: LEDGER_PARTY_TYPES.CUSTOMER,
      branchId: paymentBranchId,
      divisionId: paymentDivisionId,
    });
  }

  // Post realized FX when cash and receivable rates differ; postJournal rounding is for stray paise only.
  if ((appliedAt || []).length) {
    const settledBase = round2((applied + tdsAmount) * (Number(exchangeRate) || 1));
    const clearedBase = round2(
      (appliedAt || []).reduce((sum, part) => sum + round2(part.amount) * (Number(part.exchangeRate) || 1), 0),
    );
    const difference = round2(settledBase - clearedBase);
    if (difference) {
      const fxAccount = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.EXCHANGE_GAIN_OR_LOSS, session);
      // More cash than the balance was carried at is a gain, which is a credit; less is a loss.
      lines.push(
        difference > 0
          ? {
              accountId: fxAccount._id,
              credit: difference,
              inBaseCurrency: true,
              branchId: paymentBranchId,
              divisionId: paymentDivisionId,
            }
          : {
              accountId: fxAccount._id,
              debit: Math.abs(difference),
              inBaseCurrency: true,
              branchId: paymentBranchId,
              divisionId: paymentDivisionId,
            },
      );
    }
  }

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED,
      sourceId,
      narration,
      lines,
      addedBy,
      isSplit,
      currencyId,
      exchangeRate,
    },
    session,
  );
};

// Refund unused customer advance from bank: Dr Unearned Revenue, Cr paid-from account.
const postCustomerRefundJournal = async (
  {
    companyId,
    fromAccountId,
    amount,
    partyId,
    postingDate,
    sourceId,
    narration = null,
    addedBy = null,
    currencyId = null,
    exchangeRate = null,
  },
  session = null,
) => {
  const normalizedAmount = Math.abs(Number(amount) || 0);
  if (!companyId || !fromAccountId || !postingDate || !sourceId || !normalizedAmount) {
    return;
  }

  const unearnedRevenue = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.UNEARNED_REVENUE, session);
  const lines = [
    { accountId: unearnedRevenue._id, debit: normalizedAmount, partyId, partyType: LEDGER_PARTY_TYPES.CUSTOMER },
    { accountId: fromAccountId, credit: normalizedAmount },
  ];

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED,
      sourceId,
      narration,
      lines,
      addedBy,
      currencyId,
      exchangeRate,
    },
    session,
  );
};

// Record vendor payment: Dr AP for applied amount, Dr Prepaid Expenses for advance, Cr paid-through account.
const postPaymentMadeJournal = async (
  {
    companyId,
    paidThroughAccountId,
    appliedAmount,
    unusedAmount,
    partyId,
    postingDate,
    sourceId,
    narration = null,
    addedBy = null,
    isSplit = false,
    currencyId = null,
    exchangeRate = null,
    appliedAt = null,
  },
  session = null,
) => {
  // Round before the > 0 checks: advance applications do unusedAmount -= amountApplied in a loop,
  // which can leave sub-paisa float dust (e.g. 1e-11). That passes > 0 but toPaise() is 0, which
  // then fails postJournal with "exactly one of debit or credit".
  const applied = round2(Math.abs(Number(appliedAmount) || 0));
  const unused = round2(Math.abs(Number(unusedAmount) || 0));
  const total = round2(applied + unused);
  if (!companyId || !paidThroughAccountId || !postingDate || !sourceId || !total) {
    return;
  }

  const { PaymentMade } = getBooksModels();
  const paymentDoc = await PaymentMade.findById(sourceId).select('branchId divisionId').session(session).lean();
  const paymentBranchId = paymentDoc?.branchId || null;
  const paymentDivisionId = paymentDoc?.divisionId || null;

  // Clear AP at each bill's booked rate so payment and payable can settle at different base amounts for FX.
  const lines = [];
  if (applied > 0) {
    const payableAccountId = await resolvePartyControlAccount(companyId, partyId, session);
    const breakdown = (appliedAt || []).filter(part => round2(part.amount) > 0);
    if (breakdown.length) {
      for (const part of breakdown) {
        lines.push({
          accountId: payableAccountId,
          debit: round2(part.amount),
          exchangeRate: part.exchangeRate,
          partyId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          branchId: part.branchId || paymentBranchId,
          divisionId: part.divisionId || paymentDivisionId,
        });
      }
    } else {
      lines.push({
        accountId: payableAccountId,
        debit: applied,
        partyId,
        partyType: LEDGER_PARTY_TYPES.VENDOR,
        branchId: paymentBranchId,
        divisionId: paymentDivisionId,
      });
    }
  }
  if (unused > 0) {
    const prepaidExpenses = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.PREPAID_EXPENSES, session);
    lines.push({
      accountId: prepaidExpenses._id,
      debit: unused,
      partyId,
      partyType: LEDGER_PARTY_TYPES.VENDOR,
      branchId: paymentBranchId,
      divisionId: paymentDivisionId,
    });
  }
  lines.push({ accountId: paidThroughAccountId, credit: total, branchId: paymentBranchId, divisionId: paymentDivisionId });

  // Signs invert vs receipt: paying more base than the bill carry rate is a loss, not a gain.
  if ((appliedAt || []).length) {
    const settledBase = round2(
      (appliedAt || []).reduce((sum, part) => sum + round2(part.amount) * (Number(part.exchangeRate) || 1), 0),
    );
    const clearedBase = round2(applied * (Number(exchangeRate) || 1));
    const difference = round2(settledBase - clearedBase);
    if (difference) {
      const fxAccount = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.EXCHANGE_GAIN_OR_LOSS, session);
      lines.push(
        difference > 0
          ? {
              accountId: fxAccount._id,
              credit: difference,
              inBaseCurrency: true,
              branchId: paymentBranchId,
              divisionId: paymentDivisionId,
            }
          : {
              accountId: fxAccount._id,
              debit: Math.abs(difference),
              inBaseCurrency: true,
              branchId: paymentBranchId,
              divisionId: paymentDivisionId,
            },
      );
    }
  }

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE,
      sourceId,
      narration,
      lines,
      addedBy,
      isSplit,
      currencyId,
      exchangeRate,
    },
    session,
  );
};

// Record vendor refund of unused prepaid amount: Dr bank, Cr Prepaid Expenses.
const postVendorRefundJournal = async (
  {
    companyId,
    toAccountId,
    amount,
    partyId,
    postingDate,
    sourceId,
    narration = null,
    addedBy = null,
    currencyId = null,
    exchangeRate = null,
  },
  session = null,
) => {
  const normalizedAmount = Math.abs(Number(amount) || 0);
  if (!companyId || !toAccountId || !postingDate || !sourceId || !normalizedAmount) {
    return;
  }

  const prepaidExpenses = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.PREPAID_EXPENSES, session);
  const lines = [
    { accountId: toAccountId, debit: normalizedAmount },
    { accountId: prepaidExpenses._id, credit: normalizedAmount, partyId, partyType: LEDGER_PARTY_TYPES.VENDOR },
  ];

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE,
      sourceId,
      narration,
      lines,
      addedBy,
      currencyId,
      exchangeRate,
    },
    session,
  );
};

/**
 * Tax-exclusive line amount for sales / purchase income/expense ledger lines.
 * Same formula as frontend calculateAmounts + middlewares/checkDocTotal:
 *   qty × rate, then item discount only when appliesTo === 'ITEM'.
 * Transaction-level discount stays on pushDiscountLine (line amounts stay pre-discount).
 * Legacy rows may store tax-inclusive values on item.amount while header subTotal/totalTax
 * are correct — prefer recomputation from qty/rate when both are present.
 */
const getTaxExclusiveLineAmount = (item, appliesTo) => {
  const quantity = Number(item?.quantity) || 0;
  const rate = Number(item?.rate) || 0;

  if (quantity && rate) {
    let amount = round2(quantity * rate);
    if (appliesTo === 'ITEM') {
      const { discountType, discountValue } = item?.discountConfig || {};
      if (discountType === 'PERCENTAGE') {
        amount = round2(amount - (amount * (Number(discountValue) || 0)) / 100);
      } else if (discountType === 'AMOUNT') {
        amount = round2(Math.max(0, amount - (Number(discountValue) || 0)));
      }
    }
    return amount;
  }

  return round2(item?.amount);
};

// Append document-level discount line; item-level discounts are already net in line amounts.
const pushDiscountLine = async (lines, companyId, document, accountKey, side, session) => {
  if (document.appliesTo !== 'TRANSACTION' || !(document.discountConfig?.discountValue > 0)) return;
  const { discountType, discountValue } = document.discountConfig;
  const discount =
    discountType === 'PERCENTAGE' ? round2((round2(document.subTotal) * discountValue) / 100) : round2(discountValue);
  if (!discount) return;
  const account = await resolveSystemAccount(companyId, accountKey, session);
  lines.push({ accountId: account._id, [side]: discount });
};

// Append SGST/CGST/IGST lines from document totals; split documents carry no tax posting.
const pushTaxLines = async (lines, companyId, document, taxKeys, side, session) => {
  if (document.isSplit) return;
  const taxes = [
    [taxKeys.sgst, round2(document.sgst)],
    [taxKeys.cgst, round2(document.cgst)],
    [taxKeys.igst, round2(document.igst)],
  ];
  for (const [key, amount] of taxes) {
    if (!amount) continue;
    const account = await resolveSystemAccount(companyId, key, session);
    lines.push({ accountId: account._id, [side]: amount });
  }
};

// Append additional charge lines; a negative net charge posts as a rebate on the opposite side.
const pushChargeLines = async (lines, companyId, document, accountKey, side, session) => {
  const charges = round2((document.additionalCharges || []).reduce((sum, charge) => sum + (Number(charge.amount) || 0), 0));
  if (!charges) return;
  const account = await resolveSystemAccount(companyId, accountKey, session);
  const oppositeSide = side === 'debit' ? 'credit' : 'debit';
  lines.push({ accountId: account._id, [charges > 0 ? side : oppositeSide]: Math.abs(charges) });
};

// Append the document's TDS or TCS line; TDS posts on `tdsSide` and TCS on the opposite side.
const pushTdsTcsLine = async (lines, companyId, document, accountKeys, tdsSide, session) => {
  const amount = round2(document.tax?.amount);
  if (document.isSplit || !document.tax?.taxId || !amount) return;
  const isTds = document.tax.type === TAX_TYPES.TDS;
  const account = await resolveSystemAccount(companyId, isTds ? accountKeys.tds : accountKeys.tcs, session);
  const tcsSide = tdsSide === 'debit' ? 'credit' : 'debit';
  lines.push({ accountId: account._id, [isTds ? tdsSide : tcsSide]: amount });
};

// Post small debit/credit imbalance to Round Off when within document tolerance (max ~1 rupee drift).
const pushRoundOffLine = async (lines, companyId, roundOffAmount, session) => {
  const debits = round2(lines.reduce((sum, line) => sum + (line.debit || 0), 0));
  const credits = round2(lines.reduce((sum, line) => sum + (line.credit || 0), 0));
  const leftover = round2(debits - credits);
  if (!leftover || Math.abs(leftover) > Math.abs(round2(roundOffAmount)) + 1) return;
  const account = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.ROUND_OFF, session);
  lines.push({ accountId: account._id, [leftover > 0 ? 'credit' : 'debit']: Math.abs(leftover) });
};

// Post delivery challan stock issue: Dr cost of goods sold, Cr inventory asset for the stock that left.
// The invoice raised from this challan carries no batches, so it records revenue only and never repeats this cost.
const postDeliveryChallanJournal = async ({ companyId, deliveryChallan, addedBy = null }, session = null) => {
  if (!companyId || !deliveryChallan?._id || !deliveryChallan?.challanDate) return;

  const { Item } = getBooksCrmModels();
  const items = (deliveryChallan.items || []).filter(item => (item.batches || []).length > 0);
  if (!items.length) return;

  const itemIds = items.map(item => item.itemId).filter(Boolean);
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName inventoryAccountId')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));

  const stockTotals = {};
  let issued = 0;
  // Sum the batch cost of the stock that left, per inventory account.
  for (const item of items) {
    const cost = round2(
      (item.batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0), 0),
    );
    if (!cost) continue;
    const master = masterById.get(item.itemId?.toString());
    if (!master?.inventoryAccountId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Item ${master?.itemName || item.itemId} does not have an inventory account. Set it on the item before posting stock.`,
      );
    }
    const accountId = master.inventoryAccountId.toString();
    stockTotals[accountId] = round2((stockTotals[accountId] || 0) + cost);
    issued = round2(issued + cost);
  }
  if (!issued) return;

  // Dr COGS for the cost issued and Cr each inventory account. Batch cost is already in base currency.
  const cogs = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.COST_OF_GOODS_SOLD, session);
  const lines = [{ accountId: cogs._id, debit: issued, inBaseCurrency: true }];
  Object.entries(stockTotals).forEach(([accountId, amount]) => lines.push({ accountId, credit: amount, inBaseCurrency: true }));

  await postJournal(
    {
      companyId,
      postingDate: deliveryChallan.challanDate,
      sourceModule: LEDGER_SOURCE_MODULES.DELIVERY_CHALLAN,
      sourceId: deliveryChallan._id,
      narration: `Delivery Challan ${deliveryChallan.challanId}`,
      lines,
      addedBy,
    },
    session,
  );
};

// Post sales invoice: Dr customer AR, Cr sales/inventory/COGS plus tax, discount, charges, and round-off.
const postInvoiceJournal = async ({ companyId, invoice, addedBy = null }, session = null) => {
  const total = round2(invoice?.total);
  if (!companyId || !invoice?._id || !invoice?.invoiceDate || !total) return;

  const { Item } = getBooksCrmModels();
  const items = invoice.items || [];
  const lines = [];

  const itemIds = items.map(item => item.itemId).filter(Boolean);
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName salesInformation.salesAccountId inventoryAccountId')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));

  // Dr customer AR for the full invoice total.
  const receivableAccountId = await resolvePartyControlAccount(companyId, invoice.customerId, session);
  lines.push({
    accountId: receivableAccountId,
    debit: total,
    partyId: invoice.customerId,
    partyType: LEDGER_PARTY_TYPES.CUSTOMER,
  });

  const incomeTotals = {};
  const stockTotals = {};
  let costTotal = 0;

  // Walk lines: group sales income by account and stock cost from consumed batches.
  for (const item of items) {
    const master = masterById.get(item.itemId?.toString());

    const amount = getTaxExclusiveLineAmount(item, invoice.appliesTo);
    if (amount) {
      const incomeAccountId = item.accountId || master?.salesInformation?.salesAccountId;
      if (!incomeAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have a sales account. Set it on the item before posting.`,
        );
      }
      const incomeKey = incomeAccountId.toString();
      incomeTotals[incomeKey] = round2((incomeTotals[incomeKey] || 0) + amount);
    }

    const cost = round2(
      (item.batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0), 0),
    );
    if (cost) {
      if (!master?.inventoryAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have an inventory account. Set it on the item before posting stock.`,
        );
      }
      const stockKey = master.inventoryAccountId.toString();
      costTotal = round2(costTotal + cost);
      stockTotals[stockKey] = round2((stockTotals[stockKey] || 0) + cost);
    }
  }

  // Cr sales income per item sales account.
  Object.entries(incomeTotals).forEach(([accountId, amount]) => lines.push({ accountId, credit: amount }));

  // Dr COGS and Cr inventory asset for stock sold on this invoice.
  if (costTotal) {
    const cogs = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.COST_OF_GOODS_SOLD, session);
    lines.push({ accountId: cogs._id, debit: costTotal, inBaseCurrency: true });
  }
  Object.entries(stockTotals).forEach(([accountId, amount]) => lines.push({ accountId, credit: amount, inBaseCurrency: true }));

  // Document-level discount, output GST, charges, and round-off to balance the journal.
  await pushDiscountLine(lines, companyId, invoice, SYSTEM_ACCOUNT_KEYS.DISCOUNT, 'debit', session);
  await pushTaxLines(
    lines,
    companyId,
    invoice,
    {
      sgst: SYSTEM_ACCOUNT_KEYS.OUTPUT_SGST,
      cgst: SYSTEM_ACCOUNT_KEYS.OUTPUT_CGST,
      igst: SYSTEM_ACCOUNT_KEYS.OUTPUT_IGST,
    },
    'credit',
    session,
  );
  await pushChargeLines(lines, companyId, invoice, SYSTEM_ACCOUNT_KEYS.OTHER_CHARGES, 'credit', session);
  // TCS we collect from the customer is owed to the government.
  await pushTdsTcsLine(
    lines,
    companyId,
    invoice,
    { tds: SYSTEM_ACCOUNT_KEYS.TDS_RECEIVABLE, tcs: SYSTEM_ACCOUNT_KEYS.TCS_PAYABLE },
    'debit',
    session,
  );
  await pushRoundOffLine(lines, companyId, invoice.roundOffAmount, session);

  await postJournal(
    {
      companyId,
      postingDate: invoice.invoiceDate,
      sourceModule: LEDGER_SOURCE_MODULES.INVOICE,
      sourceId: invoice._id,
      narration: `Invoice ${invoice.invoiceId}`,
      lines,
      addedBy,
      isSplit: invoice.isSplit,
      currencyId: invoice.currency,
      exchangeRate: invoice.exchangeRate,
    },
    session,
  );
};

// Post GRPO stock receipt: Dr inventory asset, Cr Goods Received Not Invoiced until vendor bill arrives.
const postGrpoJournal = async ({ companyId, grpo, addedBy = null }, session = null) => {
  if (!companyId || !grpo?._id || !grpo?.date) return;

  const { Item } = getBooksCrmModels();
  const items = (grpo.items || []).filter(item => (item.batches || []).length > 0);
  if (!items.length) return;

  const itemIds = items.map(item => item.itemId).filter(Boolean);
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName inventoryAccountId')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));

  const stockTotals = {};
  let received = 0;
  // Sum received stock value per inventory account from GRPO lines that created batches.
  for (const item of items) {
    const amount = getTaxExclusiveLineAmount(item, grpo.appliesTo);
    if (!amount) continue;
    const master = masterById.get(item.itemId?.toString());
    if (!master?.inventoryAccountId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Item ${master?.itemName || item.itemId} does not have an inventory account. Set it on the item before posting stock.`,
      );
    }
    const accountId = master.inventoryAccountId.toString();
    stockTotals[accountId] = round2((stockTotals[accountId] || 0) + amount);
    received = round2(received + amount);
  }
  if (!received) return;

  // Dr inventory per account and Cr GRNI for the total received (liability until bill is posted).
  const lines = Object.entries(stockTotals).map(([accountId, amount]) => ({ accountId, debit: amount }));
  const grni = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.GOODS_RECEIVED_NOT_INVOICED, session);
  lines.push({ accountId: grni._id, credit: received, partyId: grpo.vendor, partyType: LEDGER_PARTY_TYPES.VENDOR });

  await postJournal(
    {
      companyId,
      postingDate: grpo.date,
      sourceModule: LEDGER_SOURCE_MODULES.GRPO,
      sourceId: grpo._id,
      narration: `GRPO ${grpo.grpoOrderId}`,
      lines,
      addedBy,
      currencyId: grpo.currency,
      exchangeRate: grpo.exchangeRate,
    },
    session,
  );
};

// Post vendor bill: Cr AP, Dr inventory/expense or GRNI settlement plus input tax, discount, charges, and round-off.
const postBillJournal = async ({ companyId, bill, addedBy = null }, session = null) => {
  const total = round2(bill?.total);
  if (!companyId || !bill?._id || !bill?.billDate || !total) return;

  const { Item } = getBooksCrmModels();
  const items = bill.items || [];
  const lines = [];

  const itemIds = items.map(item => item.itemId).filter(Boolean);
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName purchaseInformation.purchaseAccountId inventoryAccountId trackInventory')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));

  const fromGrpo = (bill.grpoIds || []).length > 0;

  // Cr vendor AP for the full bill total.
  const payableAccountId = await resolvePartyControlAccount(companyId, bill.vendor, session);
  lines.push({
    accountId: payableAccountId,
    credit: total,
    partyId: bill.vendor,
    partyType: LEDGER_PARTY_TYPES.VENDOR,
  });

  const stockTotals = {};
  const expenseTotals = {};
  let settledOnGrpo = 0;

  // Walk lines: Dr inventory or purchase expense; GRPO-linked stock without batches settles GRNI instead.
  for (const item of items) {
    const amount = getTaxExclusiveLineAmount(item, bill.appliesTo);
    if (!amount) continue;

    const master = masterById.get(item.itemId?.toString());
    const receivedStock = (item.batches || []).length > 0;

    if (!receivedStock && fromGrpo && master?.trackInventory !== false) {
      settledOnGrpo = round2(settledOnGrpo + amount);
      continue;
    }

    let accountId;
    if (receivedStock) {
      if (!master?.inventoryAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have an inventory account. Set it on the item before posting stock.`,
        );
      }
      accountId = master.inventoryAccountId.toString();
    } else {
      if (!master?.purchaseInformation?.purchaseAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have a purchase account. Set it on the item before posting.`,
        );
      }
      accountId = master.purchaseInformation.purchaseAccountId.toString();
    }
    const totals = receivedStock ? stockTotals : expenseTotals;
    totals[accountId] = round2((totals[accountId] || 0) + amount);
  }

  Object.entries(stockTotals).forEach(([accountId, amount]) => lines.push({ accountId, debit: amount }));
  Object.entries(expenseTotals).forEach(([accountId, amount]) => lines.push({ accountId, debit: amount }));

  // Dr GRNI to clear stock already capitalised on linked GRPO(s).
  if (settledOnGrpo) {
    const grni = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.GOODS_RECEIVED_NOT_INVOICED, session);
    lines.push({ accountId: grni._id, debit: settledOnGrpo, partyId: bill.vendor, partyType: LEDGER_PARTY_TYPES.VENDOR });
  }

  // Document-level purchase discount, input GST, charges, and round-off to balance the journal.
  await pushDiscountLine(lines, companyId, bill, SYSTEM_ACCOUNT_KEYS.PURCHASE_DISCOUNTS, 'credit', session);
  await pushTaxLines(
    lines,
    companyId,
    bill,
    {
      sgst: SYSTEM_ACCOUNT_KEYS.INPUT_SGST,
      cgst: SYSTEM_ACCOUNT_KEYS.INPUT_CGST,
      igst: SYSTEM_ACCOUNT_KEYS.INPUT_IGST,
    },
    'debit',
    session,
  );
  await pushChargeLines(lines, companyId, bill, SYSTEM_ACCOUNT_KEYS.OTHER_EXPENSES, 'debit', session);
  // TDS we deduct from the vendor is owed to the government; TCS the vendor collects from us is ours to claim.
  await pushTdsTcsLine(
    lines,
    companyId,
    bill,
    { tds: SYSTEM_ACCOUNT_KEYS.TDS_PAYABLE, tcs: SYSTEM_ACCOUNT_KEYS.TCS_RECEIVABLE },
    'credit',
    session,
  );
  await pushRoundOffLine(lines, companyId, bill.roundOffAmount, session);

  await postJournal(
    {
      companyId,
      postingDate: bill.billDate,
      sourceModule: LEDGER_SOURCE_MODULES.BILL,
      sourceId: bill._id,
      narration: `Bill ${bill.billId}`,
      lines,
      addedBy,
      isSplit: bill.isSplit,
      currencyId: bill.currency,
      exchangeRate: bill.exchangeRate,
    },
    session,
  );
};

const postCreditNoteJournal = async ({ companyId, creditNote, addedBy = null }, session = null) => {
  const total = round2(creditNote?.total);
  if (!companyId || !creditNote?._id || !creditNote?.creditNoteDate || !total) return;

  const { Item } = getBooksCrmModels();
  const items = creditNote.items || [];
  const lines = [];

  const itemIds = items.map(item => item.itemId).filter(Boolean);
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName salesInformation.salesAccountId inventoryAccountId')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));

  // The customer owes that much less.
  const receivableAccountId = await resolvePartyControlAccount(companyId, creditNote.customerId, session);
  lines.push({
    accountId: receivableAccountId,
    credit: total,
    partyId: creditNote.customerId,
    partyType: LEDGER_PARTY_TYPES.CUSTOMER,
  });

  // Totals per account, so an account that appears on several lines still gets one entry.
  const incomeTotals = {};
  const stockTotals = {};
  let costTotal = 0;

  for (const item of items) {
    const master = masterById.get(item.itemId?.toString());

    const amount = getTaxExclusiveLineAmount(item, creditNote.appliesTo);
    if (amount) {
      const incomeAccountId = item.accountId || master?.salesInformation?.salesAccountId;
      if (!incomeAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have a sales account. Set it on the item before posting.`,
        );
      }
      const incomeKey = incomeAccountId.toString();
      incomeTotals[incomeKey] = round2((incomeTotals[incomeKey] || 0) + amount);
    }

    // A line carries batches only when goods really came back into stock.
    const cost = round2(
      (item.batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0), 0),
    );
    if (cost) {
      if (!master?.inventoryAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have an inventory account. Set it on the item before posting stock.`,
        );
      }
      const stockAccountId = master.inventoryAccountId.toString();
      stockTotals[stockAccountId] = round2((stockTotals[stockAccountId] || 0) + cost);
      costTotal = round2(costTotal + cost);
    }
  }

  Object.entries(incomeTotals).forEach(([accountId, amount]) => lines.push({ accountId, debit: amount }));
  Object.entries(stockTotals).forEach(([accountId, amount]) => lines.push({ accountId, debit: amount, inBaseCurrency: true }));

  // The cost of the returned goods comes back out of cost of goods sold.
  if (costTotal) {
    const cogs = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.COST_OF_GOODS_SOLD, session);
    lines.push({ accountId: cogs._id, credit: costTotal, inBaseCurrency: true });
  }

  // The invoice's discount, tax and charges all posted the other way; the credit note undoes them.
  await pushDiscountLine(lines, companyId, creditNote, SYSTEM_ACCOUNT_KEYS.DISCOUNT, 'credit', session);
  await pushTaxLines(
    lines,
    companyId,
    creditNote,
    { sgst: SYSTEM_ACCOUNT_KEYS.OUTPUT_SGST, cgst: SYSTEM_ACCOUNT_KEYS.OUTPUT_CGST, igst: SYSTEM_ACCOUNT_KEYS.OUTPUT_IGST },
    'debit',
    session,
  );
  await pushChargeLines(lines, companyId, creditNote, SYSTEM_ACCOUNT_KEYS.OTHER_CHARGES, 'debit', session);
  // Reverses the invoice's TCS on the credited amount.
  await pushTdsTcsLine(
    lines,
    companyId,
    creditNote,
    { tds: SYSTEM_ACCOUNT_KEYS.TDS_RECEIVABLE, tcs: SYSTEM_ACCOUNT_KEYS.TCS_PAYABLE },
    'credit',
    session,
  );
  await pushRoundOffLine(lines, companyId, creditNote.roundOffAmount, session);

  await postJournal(
    {
      companyId,
      postingDate: creditNote.creditNoteDate,
      sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE,
      sourceId: creditNote._id,
      narration: `Credit Note ${creditNote.creditNoteId}`,
      lines,
      addedBy,
      isSplit: creditNote.isSplit,
      currencyId: creditNote.currency,
      exchangeRate: creditNote.exchangeRate,
    },
    session,
  );
};

const postDebitNoteJournal = async ({ companyId, debitNote, addedBy = null }, session = null) => {
  const total = round2(debitNote?.total);
  if (!companyId || !debitNote?._id || !debitNote?.debitNoteDate || !total) return;

  const { Item } = getBooksCrmModels();
  const items = debitNote.items || [];
  const lines = [];

  const itemIds = items.map(item => item.itemId).filter(Boolean);
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName purchaseInformation.purchaseAccountId inventoryAccountId')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));

  // We owe the vendor that much less.
  const payableAccountId = await resolvePartyControlAccount(companyId, debitNote.vendorId, session);
  lines.push({
    accountId: payableAccountId,
    debit: total,
    partyId: debitNote.vendorId,
    partyType: LEDGER_PARTY_TYPES.VENDOR,
  });

  // Totals per account, so an account that appears on several lines still gets one entry.
  const stockTotals = {};
  const expenseTotals = {};
  let rateDifference = 0;

  for (const item of items) {
    const amount = getTaxExclusiveLineAmount(item, debitNote.appliesTo);
    if (!amount) continue;

    const master = masterById.get(item.itemId?.toString());
    // A line carries batches only when goods really left the stock.
    const cost = round2(
      (item.batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0), 0),
    );

    if (cost) {
      if (!master?.inventoryAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have an inventory account. Set it on the item before posting stock.`,
        );
      }
      const stockAccountId = master.inventoryAccountId.toString();
      stockTotals[stockAccountId] = round2((stockTotals[stockAccountId] || 0) + cost);
      rateDifference = round2(rateDifference + amount - cost);
    } else {
      if (!master?.purchaseInformation?.purchaseAccountId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item ${master?.itemName || item.itemId} does not have a purchase account. Set it on the item before posting.`,
        );
      }
      const expenseAccountId = master.purchaseInformation.purchaseAccountId.toString();
      expenseTotals[expenseAccountId] = round2((expenseTotals[expenseAccountId] || 0) + amount);
    }
  }

  Object.entries(stockTotals).forEach(([accountId, amount]) => lines.push({ accountId, credit: amount, inBaseCurrency: true }));
  Object.entries(expenseTotals).forEach(([accountId, amount]) => lines.push({ accountId, credit: amount }));

  if (rateDifference) {
    const purchaseDiscounts = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.PURCHASE_DISCOUNTS, session);
    lines.push({ accountId: purchaseDiscounts._id, [rateDifference > 0 ? 'credit' : 'debit']: Math.abs(rateDifference) });
  }

  // The bill's discount, tax and charges all posted the other way; the debit note undoes them.
  await pushDiscountLine(lines, companyId, debitNote, SYSTEM_ACCOUNT_KEYS.PURCHASE_DISCOUNTS, 'debit', session);
  await pushTaxLines(
    lines,
    companyId,
    debitNote,
    { sgst: SYSTEM_ACCOUNT_KEYS.INPUT_SGST, cgst: SYSTEM_ACCOUNT_KEYS.INPUT_CGST, igst: SYSTEM_ACCOUNT_KEYS.INPUT_IGST },
    'credit',
    session,
  );
  await pushChargeLines(lines, companyId, debitNote, SYSTEM_ACCOUNT_KEYS.OTHER_EXPENSES, 'credit', session);
  // Reverses the bill's TDS/TCS on the returned amount.
  await pushTdsTcsLine(
    lines,
    companyId,
    debitNote,
    { tds: SYSTEM_ACCOUNT_KEYS.TDS_PAYABLE, tcs: SYSTEM_ACCOUNT_KEYS.TCS_RECEIVABLE },
    'debit',
    session,
  );
  await pushRoundOffLine(lines, companyId, debitNote.roundOffAmount, session);

  await postJournal(
    {
      companyId,
      postingDate: debitNote.debitNoteDate,
      sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE,
      sourceId: debitNote._id,
      narration: `Debit Note ${debitNote.debitNoteId}`,
      lines,
      addedBy,
      isSplit: debitNote.isSplit,
      currencyId: debitNote.currency,
      exchangeRate: debitNote.exchangeRate,
    },
    session,
  );
};

// Production: Dr FG Inventory at stamped batch cost; Cr RM at actual batch cost, Labor & Job Costing for capitalized costs (already expensed, avoiding double-counting).
// Scrap: Dr Scrap Inventory / Cr Job Costing; per-unit rounding goes to Round Off, while genuine imbalance (e.g. no output) goes to COGS.
const postProductionJournal = async (
  {
    companyId,
    sourceId,
    postingDate,
    narration,
    finishedGoods = null,
    rawMaterials = [],
    labourCost = 0,
    overheadCost = 0,
    scrap = [],
    productionLoss = 0,
    isClosedOut = false,
    addedBy = null,
  },
  session = null,
) => {
  if (!companyId || !sourceId || !postingDate) return;

  const { Item } = getBooksCrmModels();
  const lines = [];

  const itemIds = [finishedGoods?.itemId, ...rawMaterials.map(rm => rm.itemId), ...scrap.map(sc => sc.itemId)].filter(Boolean);
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName inventoryAccountId')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));
  const inventoryAccountIdOf = itemId => {
    const master = masterById.get(itemId?.toString());
    if (!master?.inventoryAccountId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Item ${master?.itemName || itemId} does not have an inventory account. Set it on the item before posting production.`,
      );
    }
    return master.inventoryAccountId.toString();
  };

  const fgValue = finishedGoods ? round2((Number(finishedGoods.quantity) || 0) * (Number(finishedGoods.unitCost) || 0)) : 0;
  if (fgValue) {
    lines.push({
      accountId: inventoryAccountIdOf(finishedGoods.itemId),
      debit: fgValue,
      narration: 'Finished goods capitalized',
    });
  }

  // Scrap is valued separately from its own item master and does not reduce production cost.
  const scrapValue = round2(scrap.reduce((sum, sc) => sum + (Number(sc.value) || 0), 0));
  for (const sc of scrap) {
    const value = round2(sc.value);
    if (value) {
      lines.push({
        accountId: inventoryAccountIdOf(sc.itemId),
        debit: value,
        narration: 'Scrap recovered',
      });
    }
  }
  if (scrapValue) {
    const scrapIncome = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.SCRAP_INCOME, session);
    lines.push({ accountId: scrapIncome._id, credit: scrapValue, narration: 'Scrap recovered from production' });
  }

  // Totals per account, so materials sharing an inventory account still get one entry.
  const materialTotals = {};
  for (const rm of rawMaterials) {
    const cost = round2(rm.cost);
    if (!cost) continue;
    const accountId = inventoryAccountIdOf(rm.itemId);
    materialTotals[accountId] = round2((materialTotals[accountId] || 0) + cost);
  }
  Object.entries(materialTotals).forEach(([accountId, amount]) =>
    lines.push({ accountId, credit: amount, narration: 'Raw material consumed' }),
  );

  const labour = round2(labourCost);
  if (labour) {
    const labor = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.LABOR, session);
    lines.push({ accountId: labor._id, credit: labour, narration: 'Labour capitalized' });
  }

  const overhead = round2(overheadCost);
  if (overhead) {
    const jobCosting = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.JOB_COSTING, session);
    lines.push({ accountId: jobCosting._id, credit: overhead, narration: 'Production cost allocation' });
  }

  // Rejected units share the input cost and are written off separately from good output.
  const loss = round2(productionLoss);
  if (loss) {
    const lossAccount = await resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.PRODUCTION_LOSS, session);
    lines.push({ accountId: lossAccount._id, debit: loss, narration: 'Cost of rejected production' });
  }

  if (!lines.length) return;

  // Unfinished cost remains in WIP; only per-unit rounding differences go to Round Off. An order that
  // is finished or closed has nothing left on the floor, so cost still unaccounted for at that point
  // is lost, and belongs in the P&L of the period it was abandoned in rather than on the balance sheet.
  const debits = round2(lines.reduce((sum, line) => sum + (line.debit || 0), 0));
  const credits = round2(lines.reduce((sum, line) => sum + (line.credit || 0), 0));
  const leftover = round2(debits - credits);
  if (leftover) {
    const roundingAllowance = round2((Number(finishedGoods?.quantity) || 0) * 0.005 + 0.05);
    const isRounding = Math.abs(leftover) <= roundingAllowance;
    const remainderKey = isClosedOut ? SYSTEM_ACCOUNT_KEYS.PRODUCTION_LOSS : SYSTEM_ACCOUNT_KEYS.WORK_IN_PROGRESS;
    const account = await resolveSystemAccount(companyId, isRounding ? SYSTEM_ACCOUNT_KEYS.ROUND_OFF : remainderKey, session);
    lines.push({
      accountId: account._id,
      [leftover > 0 ? 'credit' : 'debit']: Math.abs(leftover),
      narration: isRounding ? 'Production rounding' : isClosedOut ? 'Unrecovered production cost' : 'Work in progress',
    });
  }

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule: LEDGER_SOURCE_MODULES.PRODUCTION,
      sourceId,
      narration,
      lines,
      addedBy,
    },
    session,
  );
};

// Post approved inventory adjustment: Dr/Cr item inventory accounts vs document adjustment account.
const postAdjustmentJournal = async ({ companyId, adjustment, stockIn = [], stockOut = [], addedBy = null }, session = null) => {
  if (!companyId || !adjustment?._id || !adjustment?.accountId) return;
  if (!stockIn.length && !stockOut.length) return;

  const { Item } = getBooksCrmModels();
  const itemIds = [...new Set([...stockIn, ...stockOut].map(entry => entry.itemId).filter(Boolean))];
  const masters = itemIds.length
    ? await Item.find({ _id: { $in: itemIds }, companyId })
        .select('itemName inventoryAccountId')
        .session(session)
        .lean()
    : [];
  const masterById = new Map(masters.map(master => [master._id.toString(), master]));

  const inventoryAccountIdOf = itemId => {
    const master = masterById.get(itemId?.toString());
    if (!master?.inventoryAccountId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Item ${master?.itemName || itemId} does not have an inventory account. Set it on the item before adjusting stock.`,
      );
    }
    return master.inventoryAccountId.toString();
  };

  const lines = [];
  const stockInTotals = {};
  const stockOutTotals = {};
  let inTotal = 0;
  let outTotal = 0;

  for (const entry of stockIn) {
    const value = round2(entry.value);
    if (!value) continue;
    const accountId = inventoryAccountIdOf(entry.itemId);
    stockInTotals[accountId] = round2((stockInTotals[accountId] || 0) + value);
    inTotal = round2(inTotal + value);
  }

  for (const entry of stockOut) {
    const value = round2(entry.value);
    if (!value) continue;
    const accountId = inventoryAccountIdOf(entry.itemId);
    stockOutTotals[accountId] = round2((stockOutTotals[accountId] || 0) + value);
    outTotal = round2(outTotal + value);
  }

  if (!inTotal && !outTotal) return;

  Object.entries(stockInTotals).forEach(([accountId, amount]) => lines.push({ accountId, debit: amount }));
  if (inTotal) lines.push({ accountId: adjustment.accountId, credit: inTotal });

  if (outTotal) lines.push({ accountId: adjustment.accountId, debit: outTotal });
  Object.entries(stockOutTotals).forEach(([accountId, amount]) => lines.push({ accountId, credit: amount }));

  await postJournal(
    {
      companyId,
      postingDate: adjustment.approvalDate || adjustment.adjustmentDate || new Date(),
      sourceModule: LEDGER_SOURCE_MODULES.INVENTORY_ADJUSTMENT,
      sourceId: adjustment._id,
      narration: `Inventory Adjustment ${adjustment.inventoryAdjustmentNumber}`,
      lines,
      addedBy,
    },
    session,
  );
};

// Post an expense: Cr the paid-through account (or the vendor who paid it), and the debit side depends on the kind of expense below.
const postExpenseJournal = async ({ companyId, expense, addedBy = null }, session = null) => {
  const amount = Math.abs(Number(expense.total) || 0);
  const isVendorBillable = expense.isBillable && expense.partyType === LEDGER_PARTY_TYPES.VENDOR;
  if (!companyId || (!expense.paidThroughAccountId && !isVendorBillable) || !expense.date || !expense._id || !amount) {
    return;
  }

  const partyId = expense.party;
  let partyType = expense.partyType || null;
  const lines = [];

  if (expense.isBillable && !isVendorBillable) {
    // Customer billable: the customer owes this amount, so no expense or GST is posted.
    const controlAccountId = await resolvePartyControlAccount(companyId, partyId, session);
    lines.push({ accountId: controlAccountId, debit: amount, partyId, partyType });
  } else if (expense.lines?.length) {
    // Normal expense: Dr each expense account once, with its cost from all its lines.
    const costByAccount = {};
    for (const line of expense.lines) {
      const accountId = line.accountId.toString();
      costByAccount[accountId] = round2((costByAccount[accountId] || 0) + line.cost);
    }
    for (const [accountId, cost] of Object.entries(costByAccount)) {
      lines.push({ accountId, debit: cost, partyId, partyType });
    }

    // Only eligible GST goes to input tax; the rest is already inside the line cost.
    const eligibleTax = round2(expense.eligibleTax);
    const isIgst = expense.taxSplit === EXPENSE_TAX_SPLIT.IGST;
    const eligibleCgst = isIgst ? 0 : round2(eligibleTax / 2);
    const eligibleTaxAmounts = {
      igst: isIgst ? eligibleTax : 0,
      cgst: eligibleCgst,
      sgst: isIgst ? 0 : round2(eligibleTax - eligibleCgst),
    };
    await pushTaxLines(
      lines,
      companyId,
      eligibleTaxAmounts,
      { sgst: SYSTEM_ACCOUNT_KEYS.INPUT_SGST, cgst: SYSTEM_ACCOUNT_KEYS.INPUT_CGST, igst: SYSTEM_ACCOUNT_KEYS.INPUT_IGST },
      'debit',
      session,
    );

    // TDS we deduct is owed to the government; TCS the vendor collects from us is ours to claim.
    await pushTdsTcsLine(
      lines,
      companyId,
      expense,
      { tds: SYSTEM_ACCOUNT_KEYS.TDS_PAYABLE, tcs: SYSTEM_ACCOUNT_KEYS.TCS_RECEIVABLE },
      'credit',
      session,
    );
  } else {
    // Old row or Recurring Expense: one account and no stored party type. A Ledger party has none.
    if (partyId) {
      const { Customer } = getBooksCrmModels();
      const party = await Customer.findById(partyId).select('Role').session(session).lean();
      if (party?.Role?.isCustomer) partyType = LEDGER_PARTY_TYPES.CUSTOMER;
      else if (party?.Role?.isVendor) partyType = LEDGER_PARTY_TYPES.VENDOR;
    }
    lines.push({ accountId: expense.expenseAccount, debit: amount, partyId, partyType });
  }

  if (isVendorBillable) {
    // The vendor paid it for us, so we owe the vendor until a Payment Made settles it.
    const controlAccountId = await resolvePartyControlAccount(companyId, partyId, session);
    lines.push({ accountId: controlAccountId, credit: amount, partyId, partyType });
  } else {
    lines.push({ accountId: expense.paidThroughAccountId, credit: amount });
  }

  // A rounded total leaves a small difference, which goes to Round Off.
  await pushRoundOffLine(lines, companyId, expense.roundOffAmount, session);

  await postJournal(
    {
      companyId,
      postingDate: expense.date,
      sourceModule: LEDGER_SOURCE_MODULES.EXPENSE,
      sourceId: expense._id,
      narration: `Expense ${expense.expenseId}`,
      lines,
      addedBy,
      currencyId: expense.currency,
      exchangeRate: expense.exchangeRate,
    },
    session,
  );
};

// Post cash refund against credit note: Dr customer AR, Cr bank (offsets credit note AR credit).
const postCreditNoteRefundJournal = async (
  {
    companyId,
    fromAccountId,
    amount,
    partyId,
    postingDate,
    sourceId,
    narration = null,
    addedBy = null,
    currencyId = null,
    exchangeRate = null,
  },
  session = null,
) => {
  const normalizedAmount = Math.abs(Number(amount) || 0);
  if (!companyId || !fromAccountId || !postingDate || !sourceId || !normalizedAmount) {
    return;
  }

  const receivableAccountId = await resolvePartyControlAccount(companyId, partyId, session);
  const lines = [
    { accountId: receivableAccountId, debit: normalizedAmount, partyId, partyType: LEDGER_PARTY_TYPES.CUSTOMER },
    { accountId: fromAccountId, credit: normalizedAmount },
  ];

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE,
      sourceId,
      narration,
      lines,
      addedBy,
      currencyId,
      exchangeRate,
    },
    session,
  );
};

// Post cash refund against debit note: Dr bank, Cr vendor AP (offsets debit note AP debit).
const postDebitNoteRefundJournal = async (
  {
    companyId,
    toAccountId,
    amount,
    partyId,
    postingDate,
    sourceId,
    narration = null,
    addedBy = null,
    currencyId = null,
    exchangeRate = null,
  },
  session = null,
) => {
  const normalizedAmount = Math.abs(Number(amount) || 0);
  if (!companyId || !toAccountId || !postingDate || !sourceId || !normalizedAmount) {
    return;
  }

  const payableAccountId = await resolvePartyControlAccount(companyId, partyId, session);
  const lines = [
    { accountId: toAccountId, debit: normalizedAmount },
    { accountId: payableAccountId, credit: normalizedAmount, partyId, partyType: LEDGER_PARTY_TYPES.VENDOR },
  ];

  await postJournal(
    {
      companyId,
      postingDate,
      sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE,
      sourceId,
      narration,
      lines,
      addedBy,
      currencyId,
      exchangeRate,
    },
    session,
  );
};

// Read account balances directly from current ledger postings; optionally filter by account/date and use the account's own currency for bank statements.
const getAccountBalances = async ({
  companyId,
  accountId = null,
  accountIds = null,
  fromDate = null,
  upToDate = null,
  beforeDate = null,
  branchId = null,
  divisionId = null,
  includeSplit = false,
  inAccountCurrency = false,
  sourceModule = null,
  partyType = null,
}) => {
  const { Account, LedgerEntry } = getBooksModels();

  const ObjectId = mongoose.Types.ObjectId;
  const match = { companyId: new ObjectId(companyId) };

  if (accountId) {
    match.accountId = new ObjectId(accountId);
  } else if (accountIds?.length) {
    match.accountId = { $in: accountIds.map(id => new ObjectId(id)) };
  }

  if (fromDate || upToDate || beforeDate) {
    match.postingDate = {};
    if (fromDate) match.postingDate.$gte = new Date(fromDate);
    if (upToDate) match.postingDate.$lte = new Date(upToDate);
    if (beforeDate) match.postingDate.$lt = new Date(beforeDate);
  }

  if (branchId) {
    match.branchId = Array.isArray(branchId) ? { $in: branchId.map(id => new ObjectId(id)) } : new ObjectId(branchId);
  }
  if (divisionId) {
    match.divisionId = Array.isArray(divisionId) ? { $in: divisionId.map(id => new ObjectId(id)) } : new ObjectId(divisionId);
  }
  if (!includeSplit) {
    match.isSplit = false;
  }
  if (sourceModule) {
    match.sourceModule = sourceModule;
  }
  if (partyType) {
    match.partyType = partyType;
  }

  if (!inAccountCurrency) {
    // The books' own figure: always base currency, one company-wide sum.
    const rows = await LedgerEntry.aggregate([
      { $match: match },
      { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);

    const balances = new Map();
    for (const row of rows) {
      balances.set(String(row._id), { debit: round2(row.debit), credit: round2(row.credit) });
    }
    return balances;
  }

  // Bank statement: small set of payment accounts, so find + loop instead of aggregation.
  const rows = await LedgerEntry.find(match).select('accountId debit credit currencyId foreignAmount').lean();

  const presentAccountIds = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row.accountId);
    if (seen.has(id)) continue;
    seen.add(id);
    presentAccountIds.push(id);
  }

  const accounts = await Account.find({ _id: { $in: presentAccountIds } })
    .select('currencyId')
    .lean();

  const currencyByAccount = new Map();
  for (const account of accounts) {
    currencyByAccount.set(String(account._id), account.currencyId ? String(account.currencyId) : null);
  }

  const totals = new Map();
  for (const row of rows) {
    const key = String(row.accountId);
    if (!totals.has(key)) totals.set(key, { debit: 0, credit: 0 });
    const running = totals.get(key);

    // Use foreignAmount only when the row currency matches the account currency; otherwise use the base amount.
    let amount = row.debit || row.credit;
    if (row.currencyId && String(row.currencyId) === currencyByAccount.get(key)) {
      if (row.foreignAmount != null) amount = row.foreignAmount;
    }

    if (row.debit > 0) running.debit += amount;
    else running.credit += amount;
  }

  for (const [key, running] of totals) {
    totals.set(key, { debit: round2(running.debit), credit: round2(running.credit) });
  }
  return totals;
};

// The number and party for one page of entries, asking each source collection once instead of
// once per row.
const describeEntrySources = async entries => {
  const booksModels = getBooksModels();
  const booksCrmModels = getBooksCrmModels();
  const { Customer } = booksCrmModels;
  const { Account, AccountLedger } = booksModels;

  const idsByModule = {};
  for (const entry of entries) {
    if (!SOURCE_DOCUMENTS[entry.sourceModule]?.modelKey) continue;
    if (!idsByModule[entry.sourceModule]) idsByModule[entry.sourceModule] = new Set();
    idsByModule[entry.sourceModule].add(String(entry.sourceId));
  }

  const documentById = new Map();
  const partyIds = new Set();
  const accountIds = new Set();

  // A journal posted per line — an applied invoice, a manual journal row — names its party on
  // the entry rather than on the document, so both places are collected.
  for (const entry of entries) {
    if (entry.partyId) partyIds.add(String(entry.partyId));
  }

  await Promise.all(
    Object.keys(idsByModule).map(async sourceModule => {
      const config = SOURCE_DOCUMENTS[sourceModule];
      const SourceModel = (config.db === 'booksCrm' ? booksCrmModels : booksModels)[config.modelKey];

      const documents = await SourceModel.find({ _id: { $in: [...idsByModule[sourceModule]] } })
        .select(
          [config.noField, config.nameField, config.partyTypeField, ...config.partyFields, ...(config.accountFields || [])]
            .filter(Boolean)
            .join(' '),
        )
        .lean();

      for (const document of documents) {
        let partyId = null;
        for (const field of config.partyFields) {
          if (document[field]) {
            partyId = document[field];
            break;
          }
        }

        let accountId = null;
        for (const field of config.accountFields || []) {
          if (document[field]) {
            accountId = document[field];
            break;
          }
        }

        if (partyId) partyIds.add(String(partyId));
        if (accountId) accountIds.add(String(accountId));

        documentById.set(String(document._id), {
          documentNo: config.noField ? document[config.noField] || null : null,
          documentName: config.nameField ? document[config.nameField] || null : null,
          partyType: config.partyTypeField ? document[config.partyTypeField] || null : null,
          partyId: partyId ? String(partyId) : null,
          accountId: accountId ? String(accountId) : null,
        });
      }
    }),
  );

  const missingByModule = {};
  for (const [sourceModule, ids] of Object.entries(idsByModule)) {
    const missing = [...ids].filter(id => !documentById.has(id));
    if (missing.length) missingByModule[sourceModule] = missing;
  }

  const registerAppSource = (applicationId, { documentNo, partyId, partyType, parentId }) => {
    if (!applicationId || documentById.has(String(applicationId))) return;
    if (partyId) partyIds.add(String(partyId));
    documentById.set(String(applicationId), {
      documentNo: documentNo || null,
      documentName: null,
      partyType: partyType || null,
      partyId: partyId ? String(partyId) : null,
      accountId: null,
      parentId: parentId ? String(parentId) : null,
    });
  };

  if (missingByModule.INVOICE?.length) {
    const missing = missingByModule.INVOICE.map(id => new mongoose.Types.ObjectId(id));
    const [invoices, creditNotes] = await Promise.all([
      booksModels.Invoice.find({ 'openingBalanceApplications._id': { $in: missing } })
        .select('invoiceId customerId openingBalanceApplications._id')
        .lean(),
      booksModels.CreditNote.find({ 'invoicesApplied._id': { $in: missing } })
        .select('customerId invoicesApplied._id invoicesApplied.invoiceId invoicesApplied.invoiceNo')
        .lean(),
    ]);
    for (const invoice of invoices) {
      for (const app of invoice.openingBalanceApplications || []) {
        if (!missingByModule.INVOICE.includes(String(app._id))) continue;
        registerAppSource(app._id, {
          documentNo: invoice.invoiceId,
          partyId: invoice.customerId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          parentId: invoice._id,
        });
      }
    }
    for (const creditNote of creditNotes) {
      for (const app of creditNote.invoicesApplied || []) {
        if (!missingByModule.INVOICE.includes(String(app._id))) continue;
        registerAppSource(app._id, {
          documentNo: app.invoiceNo || null,
          partyId: creditNote.customerId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          parentId: app.invoiceId,
        });
      }
    }
  }

  if (missingByModule.BILL?.length) {
    const missing = missingByModule.BILL.map(id => new mongoose.Types.ObjectId(id));
    const [bills, debitNotes] = await Promise.all([
      booksModels.Bill.find({ 'openingBalanceApplications._id': { $in: missing } })
        .select('billId vendor openingBalanceApplications._id')
        .lean(),
      booksModels.DebitNote.find({ 'billsApplied._id': { $in: missing } })
        .select('vendorId billsApplied._id billsApplied.billId billsApplied.billNo')
        .lean(),
    ]);
    for (const bill of bills) {
      for (const app of bill.openingBalanceApplications || []) {
        if (!missingByModule.BILL.includes(String(app._id))) continue;
        registerAppSource(app._id, {
          documentNo: bill.billId,
          partyId: bill.vendor,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          parentId: bill._id,
        });
      }
    }
    for (const debitNote of debitNotes) {
      for (const app of debitNote.billsApplied || []) {
        if (!missingByModule.BILL.includes(String(app._id))) continue;
        registerAppSource(app._id, {
          documentNo: app.billNo || null,
          partyId: debitNote.vendorId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          parentId: app.billId,
        });
      }
    }
  }

  if (missingByModule.OPENING_BALANCE_PARTY?.length) {
    const missing = missingByModule.OPENING_BALANCE_PARTY.map(id => new mongoose.Types.ObjectId(id));
    const [obCredits, creditNotes, debitNotes] = await Promise.all([
      booksCrmModels.OpeningBalanceTransaction.find({
        $or: [{ 'paymentReceivedEntries._id': { $in: missing } }, { 'paymentMadeEntries._id': { $in: missing } }],
      })
        .select('contactId contactType paymentReceivedEntries._id paymentMadeEntries._id transactionNo')
        .lean(),
      booksModels.CreditNote.find({ 'openingBalanceTransactions._id': { $in: missing } })
        .select(
          'customerId openingBalanceTransactions._id openingBalanceTransactions.openingBalanceTransactionId openingBalanceTransactions.transactionNo',
        )
        .lean(),
      booksModels.DebitNote.find({ 'openingBalanceTransactions._id': { $in: missing } })
        .select(
          'vendorId openingBalanceTransactions._id openingBalanceTransactions.openingBalanceTransactionId openingBalanceTransactions.transactionNo',
        )
        .lean(),
    ]);
    for (const credit of obCredits) {
      for (const entry of [...(credit.paymentReceivedEntries || []), ...(credit.paymentMadeEntries || [])]) {
        if (!missingByModule.OPENING_BALANCE_PARTY.includes(String(entry._id))) continue;
        registerAppSource(entry._id, {
          documentNo: credit.transactionNo || null,
          partyId: credit.contactId,
          partyType: credit.contactType === 'vendor' ? LEDGER_PARTY_TYPES.VENDOR : LEDGER_PARTY_TYPES.CUSTOMER,
          parentId: credit._id,
        });
      }
    }
    for (const creditNote of creditNotes) {
      for (const app of creditNote.openingBalanceTransactions || []) {
        if (!missingByModule.OPENING_BALANCE_PARTY.includes(String(app._id))) continue;
        registerAppSource(app._id, {
          documentNo: app.transactionNo || null,
          partyId: creditNote.customerId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          parentId: app.openingBalanceTransactionId,
        });
      }
    }
    for (const debitNote of debitNotes) {
      for (const app of debitNote.openingBalanceTransactions || []) {
        if (!missingByModule.OPENING_BALANCE_PARTY.includes(String(app._id))) continue;
        registerAppSource(app._id, {
          documentNo: app.transactionNo || null,
          partyId: debitNote.vendorId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          parentId: app.openingBalanceTransactionId,
        });
      }
    }
  }

  let accounts = [];
  if (accountIds.size) {
    accounts = await Account.find({ _id: { $in: [...accountIds] } })
      .select('accountName accountCode')
      .lean();
  }

  let customers = [];
  if (partyIds.size) {
    customers = await Customer.find({ _id: { $in: [...partyIds] } })
      .select('customerDisplayName companyName customerNumber')
      .lean();
  }

  // Party may be Customer/Vendor or Account Ledger — try Customer first, then AccountLedger.
  const foundCustomerIds = new Set(customers.map(party => String(party._id)));
  const missingPartyIds = [...partyIds].filter(id => !foundCustomerIds.has(id));

  let ledgerParties = [];
  if (missingPartyIds.length) {
    ledgerParties = await AccountLedger.find({ _id: { $in: missingPartyIds } })
      .select('personName')
      .lean();
  }

  const accountNameById = new Map();
  for (const account of accounts) {
    accountNameById.set(String(account._id), account.accountName || null);
  }

  const partyNameById = new Map();
  for (const party of customers) {
    partyNameById.set(String(party._id), party.customerDisplayName || party.companyName || null);
  }
  for (const party of ledgerParties) {
    partyNameById.set(String(party._id), party.personName || null);
  }

  // A source with no number of its own is identified by the code of the record it belongs to.
  const partyCodeById = new Map();
  for (const party of customers) {
    partyCodeById.set(String(party._id), party.customerNumber || null);
  }

  const accountCodeById = new Map();
  for (const account of accounts) {
    accountCodeById.set(String(account._id), account.accountCode || null);
  }

  return { documentById, partyNameById, accountNameById, partyCodeById, accountCodeById };
};

// One account's statement: what it is worth, and the entries that made it so.
const getAccountLedger = async ({
  companyId,
  accountId,
  page,
  limit,
  pagination,
  startDate = null,
  endDate = null,
  branchId = null,
  isSplit = false,
  sourceModule = null,
  partyType = null,
}) => {
  const { Account, LedgerEntry } = getBooksModels();
  const { Branch } = getBooksCrmModels();

  const account = await Account.findOne({ _id: accountId, companyId }).lean();
  if (!account) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Account not found');
  }

  // An active split session shows split postings alongside normal ones; otherwise only normal.
  const filter = { companyId, accountId };
  if (!isSplit) filter.isSplit = false;
  if (branchId) filter.branchId = branchId;
  if (sourceModule) filter.sourceModule = sourceModule;
  if (partyType) filter.partyType = partyType;

  if (startDate || endDate) {
    filter.postingDate = {};
    if (startDate) filter.postingDate.$gte = new Date(startDate);
    if (endDate) filter.postingDate.$lte = new Date(endDate);
  }

  // Closing balance is scoped to the selected period (startDate to endDate).
  const [balances, openingBalances, result] = await Promise.all([
    getAccountBalances({
      companyId,
      accountId,
      branchId,
      includeSplit: isSplit,
      fromDate: startDate,
      upToDate: endDate,
      sourceModule,
      partyType,
    }),
    startDate
      ? getAccountBalances({
          companyId,
          accountId,
          branchId,
          includeSplit: isSplit,
          beforeDate: startDate,
          sourceModule,
          partyType,
        })
      : new Map(),
    LedgerEntry.paginate(filter, { page, limit, pagination, sortBy: 'postingDate:desc,createdAt:desc' }),
  ]);

  const totals = balances.get(String(accountId)) || { debit: 0, credit: 0 };
  const opening = openingBalances.get(String(accountId)) || { debit: 0, credit: 0 };
  const openingBalance = round2(opening.debit - opening.credit);
  // `totals` is scoped to the selected period (startDate..endDate); the closing balance must carry
  // the opening balance forward, otherwise it shows only the period's net movement.
  const closingBalance = round2(openingBalance + totals.debit - totals.credit);

  const { documentById, partyNameById, accountNameById, partyCodeById, accountCodeById } = await describeEntrySources(
    result.results,
  );
  const branchNameById = await getNameMap(Branch, getUniqueIds(result.results, 'branchId'));
  const meta = ACCOUNT_CATEGORIES[account.category] || {};

  const entries = [];
  for (const entry of result.results) {
    const source = documentById.get(String(entry.sourceId)) || {};
    const config = SOURCE_DOCUMENTS[entry.sourceModule] || {};
    let document = SOURCE_DOCUMENTS[entry.sourceModule];
    if (entry.isSplit) {
      document = SOURCE_DOCUMENTS[`SPLIT_${entry.sourceModule}`];
    }

    let documentNo = source.documentNo || null;
    if (config.noFrom === 'party') {
      documentNo = partyCodeById.get(source.partyId) || null;
    } else if (config.noFrom === 'account') {
      documentNo = accountCodeById.get(source.accountId) || null;
    }

    let partyId = source.partyId;
    if (!partyId && entry.partyId) {
      partyId = String(entry.partyId);
    }
    let partyName = source.documentName || null;
    if (source.accountId) {
      partyName = accountNameById.get(source.accountId) || null;
    } else if (partyId) {
      partyName = partyNameById.get(partyId) || null;
    }

    // The source document itself, unless navFrom names the party or account it belongs to.
    let refId = source.parentId || String(entry.sourceId);
    if (config.navFrom) {
      refId = source[config.navFrom] || source.parentId;
    }

    let refType = null;
    if (refId) {
      refType = document?.navType || null;
    }

    const resolvedPartyType = source.partyType || entry.partyType || null;
    if (refType && (resolvedPartyType === CONTACT_TYPE.VENDOR || resolvedPartyType === LEDGER_PARTY_TYPES.VENDOR)) {
      refType = 'Vendor';
    }

    let branchName = null;
    if (entry.branchId) {
      branchName = branchNameById.get(String(entry.branchId)) || null;
    }

    entries.push({
      id: String(entry._id),
      date: entry.postingDate,
      documentNo,
      partyName,
      type: document?.label || entry.sourceModule,
      refType,
      refId: refId || null,
      narration: entry.narration || null,
      debit: round2(entry.debit),
      credit: round2(entry.credit),
      branchId: entry.branchId ? String(entry.branchId) : null,
      branchName,
    });
  }

  return {
    account: {
      id: String(account._id),
      accountName: account.accountName,
      accountCode: account.accountCode ?? null,
      category: account.category,
      categoryDisplayName: meta.displayName || account.category,
      accountType: meta.accountType || null,
      openingBalance,
      closingBalance: Math.abs(closingBalance),
      isDebit: closingBalance >= 0,
      totalDebit: totals.debit,
      totalCredit: totals.credit,
    },
    entries,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
    totalResults: result.totalResults,
  };
};

// Fetch all ledger entries posted against a source document, grouped by journalId.
const getJournalBySource = async ({ companyId, sourceModule, sourceId }) => {
  const { LedgerEntry, Account } = getBooksModels();
  const { Branch } = getBooksCrmModels();
  const { Company } = getCommonModels();

  if (!companyId || !sourceModule || !sourceId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'companyId, sourceModule and sourceId are required');
  }

  const filter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    sourceModule,
    sourceId: new mongoose.Types.ObjectId(sourceId),
  };

  const entries = await LedgerEntry.find(filter).sort({ journalId: 1, createdAt: 1 }).lean();
  const sourceMeta = SOURCE_DOCUMENTS[sourceModule] || {};
  const sourceLabel = sourceMeta.label || sourceModule;

  const [company, accounts, branches] = await Promise.all([
    Company.findById(companyId).populate('baseCurrency').select('baseCurrency').lean(),
    entries.length
      ? Account.find({ _id: { $in: [...new Set(entries.map(entry => String(entry.accountId)))] } })
          .select('accountName')
          .lean()
      : [],
    entries.length
      ? Branch.find({
          _id: {
            $in: [
              ...new Set(
                entries
                  .map(entry => entry.branchId)
                  .filter(Boolean)
                  .map(String),
              ),
            ],
          },
        })
          .select('name')
          .lean()
      : [],
  ]);

  const accountNameById = new Map(accounts.map(account => [String(account._id), account.accountName || '-']));
  const branchNameById = new Map(branches.map(branch => [String(branch._id), branch.name || '-']));
  const { documentById, partyNameById, accountNameById: sourceAccountNameById } = await describeEntrySources(entries);
  const sharedNarration = entries.every(entry => entry.narration === entries[0]?.narration) ? entries[0]?.narration : null;

  const journalMap = new Map();
  for (const entry of entries) {
    const journalKey = String(entry.journalId);
    if (!journalMap.has(journalKey)) {
      journalMap.set(journalKey, {
        journalId: journalKey,
        postingDate: entry.postingDate,
        title: sharedNarration || `${sourceLabel} Journal`,
        entries: [],
        totalDebit: 0,
        totalCredit: 0,
      });
    }

    const source = documentById.get(String(entry.sourceId)) || {};
    let partyId = source.partyId;
    if (!partyId && entry.partyId) {
      partyId = String(entry.partyId);
    }
    let partyName = source.documentName || null;
    if (source.accountId) {
      partyName = sourceAccountNameById.get(source.accountId) || null;
    } else if (partyId) {
      partyName = partyNameById.get(partyId) || null;
    }

    const journal = journalMap.get(journalKey);
    const debit = round2(entry.debit);
    const credit = round2(entry.credit);
    journal.entries.push({
      id: String(entry._id),
      accountId: String(entry.accountId),
      accountName: accountNameById.get(String(entry.accountId)) || '-',
      branchName: entry.branchId ? branchNameById.get(String(entry.branchId)) || '-' : '-',
      partyName,
      debit,
      credit,
      narration: entry.narration || null,
    });
    journal.totalDebit = round2(journal.totalDebit + debit);
    journal.totalCredit = round2(journal.totalCredit + credit);
  }

  return {
    baseCurrencyCode: company?.baseCurrency?.code || null,
    sourceModule,
    sourceId: String(sourceId),
    journals: [...journalMap.values()],
  };
};

module.exports = {
  buildAppliedAt,
  postJournal,
  postOpeningBalanceJournal,
  postBankTransferJournal,
  postPaymentReceivedJournal,
  postCustomerRefundJournal,
  postInvoiceJournal,
  postDeliveryChallanJournal,
  postGrpoJournal,
  postBillJournal,
  postCreditNoteJournal,
  postDebitNoteJournal,
  postProductionJournal,
  postAdjustmentJournal,
  postExpenseJournal,
  postCreditNoteRefundJournal,
  postDebitNoteRefundJournal,
  postPaymentMadeJournal,
  postVendorRefundJournal,
  postCrossBranchCreditApplyJournal,
  deleteJournal,
  getAccountBalances,
  getAccountLedger,
  getJournalBySource,
  describeEntrySources,
  resolvePartyControlAccount,
  resolveSystemAccount,
};
