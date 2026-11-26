/**
 * Verify customer and vendor branch current balance against transaction-derived expected balance.
 *
 * Customer expected (per customer + branch) =
 *   + branch.openingBalance
 *   + Sum(invoice.total) for non-cancelled invoices
 *   - Sum(amountReceived) from APPROVED payments received (branch = payment.branchId only; skip if no branchId)
 *   - Sum(creditNote.total) for non-cancelled credit notes
 *   + Manual journal: Sum(entry.debits - entry.credits) per (businessAccountLedgerMasterId, journal.branchId)
 *
 * Vendor expected (per vendor + branch) =
 *   + branch.openingBalance
 *   + Sum(bill.total) for non-cancelled bills
 *   - Sum(paymentMade) from APPROVED payments made (branch = payment.branchId only; skip if no branchId)
 *   - Sum(debitNote.total) for non-cancelled debit notes
 *   - Manual journal: Sum(entry.debits - entry.credits) per (businessAccountLedgerMasterId, journal.branchId) — debit decreases payables
 *
 * Usage:
 *   node scripts/verify-customer-balance.js [--companyId=xxx] [--customerId=xxx] [--type=customer|vendor|both] [--verbose]
 *   node scripts/verify-customer-balance.js ... --fix   (apply fix: set branch.currentBalance = expected for each mismatch)
 *   node scripts/verify-customer-balance.js --companyId=xxx --customerId=xxx --type=customer --ledger   (include all ledger entries used for balance)
 *
 * Why do diffs appear?
 *   - Stored balance (branch.currentBalance) is updated by the app when invoices, payments, credit notes, bills, etc. are created/approved/cancelled.
 *   - Expected is recomputed from all those transactions. A diff means stored and transaction-derived balance got out of sync, e.g.:
 *     • A flow once failed to call updateBranchCurrentBalance (bug or legacy).
 *     • Manual journals: the app updates branch balance only when the journal line is for "Account Receivables / Debtors" or "Account Payable / Sundry Creditors" (see manualJournal.service.js). Expected includes all manual journal lines for that entity; legacy journals (before that logic) or journals without branchId (we skip those in expected) can cause a diff.
 *     • Split/non-split or branch attribution differences (script uses payment.branchId for payments).
 *   - Running with --fix overwrites stored currentBalance with expected so they match.
 *
 * Dual-role (customer + vendor): The app stores a single branch.currentBalance updated by both
 * invoices/bills and payments. For parties with both roles we compare stored to combined
 * expected (customer + vendor) once per branch; we do not compare to customer-only or vendor-only.
 *
 * Note: "Payment received" (customer pays us) affects CUSTOMER balance. "Payment made" (we pay
 * vendor) affects VENDOR balance only; for dual-role it is included in the combined expected.
 *
 * Requires: NODE_ENV and .env (e.g. .env.development) with ABSS_CLUSTER and db names.
 *
 * Branch for payments: we use payment.branchId only (both for payment received and payment made).
 * Payments without branchId are skipped. Alignment with getLedgerReport (report.service.js): same
 * formula (invoices ± payments ± credit notes/bills/debit notes ± manual journal + opening).
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
// const path = require('path');
// require('dotenv').config({ path: path.join(__dirname, '../.env') });
// require('dotenv').config({ path: path.join(__dirname, '../.env.development') });

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

const INVOICE_STATUS = { CANCELLED: 'CANCELLED' };
const PAYMENT_STATUS = { APPROVED: 'APPROVED' };
const CREDIT_NOTE_STATUS = { CANCELLED: 'CANCELLED' };
const BILL_STATUSES = { CANCELLED: 'CANCELLED' };
const DEBIT_NOTE_STATUS = { CANCELLED: 'CANCELLED' };

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  let customerId = null;
  let verbose = false;
  let type = 'both'; // customer | vendor | both
  let fix = false;
  let ledger = false;
  for (const a of args) {
    if (a.startsWith('--companyId=')) companyId = a.split('=')[1].trim();
    else if (a.startsWith('--customerId=')) customerId = a.split('=')[1].trim();
    else if (a.startsWith('--type=')) type = a.split('=')[1].trim().toLowerCase();
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--fix') fix = true;
    else if (a === '--ledger') ledger = true;
  }
  if (!['customer', 'vendor', 'both'].includes(type)) type = 'both';
  return { companyId, customerId, verbose, type, fix, ledger };
}

/**
 * Compute expected balance per (customerId, branchId) from transactions.
 */
async function computeExpectedBalances(booksDb, bookCrmDb, companyIdFilter, customerIdFilter) {
  const matchInvoice = {
    customerId: { $exists: true, $ne: null },
    branchId: { $exists: true, $ne: null },
    status: { $ne: INVOICE_STATUS.CANCELLED },
  };
  if (companyIdFilter)
    matchInvoice.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;
  if (customerIdFilter)
    matchInvoice.customerId = mongoose.Types.ObjectId.isValid(customerIdFilter)
      ? new mongoose.Types.ObjectId(customerIdFilter)
      : customerIdFilter;

  const invoiceSums = await booksDb
    .collection('invoices')
    .aggregate([
      { $match: matchInvoice },
      { $group: { _id: { customerId: '$customerId', branchId: '$branchId' }, total: { $sum: '$total' } } },
      { $project: { customerId: '$_id.customerId', branchId: '$_id.branchId', total: 1, _id: 0 } },
    ])
    .toArray();

  const matchCreditNote = {
    customerId: { $exists: true, $ne: null },
    branchId: { $exists: true, $ne: null },
    status: { $ne: CREDIT_NOTE_STATUS.CANCELLED },
  };
  if (companyIdFilter)
    matchCreditNote.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;
  if (customerIdFilter)
    matchCreditNote.customerId = mongoose.Types.ObjectId.isValid(customerIdFilter)
      ? new mongoose.Types.ObjectId(customerIdFilter)
      : customerIdFilter;

  const creditNoteSums = await booksDb
    .collection('creditnotes')
    .aggregate([
      { $match: matchCreditNote },
      { $group: { _id: { customerId: '$customerId', branchId: '$branchId' }, total: { $sum: '$total' } } },
      { $project: { customerId: '$_id.customerId', branchId: '$_id.branchId', total: 1, _id: 0 } },
    ])
    .toArray();

  // Customer balance uses PAYMENT RECEIVED only (payments from customers). Payment Made is for vendor balance.
  // Branch attribution: always use payment.branchId (advance and applied-to-invoices). Skip payments without branchId.
  const paymentMatch = { status: PAYMENT_STATUS.APPROVED };
  if (customerIdFilter)
    paymentMatch.customerId = mongoose.Types.ObjectId.isValid(customerIdFilter)
      ? new mongoose.Types.ObjectId(customerIdFilter)
      : customerIdFilter;
  else paymentMatch.customerId = { $exists: true, $ne: null };
  if (companyIdFilter)
    paymentMatch.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;

  const payments = await bookCrmDb
    .collection('paymentreceiveds')
    .find(paymentMatch)
    .project({ customerId: 1, branchId: 1, amountReceived: 1, isAdvancePayment: 1 })
    .toArray();

  const paymentAppliedByBranch = {}; // key: customerId_branchId -> total applied

  for (const pay of payments) {
    const cid = pay.customerId?.toString();
    if (!cid || !pay.branchId) continue;
    const key = `${cid}_${pay.branchId.toString()}`;
    paymentAppliedByBranch[key] = (paymentAppliedByBranch[key] || 0) + (Number(pay.amountReceived) || 0);
  }

  const expectedByKey = {}; // customerId_branchId -> expected balance

  for (const row of invoiceSums) {
    const key = `${row.customerId.toString()}_${row.branchId.toString()}`;
    expectedByKey[key] = (expectedByKey[key] || 0) + Number(row.total);
  }
  for (const row of creditNoteSums) {
    const key = `${row.customerId.toString()}_${row.branchId.toString()}`;
    expectedByKey[key] = (expectedByKey[key] || 0) - Number(row.total);
  }
  for (const [key, total] of Object.entries(paymentAppliedByBranch)) {
    expectedByKey[key] = (expectedByKey[key] || 0) - total;
  }

  const manualJournalEffect = await getManualJournalEffectByEntityBranch(booksDb, companyIdFilter, customerIdFilter);
  for (const [key, effect] of Object.entries(manualJournalEffect)) {
    expectedByKey[key] = (expectedByKey[key] || 0) + effect;
  }

  return expectedByKey;
}

/**
 * Compute manual journal net effect per (entityId, branchId).
 * Effect = debits - credits (debit increases balance, credit decreases).
 * Uses journal.branchId for branch; entity = journalEntries.businessAccountLedgerMasterId.
 */
async function getManualJournalEffectByEntityBranch(booksDb, companyIdFilter, entityIdFilter) {
  const match = { companyId: companyIdFilter ? new mongoose.Types.ObjectId(companyIdFilter) : { $exists: true, $ne: null } };
  if (entityIdFilter) {
    match['journalEntries.businessAccountLedgerMasterId'] = new mongoose.Types.ObjectId(entityIdFilter);
  }

  const journals = await booksDb.collection('manualjournals').find(match).project({ branchId: 1, journalEntries: 1 }).toArray();

  const effectByKey = {}; // entityId_branchId -> net (debits - credits)

  for (const journal of journals) {
    const branchId = journal.branchId?.toString();
    if (!branchId) continue;

    const entries = journal.journalEntries || [];
    for (const entry of entries) {
      const entityId = entry.businessAccountLedgerMasterId?.toString();
      if (!entityId) continue;
      if (entityIdFilter && entityId !== entityIdFilter.toString()) continue;

      const debits = Number(entry.debits) || 0;
      const credits = Number(entry.credits) || 0;
      const effect = debits - credits;
      const key = `${entityId}_${branchId}`;
      effectByKey[key] = (effectByKey[key] || 0) + effect;
    }
  }

  return effectByKey;
}

/**
 * Fetch all ledger entries that contribute to CUSTOMER expected balance (invoices, credit notes, payments received, manual journals).
 * Used when --ledger is passed with --customerId.
 */
async function getCustomerLedgerEntries(booksDb, bookCrmDb, companyIdFilter, customerIdFilter) {
  const cid = customerIdFilter
    ? mongoose.Types.ObjectId.isValid(customerIdFilter)
      ? new mongoose.Types.ObjectId(customerIdFilter)
      : customerIdFilter
    : null;
  if (!cid) return { invoices: [], creditNotes: [], paymentsReceived: [], manualJournals: [] };

  const matchBase = { companyId: companyIdFilter ? new mongoose.Types.ObjectId(companyIdFilter) : { $exists: true, $ne: null } };

  const [invoices, creditNotes, payments, journals] = await Promise.all([
    booksDb
      .collection('invoices')
      .find({
        ...matchBase,
        customerId: cid,
        branchId: { $exists: true, $ne: null },
        status: { $ne: INVOICE_STATUS.CANCELLED },
      })
      .project({ invoiceId: 1, invoiceDate: 1, total: 1, branchId: 1 })
      .sort({ invoiceDate: 1 })
      .toArray(),
    booksDb
      .collection('creditnotes')
      .find({
        ...matchBase,
        customerId: cid,
        branchId: { $exists: true, $ne: null },
        status: { $ne: CREDIT_NOTE_STATUS.CANCELLED },
      })
      .project({ creditNoteId: 1, creditNoteDate: 1, total: 1, branchId: 1 })
      .sort({ creditNoteDate: 1 })
      .toArray(),
    bookCrmDb
      .collection('paymentreceiveds')
      .find({
        ...matchBase,
        customerId: cid,
        status: PAYMENT_STATUS.APPROVED,
      })
      .project({ paymentReceivedId: 1, paymentDate: 1, amountReceived: 1, isAdvancePayment: 1, branchId: 1 })
      .sort({ paymentDate: 1 })
      .toArray(),
    booksDb
      .collection('manualjournals')
      .find({
        ...matchBase,
        'journalEntries.businessAccountLedgerMasterId': cid,
        branchId: { $exists: true, $ne: null },
      })
      .project({ vchNo: 1, date: 1, branchId: 1, journalEntries: 1 })
      .sort({ date: 1 })
      .toArray(),
  ]);

  const paymentsReceived = [];
  for (const pay of payments) {
    if (!pay.branchId) continue;
    paymentsReceived.push({
      date: pay.paymentDate,
      documentNo: pay.paymentReceivedId || pay._id?.toString(),
      type: pay.isAdvancePayment ? 'advance' : 'applied',
      branchId: pay.branchId.toString(),
      amount: Number(pay.amountReceived) || 0,
      effect: 'credit',
    });
  }

  const manualJournals = [];
  for (const journal of journals) {
    const branchId = journal.branchId?.toString();
    if (!branchId) continue;
    const entries = journal.journalEntries || [];
    for (const entry of entries) {
      if (entry.businessAccountLedgerMasterId?.toString() !== cid.toString()) continue;
      const debits = Number(entry.debits) || 0;
      const credits = Number(entry.credits) || 0;
      const effect = debits - credits;
      manualJournals.push({
        date: journal.date,
        documentNo: journal.vchNo || journal._id?.toString(),
        branchId,
        debits,
        credits,
        effect,
      });
    }
  }

  return {
    invoices: invoices.map(i => ({
      date: i.invoiceDate,
      documentNo: i.invoiceId || i._id?.toString(),
      branchId: i.branchId?.toString(),
      total: Number(i.total) || 0,
      effect: 'debit',
    })),
    creditNotes: creditNotes.map(c => ({
      date: c.creditNoteDate,
      documentNo: c.creditNoteId || c._id?.toString(),
      branchId: c.branchId?.toString(),
      total: Number(c.total) || 0,
      effect: 'credit',
    })),
    paymentsReceived,
    manualJournals,
  };
}

/**
 * Fetch all ledger entries that contribute to VENDOR expected balance (bills, debit notes, payments made, manual journals).
 */
async function getVendorLedgerEntries(booksDb, bookCrmDb, companyIdFilter, vendorIdFilter) {
  const vid = vendorIdFilter
    ? mongoose.Types.ObjectId.isValid(vendorIdFilter)
      ? new mongoose.Types.ObjectId(vendorIdFilter)
      : vendorIdFilter
    : null;
  if (!vid) return { bills: [], debitNotes: [], paymentsMade: [], manualJournals: [] };

  const matchBase = { companyId: companyIdFilter ? new mongoose.Types.ObjectId(companyIdFilter) : { $exists: true, $ne: null } };

  const [bills, debitNotes, payments, journals] = await Promise.all([
    booksDb
      .collection('bills')
      .find({
        ...matchBase,
        vendor: vid,
        branchId: { $exists: true, $ne: null },
        status: { $ne: BILL_STATUSES.CANCELLED },
      })
      .project({ billId: 1, billDate: 1, total: 1, branchId: 1 })
      .sort({ billDate: 1 })
      .toArray(),
    booksDb
      .collection('debitnotes')
      .find({
        ...matchBase,
        vendorId: vid,
        branchId: { $exists: true, $ne: null },
        status: { $ne: DEBIT_NOTE_STATUS.CANCELLED },
      })
      .project({ debitNoteId: 1, debitNoteDate: 1, total: 1, branchId: 1 })
      .sort({ debitNoteDate: 1 })
      .toArray(),
    booksDb
      .collection('paymentmades')
      .find({
        ...matchBase,
        vendorId: vid,
        status: PAYMENT_STATUS.APPROVED,
      })
      .project({ paymentMadeId: 1, paymentDate: 1, paymentMade: 1, isAdvancePayment: 1, branchId: 1 })
      .sort({ paymentDate: 1 })
      .toArray(),
    booksDb
      .collection('manualjournals')
      .find({
        ...matchBase,
        'journalEntries.businessAccountLedgerMasterId': vid,
        branchId: { $exists: true, $ne: null },
      })
      .project({ vchNo: 1, date: 1, branchId: 1, journalEntries: 1 })
      .sort({ date: 1 })
      .toArray(),
  ]);

  const paymentsMade = [];
  for (const pay of payments) {
    if (!pay.branchId) continue;
    paymentsMade.push({
      date: pay.paymentDate,
      documentNo: pay.paymentMadeId || pay._id?.toString(),
      type: pay.isAdvancePayment ? 'advance' : 'applied',
      branchId: pay.branchId.toString(),
      amount: Number(pay.paymentMade) || 0,
      effect: 'debit',
    });
  }

  const manualJournals = [];
  for (const journal of journals) {
    const branchId = journal.branchId?.toString();
    if (!branchId) continue;
    const entries = journal.journalEntries || [];
    for (const entry of entries) {
      if (entry.businessAccountLedgerMasterId?.toString() !== vid.toString()) continue;
      const debits = Number(entry.debits) || 0;
      const credits = Number(entry.credits) || 0;
      const effect = debits - credits;
      manualJournals.push({
        date: journal.date,
        documentNo: journal.vchNo || journal._id?.toString(),
        branchId,
        debits,
        credits,
        effect,
      });
    }
  }

  return {
    bills: bills.map(b => ({
      date: b.billDate,
      documentNo: b.billId || b._id?.toString(),
      branchId: b.branchId?.toString(),
      total: Number(b.total) || 0,
      effect: 'credit',
    })),
    debitNotes: debitNotes.map(v => ({
      date: v.debitNoteDate,
      documentNo: v.debitNoteId || v._id?.toString(),
      branchId: v.branchId?.toString(),
      total: Number(v.total) || 0,
      effect: 'debit',
    })),
    paymentsMade,
    manualJournals,
  };
}

/**
 * Compute expected VENDOR balance per (vendorId, branchId) from bills, payments made, debit notes.
 */
async function computeExpectedVendorBalances(booksDb, bookCrmDb, companyIdFilter, vendorIdFilter) {
  const matchBill = {
    vendor: { $exists: true, $ne: null },
    branchId: { $exists: true, $ne: null },
    status: { $ne: BILL_STATUSES.CANCELLED },
  };
  if (companyIdFilter)
    matchBill.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;
  if (vendorIdFilter)
    matchBill.vendor = mongoose.Types.ObjectId.isValid(vendorIdFilter)
      ? new mongoose.Types.ObjectId(vendorIdFilter)
      : vendorIdFilter;

  const billSums = await booksDb
    .collection('bills')
    .aggregate([
      { $match: matchBill },
      { $group: { _id: { vendorId: '$vendor', branchId: '$branchId' }, total: { $sum: '$total' } } },
      { $project: { vendorId: '$_id.vendorId', branchId: '$_id.branchId', total: 1, _id: 0 } },
    ])
    .toArray();

  const matchDebitNote = {
    vendorId: { $exists: true, $ne: null },
    branchId: { $exists: true, $ne: null },
    status: { $ne: DEBIT_NOTE_STATUS.CANCELLED },
  };
  if (companyIdFilter)
    matchDebitNote.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;
  if (vendorIdFilter)
    matchDebitNote.vendorId = mongoose.Types.ObjectId.isValid(vendorIdFilter)
      ? new mongoose.Types.ObjectId(vendorIdFilter)
      : vendorIdFilter;

  const debitNoteSums = await booksDb
    .collection('debitnotes')
    .aggregate([
      { $match: matchDebitNote },
      { $group: { _id: { vendorId: '$vendorId', branchId: '$branchId' }, total: { $sum: '$total' } } },
      { $project: { vendorId: '$_id.vendorId', branchId: '$_id.branchId', total: 1, _id: 0 } },
    ])
    .toArray();

  // Vendor balance uses PAYMENT MADE (payments we make to vendors).
  // Branch attribution: always use payment.branchId (advance and applied-to-bills). Skip payments without branchId.
  const paymentMatch = { status: PAYMENT_STATUS.APPROVED };
  if (vendorIdFilter)
    paymentMatch.vendorId = mongoose.Types.ObjectId.isValid(vendorIdFilter)
      ? new mongoose.Types.ObjectId(vendorIdFilter)
      : vendorIdFilter;
  else paymentMatch.vendorId = { $exists: true, $ne: null };
  if (companyIdFilter)
    paymentMatch.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;

  const paymentsMade = await booksDb
    .collection('paymentmades')
    .find(paymentMatch)
    .project({ vendorId: 1, branchId: 1, paymentMade: 1, isAdvancePayment: 1 })
    .toArray();

  const paymentAppliedByBranch = {}; // vendorId_branchId -> total applied

  for (const pay of paymentsMade) {
    const vid = pay.vendorId?.toString();
    if (!vid || !pay.branchId) continue;
    const key = `${vid}_${pay.branchId.toString()}`;
    paymentAppliedByBranch[key] = (paymentAppliedByBranch[key] || 0) + (Number(pay.paymentMade) || 0);
  }

  const expectedByKey = {}; // vendorId_branchId -> expected balance (we owe them)

  for (const row of billSums) {
    const key = `${row.vendorId.toString()}_${row.branchId.toString()}`;
    expectedByKey[key] = (expectedByKey[key] || 0) + Number(row.total);
  }
  for (const row of debitNoteSums) {
    const key = `${row.vendorId.toString()}_${row.branchId.toString()}`;
    expectedByKey[key] = (expectedByKey[key] || 0) - Number(row.total);
  }
  for (const [key, total] of Object.entries(paymentAppliedByBranch)) {
    expectedByKey[key] = (expectedByKey[key] || 0) - total;
  }

  // Vendor (payables): debit decreases balance, credit increases. Effect from getManualJournalEffect = debits - credits.
  // So we subtract effect (i.e. add credits - debits) to match ledger/running balance.
  const manualJournalEffect = await getManualJournalEffectByEntityBranch(booksDb, companyIdFilter, vendorIdFilter);
  for (const [key, effect] of Object.entries(manualJournalEffect)) {
    expectedByKey[key] = (expectedByKey[key] || 0) - effect;
  }

  return expectedByKey;
}

function roundBalance(val) {
  if (val == null || val === undefined) return 0;
  return Math.round(Number(val) * 100) / 100;
}

/** Format date for display (YYYY-MM-DD) and return sortable date. */
function toDateKey(d) {
  if (!d) return { display: '', sort: 0 };
  const date = new Date(d);
  const sort = date.getTime();
  const display = isNaN(sort) ? '' : date.toISOString().slice(0, 10);
  return { display, sort };
}

/**
 * Build a flat list of table rows (Date, Branch, Type, Document No, Debit, Credit) from ledger, sorted by date.
 * If branchOpenings is provided, adds a Balance column (running balance per branch).
 * branchOpenings: { branchId: openingBalance }
 */
function buildLedgerTableRows(ledger, type, branchOpenings = null) {
  const rows = [];
  const push = (date, branchId, rowType, documentNo, debit, credit) => {
    const { display } = toDateKey(date);
    const d = debit != null && debit !== 0 ? Number(debit) : 0;
    const c = credit != null && credit !== 0 ? Number(credit) : 0;
    rows.push({
      Date: display,
      Branch: branchId || '-',
      Type: rowType,
      'Document No': documentNo || '-',
      Debit: d !== 0 ? roundBalance(d) : '',
      Credit: c !== 0 ? roundBalance(c) : '',
      _debit: d,
      _credit: c,
      _branchId: branchId || '',
      _sort: toDateKey(date).sort,
    });
  };

  if (type === 'customer' || type === 'both') {
    const c = ledger.customer || {};
    (c.invoices || []).forEach(e => push(e.date, e.branchId, 'Invoice', e.documentNo, e.total, null));
    (c.creditNotes || []).forEach(e => push(e.date, e.branchId, 'Credit Note', e.documentNo, null, e.total));
    (c.paymentsReceived || []).forEach(e =>
      push(
        e.date,
        e.branchId,
        e.type === 'advance' ? 'Payment Recv (Advance)' : 'Payment Recv (Applied)',
        e.documentNo,
        null,
        e.amount,
      ),
    );
    (c.manualJournals || []).forEach(e =>
      push(e.date, e.branchId, 'Manual Journal', e.documentNo, e.debits || null, e.credits || null),
    );
  }
  if (type === 'vendor' || type === 'both') {
    const v = ledger.vendor || {};
    (v.bills || []).forEach(e => push(e.date, e.branchId, 'Bill', e.documentNo, null, e.total));
    (v.debitNotes || []).forEach(e => push(e.date, e.branchId, 'Debit Note', e.documentNo, e.total, null));
    (v.paymentsMade || []).forEach(e =>
      push(
        e.date,
        e.branchId,
        e.type === 'advance' ? 'Payment Made (Advance)' : 'Payment Made (Applied)',
        e.documentNo,
        e.amount,
        null,
      ),
    );
    (v.manualJournals || []).forEach(e =>
      push(e.date, e.branchId, 'Manual Journal', e.documentNo, e.debits || null, e.credits || null),
    );
  }

  rows.sort((a, b) => a._sort - b._sort);

  // Add running balance per branch if branchOpenings provided
  if (branchOpenings && Object.keys(branchOpenings).length > 0) {
    const balanceByBranch = {};
    for (const bid of Object.keys(branchOpenings)) {
      balanceByBranch[bid] = roundBalance(branchOpenings[bid] ?? 0);
    }
    for (const r of rows) {
      const bid = r._branchId;
      if (bid && bid in balanceByBranch) {
        // Vendor: balance += credit - debit. Customer: balance += debit - credit.
        const delta = type === 'vendor' ? r._credit - r._debit : r._debit - r._credit;
        balanceByBranch[bid] = roundBalance(balanceByBranch[bid] + delta);
        r.Balance = balanceByBranch[bid];
      }
    }
  }

  return rows.map(({ _sort, _debit, _credit, _branchId, ...r }) => r);
}

/**
 * Apply fix: set Customer.branch[].currentBalance = expected for each mismatch.
 */
async function applyBalanceFix(bookCrmDb, mismatches) {
  const customers = bookCrmDb.collection('customers');
  let fixed = 0;
  for (const m of mismatches) {
    const partyId = mongoose.Types.ObjectId.isValid(m.partyId) ? new mongoose.Types.ObjectId(m.partyId) : m.partyId;
    const branchId = mongoose.Types.ObjectId.isValid(m.branchId) ? new mongoose.Types.ObjectId(m.branchId) : m.branchId;
    const result = await customers.updateOne(
      { _id: partyId, 'branch.branchId': branchId },
      { $set: { 'branch.$[elem].currentBalance': m.expected } },
      { arrayFilters: [{ 'elem.branchId': branchId }] },
    );
    if (result.modifiedCount > 0) {
      fixed++;
      console.log(`Fixed [${m.type}] ${m.partyName} branch ${m.branchId}: currentBalance ${m.stored} -> ${m.expected}`);
    }
  }
  return fixed;
}

async function run() {
  const { companyId, customerId, verbose, type, fix, ledger } = parseArgs();
  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const booksDb = db.books;
    const bookCrmDb = db.booksCrm;
    const commonDb = db.common;

    const companyIdFilter = companyId || null;
    const customerIdFilter = customerId || null;

    const baseMatch = { 'branch.0': { $exists: true } };
    if (companyIdFilter)
      baseMatch.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
        ? new mongoose.Types.ObjectId(companyIdFilter)
        : companyIdFilter;
    if (customerIdFilter)
      baseMatch._id = mongoose.Types.ObjectId.isValid(customerIdFilter)
        ? new mongoose.Types.ObjectId(customerIdFilter)
        : customerIdFilter;

    const allPartners = await bookCrmDb
      .collection('customers')
      .find(baseMatch)
      .project({ _id: 1, companyId: 1, companyName: 1, customerDisplayName: 1, branch: 1, Role: 1 })
      .toArray();

    const companyIds = [...new Set(allPartners.map(c => c.companyId?.toString()).filter(Boolean))];
    const companyMap = {};
    if (companyIds.length > 0) {
      const companies = await commonDb
        .collection('companies')
        .find({ _id: { $in: companyIds.map(id => new mongoose.Types.ObjectId(id)) } })
        .project({ _id: 1, name: 1 })
        .toArray();
      for (const co of companies) {
        companyMap[co._id.toString()] = co.name || '';
      }
    }

    const mismatches = [];
    let checkedCustomer = 0;
    let checkedVendor = 0;
    let checkedDualRole = 0;

    let expectedByKey = {};
    let expectedVendorByKey = {};
    if (type === 'customer' || type === 'both') {
      expectedByKey = await computeExpectedBalances(booksDb, bookCrmDb, companyIdFilter, customerIdFilter);
    }
    if (type === 'vendor' || type === 'both') {
      expectedVendorByKey = await computeExpectedVendorBalances(booksDb, bookCrmDb, companyIdFilter, customerIdFilter);
    }

    // Customer-only: compare stored to customer expected
    if (type === 'customer' || type === 'both') {
      const customersOnly = allPartners.filter(p => p.Role?.isCustomer && !p.Role?.isVendor);
      for (const cust of customersOnly) {
        const branches = cust.branch || [];
        const custCompanyId = cust.companyId?.toString();
        const companyName = custCompanyId ? companyMap[custCompanyId] || '' : '';
        for (const b of branches) {
          if (!b.branchId) continue;
          checkedCustomer++;
          const key = `${cust._id.toString()}_${b.branchId.toString()}`;
          const openingBalance = roundBalance(b.openingBalance);
          const expectedFromTx = roundBalance(expectedByKey[key] ?? 0);
          const expected = roundBalance(openingBalance + expectedFromTx);
          const stored = roundBalance(b.currentBalance);
          const diff = roundBalance(stored - expected);
          if (Math.abs(diff) > 0.01) {
            mismatches.push({
              type: 'customer',
              companyId: custCompanyId || '',
              companyName: companyName || '',
              partyId: cust._id.toString(),
              partyName: cust.customerDisplayName || cust.companyName || cust._id.toString(),
              branchId: b.branchId.toString(),
              openingBalance,
              stored,
              expected,
              diff,
            });
          } else if (verbose) {
            console.log(
              `OK [customer] [${companyName}] ${cust.customerDisplayName || cust._id} branch ${b.branchId}: stored=${stored} expected=${expected} (opening=${openingBalance})`,
            );
          }
        }
      }
    }

    // Vendor-only: compare stored to vendor expected
    if (type === 'vendor' || type === 'both') {
      const vendorsOnly = allPartners.filter(p => p.Role?.isVendor && !p.Role?.isCustomer);
      for (const cust of vendorsOnly) {
        const branches = cust.branch || [];
        const custCompanyId = cust.companyId?.toString();
        const companyName = custCompanyId ? companyMap[custCompanyId] || '' : '';
        for (const b of branches) {
          if (!b.branchId) continue;
          checkedVendor++;
          const key = `${cust._id.toString()}_${b.branchId.toString()}`;
          const openingBalance = roundBalance(b.openingBalance);
          const expectedFromTx = roundBalance(expectedVendorByKey[key] ?? 0);
          const expected = roundBalance(openingBalance + expectedFromTx);
          const stored = roundBalance(b.currentBalance);
          const diff = roundBalance(stored - expected);
          if (Math.abs(diff) > 0.01) {
            mismatches.push({
              type: 'vendor',
              companyId: custCompanyId || '',
              companyName: companyName || '',
              partyId: cust._id.toString(),
              partyName: cust.customerDisplayName || cust.companyName || cust._id.toString(),
              branchId: b.branchId.toString(),
              openingBalance,
              stored,
              expected,
              diff,
            });
          } else if (verbose) {
            console.log(
              `OK [vendor] [${companyName}] ${cust.customerDisplayName || cust._id} branch ${b.branchId}: stored=${stored} expected=${expected} (opening=${openingBalance})`,
            );
          }
        }
      }
    }

    // Dual-role (customer + vendor): one stored balance per branch updated by both; compare to combined expected
    if (type === 'both') {
      const dualRolePartners = allPartners.filter(p => p.Role?.isCustomer && p.Role?.isVendor);
      for (const cust of dualRolePartners) {
        const branches = cust.branch || [];
        const custCompanyId = cust.companyId?.toString();
        const companyName = custCompanyId ? companyMap[custCompanyId] || '' : '';
        for (const b of branches) {
          if (!b.branchId) continue;
          checkedDualRole++;
          const key = `${cust._id.toString()}_${b.branchId.toString()}`;
          const openingBalance = roundBalance(b.openingBalance);
          const customerTx = roundBalance(expectedByKey[key] ?? 0);
          const vendorTx = roundBalance(expectedVendorByKey[key] ?? 0);
          const expectedFromTx = roundBalance(customerTx + vendorTx);
          const expected = roundBalance(openingBalance + expectedFromTx);
          const stored = roundBalance(b.currentBalance);
          const diff = roundBalance(stored - expected);
          if (Math.abs(diff) > 0.01) {
            mismatches.push({
              type: 'customer+vendor',
              companyId: custCompanyId || '',
              companyName: companyName || '',
              partyId: cust._id.toString(),
              partyName: cust.customerDisplayName || cust.companyName || cust._id.toString(),
              branchId: b.branchId.toString(),
              openingBalance,
              stored,
              expected,
              diff,
            });
          } else if (verbose) {
            console.log(
              `OK [customer+vendor] [${companyName}] ${cust.customerDisplayName || cust._id} branch ${b.branchId}: stored=${stored} expected=${expected} (opening=${openingBalance})`,
            );
          }
        }
      }
    }

    const checked =
      type === 'vendor'
        ? checkedVendor
        : type === 'customer'
          ? checkedCustomer
          : checkedCustomer + checkedVendor + checkedDualRole;
    console.log('\n--- Balance verification ---');
    if (type !== 'vendor') console.log(`Customer-only branches checked: ${checkedCustomer}`);
    if (type !== 'customer') console.log(`Vendor-only branches checked: ${checkedVendor}`);
    if (type === 'both') console.log(`Dual-role (customer+vendor) branches checked: ${checkedDualRole}`);
    console.log(`Total mismatches: ${mismatches.length}`);

    if (mismatches.length > 0) {
      console.log('\nMismatch details (type, stored vs expected, diff = stored - expected):');
      console.table(mismatches);
      console.log(
        '\nDiffs occur when stored branch.currentBalance and transaction-derived expected got out of sync (e.g. legacy data, manual journals, or branch attribution). Use --fix to set stored = expected.',
      );
      if (fix) {
        console.log('\nApplying fix: updating branch.currentBalance to expected...');
        const fixedCount = await applyBalanceFix(bookCrmDb, mismatches);
        console.log(`Fixed ${fixedCount} of ${mismatches.length} mismatched branch balances.`);
      } else {
        console.log('\nTo fix mismatches, re-run with --fix at the end of the command.');
        process.exitCode = 1;
      }
    } else {
      console.log('All branch balances match expected values.');
    }

    // When --ledger and --customerId are provided, output all ledger entries considered for balance
    if (customerIdFilter && ledger) {
      const partner = allPartners.find(p => p._id.toString() === String(customerIdFilter));
      if (!partner) {
        console.log('\n--ledger: No partner found for customerId=' + customerIdFilter + ' (with at least one branch).');
      }
      const companyName = partner?.companyId ? companyMap[partner.companyId.toString()] || '' : '';
      const response = {
        customerId: customerIdFilter,
        companyId: companyIdFilter || (partner?.companyId?.toString() ?? null),
        companyName: companyName || null,
        type,
        partyName: partner ? partner.customerDisplayName || partner.companyName || partner._id.toString() : null,
        role: partner?.Role ? { isCustomer: !!partner.Role.isCustomer, isVendor: !!partner.Role.isVendor } : null,
        branches: [],
        ledger: {},
      };

      if (type === 'customer' || type === 'both') {
        const customerLedger = await getCustomerLedgerEntries(booksDb, bookCrmDb, companyIdFilter, customerIdFilter);
        response.ledger.customer = customerLedger;
      }
      if (type === 'vendor' || type === 'both') {
        const vendorLedger = await getVendorLedgerEntries(booksDb, bookCrmDb, companyIdFilter, customerIdFilter);
        response.ledger.vendor = vendorLedger;
      }

      const branches = partner && partner.branch ? partner.branch : [];
      for (const b of branches) {
        if (!b.branchId) continue;
        const branchIdStr = b.branchId.toString();
        const key = `${partner._id.toString()}_${branchIdStr}`;
        const openingBalance = roundBalance(b.openingBalance);
        const customerTx = type === 'vendor' ? 0 : roundBalance(expectedByKey[key] ?? 0);
        const vendorTx = type === 'customer' ? 0 : roundBalance(expectedVendorByKey[key] ?? 0);
        const expectedFromTx = roundBalance(customerTx + vendorTx);
        const expected = roundBalance(openingBalance + expectedFromTx);
        const stored = roundBalance(b.currentBalance);
        const diff = roundBalance(stored - expected);

        const branchSummary = {
          branchId: branchIdStr,
          openingBalance,
          expectedFromTx,
          expected,
          stored,
          diff,
          match: Math.abs(diff) <= 0.01,
        };

        if (type === 'customer' || type === 'both') {
          const cust = response.ledger.customer;
          branchSummary.customerEntries = {
            invoices: (cust?.invoices || []).filter(e => e.branchId === branchIdStr),
            creditNotes: (cust?.creditNotes || []).filter(e => e.branchId === branchIdStr),
            paymentsReceived: (cust?.paymentsReceived || []).filter(e => e.branchId === branchIdStr),
            manualJournals: (cust?.manualJournals || []).filter(e => e.branchId === branchIdStr),
          };
        }
        if (type === 'vendor' || type === 'both') {
          const vend = response.ledger.vendor;
          branchSummary.vendorEntries = {
            bills: (vend?.bills || []).filter(e => e.branchId === branchIdStr),
            debitNotes: (vend?.debitNotes || []).filter(e => e.branchId === branchIdStr),
            paymentsMade: (vend?.paymentsMade || []).filter(e => e.branchId === branchIdStr),
            manualJournals: (vend?.manualJournals || []).filter(e => e.branchId === branchIdStr),
          };
        }
        response.branches.push(branchSummary);
      }

      const branchOpenings = {};
      for (const b of response.branches) {
        branchOpenings[b.branchId] = b.openingBalance;
      }
      console.log('\n--- Ledger entries (used for balance) — date-wise table with running Balance ---');
      const tableRows = buildLedgerTableRows(response.ledger, type, branchOpenings);
      if (tableRows.length > 0) {
        console.table(tableRows);
        console.log(`Total entries: ${tableRows.length}`);
      } else {
        console.log('No ledger entries found.');
      }

      // Document-wise totals per branch (for comparison with external system)
      console.log('\n--- Document-wise totals (by branch) — compare with your system ---');
      for (const b of response.branches) {
        const docTotals = { branchId: b.branchId };
        if (type === 'customer' || type === 'both') {
          const inv = (b.customerEntries?.invoices || []).reduce((s, e) => s + (e.total || 0), 0);
          const cn = (b.customerEntries?.creditNotes || []).reduce((s, e) => s + (e.total || 0), 0);
          const pr = (b.customerEntries?.paymentsReceived || []).reduce((s, e) => s + (e.amount || 0), 0);
          const mj = (b.customerEntries?.manualJournals || []).reduce((s, e) => s + (e.effect || 0), 0);
          docTotals.invoices = roundBalance(inv);
          docTotals.creditNotes = roundBalance(cn);
          docTotals.paymentsReceived = roundBalance(pr);
          docTotals.customerManualJournal = roundBalance(mj);
          docTotals.customerNet = roundBalance(inv - cn - pr + mj);
        }
        if (type === 'vendor' || type === 'both') {
          const bills = (b.vendorEntries?.bills || []).reduce((s, e) => s + (e.total || 0), 0);
          const vc = (b.vendorEntries?.debitNotes || []).reduce((s, e) => s + (e.total || 0), 0);
          const pm = (b.vendorEntries?.paymentsMade || []).reduce((s, e) => s + (e.amount || 0), 0);
          const mj = (b.vendorEntries?.manualJournals || []).reduce((s, e) => s + (e.effect || 0), 0);
          docTotals.bills = roundBalance(bills);
          docTotals.debitNotes = roundBalance(vc);
          docTotals.paymentsMade = roundBalance(pm);
          docTotals.vendorManualJournal = roundBalance(mj);
          docTotals.vendorNet = roundBalance(bills - vc - pm - mj);
        }
        docTotals.openingBalance = b.openingBalance;
        docTotals.expectedFromTx = b.expectedFromTx;
        docTotals.expected = b.expected;
        docTotals.stored = b.stored;
        docTotals.diff = b.diff;
        console.table([docTotals]);
      }

      console.log('\n--- Branch-wise ledger ---');
      for (const b of response.branches) {
        const branchRows = tableRows.filter(r => r.Branch === b.branchId);
        const lastRow = branchRows.length > 0 ? branchRows[branchRows.length - 1] : null;
        const actualBalance = lastRow && 'Balance' in lastRow ? lastRow.Balance : b.expected;
        console.log(
          `\nBranch: ${b.branchId}  (opening: ${b.openingBalance}, actual balance: ${actualBalance}, expected: ${b.expected}, stored: ${b.stored}, diff: ${b.diff})`,
        );
        if (branchRows.length > 0) {
          console.table(branchRows);
          console.log(`  Entries: ${branchRows.length}  →  Actual balance (from last entry): ${actualBalance}`);
        } else {
          console.log('  No entries for this branch.');
        }
      }

      console.log('\n--- Actual balance (from 114 entries) ---');
      for (const b of response.branches) {
        const branchRows = tableRows.filter(r => r.Branch === b.branchId);
        const lastRow = branchRows.length > 0 ? branchRows[branchRows.length - 1] : null;
        const actualBalance = lastRow && 'Balance' in lastRow ? lastRow.Balance : b.expected;
        console.log(
          `Branch ${b.branchId}: ${actualBalance}  (opening ${b.openingBalance} + net from ${branchRows.length} entries)`,
        );
      }

      console.log('\n--- Summary ---');
      console.log(`Party: ${response.partyName || response.customerId}`);
      console.log(`Company: ${response.companyName || response.companyId || '-'}`);
      console.log(`Type: ${response.type}`);
      if (response.branches.length > 0) {
        console.table(
          response.branches.map(b => ({
            branchId: b.branchId,
            openingBalance: b.openingBalance,
            expectedFromTx: b.expectedFromTx,
            expected: b.expected,
            stored: b.stored,
            diff: b.diff,
            match: b.match ? 'Yes' : 'No',
          })),
        );
      } else {
        console.log('No branches.');
      }
    }
  } catch (err) {
    console.error('Error:', err);
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

run();
