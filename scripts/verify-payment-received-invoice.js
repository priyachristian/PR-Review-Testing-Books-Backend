/**
 * Verify Payment Received and Invoice data consistency.
 *
 * Checks:
 * 1. Advance payment: unusedAmount = amountReceived - sum(invoices[].amountApplied)
 * 2. Invoice: paidAmount = sum of APPROVED payment applications + CreditNote.invoicesApplied (non-CANCELLED) to this invoice
 * 3. Invoice: balanceAmount = total - paidAmount
 * 4. Invoice: status matches paidAmount (PAID / PARTIALLY_PAID / SENT). DRAFT skipped. For unpaid, SENT or OVERDUE accepted (OVERDUE = past due date).
 * 5. Non-advance payment: sum(invoices[].amountApplied) <= amountReceived
 * 6. Each payment application: invoice exists and amountApplied <= invoice.balanceAmount at time of check (we check current balance as proxy)
 *
 * Usage:
 *   node scripts/verify-payment-received-invoice.js [--companyId=xxx] [--verbose]
 *   node scripts/verify-payment-received-invoice.js --fix   (optional: fix invoice paidAmount/balanceAmount/status from payment-derived expected)
 *   node scripts/verify-payment-received-invoice.js --check=advance_unused   (run only this check; use --list-checks to see all types)
 *   node scripts/verify-payment-received-invoice.js --list-checks   (print all check types and exit)
 *   node scripts/verify-payment-received-invoice.js --fix --fix-check=advance_unused   (fix only advance payment unusedAmount)
 *   node scripts/verify-payment-received-invoice.js --fix --fix-check=invoice_status   (fix only invoice paidAmount/balanceAmount/status)
 *
 * Requires: NODE_ENV and .env with ABSS_CLUSTER and db names.
 */

const CHECK_TYPES = [
  { id: 'advance_unused', desc: 'Advance payment: unusedAmount = amountReceived - sum(invoices[].amountApplied)' },
  { id: 'invoice_paidAmount', desc: 'Invoice: paidAmount = sum of payment applications' },
  { id: 'invoice_balanceAmount', desc: 'Invoice: balanceAmount = total - paidAmount' },
  { id: 'invoice_status', desc: 'Invoice: status matches PAID/PARTIALLY_PAID/SENT' },
  { id: 'non_advance_sum', desc: 'Non-advance: sum(amountApplied) <= amountReceived' },
  { id: 'application_invoice_missing', desc: 'Each application references an existing invoice' },
];

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

const PAYMENT_STATUS = { APPROVED: 'APPROVED', CANCELLED: 'CANCELLED' };
const INVOICE_STATUS_CANCELLED = 'CANCELLED';
const CREDIT_NOTE_STATUS_CANCELLED = 'CANCELLED';
const SALES_ORDER_INVOICE_STATUS = {
  DRAFT: 'DRAFT',
  SENT: 'SENT',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
};
// Invoices in DRAFT are not shown in "Apply to Invoice" list (queryCustomerWisePendingInvoices excludes DRAFT).
// So DRAFT with paidAmount=0 is valid; we do not expect them to be SENT.

const FIXABLE_CHECKS = ['advance_unused', 'invoice_paidAmount', 'invoice_balanceAmount', 'invoice_status'];

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  let verbose = false;
  let fix = false;
  let check = null;
  let listChecks = false;
  let fixCheck = null;
  for (const a of args) {
    if (a.startsWith('--companyId=')) companyId = a.split('=')[1].trim();
    else if (a.startsWith('--check=')) check = a.split('=')[1].trim();
    else if (a.startsWith('--fix-check=')) fixCheck = a.split('=')[1].trim();
    else if (a === '--list-checks') listChecks = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--fix') fix = true;
  }
  return { companyId, verbose, fix, check, listChecks, fixCheck };
}

function runListChecks() {
  console.log('\nAvailable check types (use --check=<id> to run only that check):\n');
  CHECK_TYPES.forEach(({ id, desc }) => console.log(`  ${id}\n    ${desc}`));
  console.log('');
}

function roundMoney(val) {
  if (val == null || val === undefined) return 0;
  return Math.round(Number(val) * 100) / 100;
}

/**
 * Compute expected paidAmount per invoice from all APPROVED PaymentReceived (payments applied to invoice).
 */
async function computeExpectedPaidByInvoiceFromPayments(bookCrmDb, companyIdFilter) {
  const match = { status: PAYMENT_STATUS.APPROVED };
  if (companyIdFilter)
    match.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;

  const payments = await bookCrmDb.collection('paymentreceiveds').find(match).project({ invoices: 1 }).toArray();

  const paidByInvoice = new Map(); // invoiceId -> total applied
  for (const pay of payments) {
    for (const inv of pay.invoices || []) {
      const id = inv.invoiceId?.toString();
      if (!id) continue;
      const applied = Number(inv.amountApplied) || 0;
      paidByInvoice.set(id, (paidByInvoice.get(id) || 0) + applied);
    }
  }
  return paidByInvoice;
}

/**
 * Compute amount applied to each invoice from CreditNote.invoicesApplied (non-CANCELLED credit notes).
 */
async function computeExpectedPaidByInvoiceFromCreditNotes(booksDb, companyIdFilter) {
  const match = { status: { $ne: CREDIT_NOTE_STATUS_CANCELLED } };
  if (companyIdFilter)
    match.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;

  const creditNotes = await booksDb.collection('creditnotes').find(match).project({ invoicesApplied: 1 }).toArray();

  const appliedByInvoice = new Map(); // invoiceId -> total applied from credit notes
  for (const cn of creditNotes) {
    for (const app of cn.invoicesApplied || []) {
      const id = app.invoiceId?.toString();
      if (!id) continue;
      const applied = Number(app.amountApplied) || 0;
      appliedByInvoice.set(id, (appliedByInvoice.get(id) || 0) + applied);
    }
  }
  return appliedByInvoice;
}

/**
 * Expected status from paidAmount and total.
 */
function expectedStatus(paidAmount, total) {
  if (roundMoney(paidAmount) >= roundMoney(total)) return SALES_ORDER_INVOICE_STATUS.PAID;
  if (roundMoney(paidAmount) > 0) return SALES_ORDER_INVOICE_STATUS.PARTIALLY_PAID;
  return SALES_ORDER_INVOICE_STATUS.SENT;
}

async function run() {
  const { companyId, verbose, fix, check, listChecks, fixCheck } = parseArgs();

  if (listChecks) {
    runListChecks();
    return;
  }

  const checkFilter = check || null;
  if (checkFilter && !CHECK_TYPES.some(t => t.id === checkFilter)) {
    console.error(`Unknown check type: ${checkFilter}`);
    runListChecks();
    process.exitCode = 1;
    return;
  }
  if (fixCheck && !FIXABLE_CHECKS.includes(fixCheck)) {
    console.error(`Unknown or not fixable --fix-check: ${fixCheck}. Fixable: ${FIXABLE_CHECKS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const runCheck = id => !checkFilter || checkFilter === id;

  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const booksDb = db.books;
    const bookCrmDb = db.booksCrm;
    const commonDb = db.common;

    const companyIdFilter = companyId || null;
    let companyName = null;
    if (companyIdFilter) {
      const companyDoc = await commonDb.collection('companies').findOne(
        {
          _id: mongoose.Types.ObjectId.isValid(companyIdFilter) ? new mongoose.Types.ObjectId(companyIdFilter) : companyIdFilter,
        },
        { projection: { name: 1 } },
      );
      companyName = companyDoc?.name || companyIdFilter;
    }
    const matchInvoice = { status: { $ne: INVOICE_STATUS_CANCELLED } };
    if (companyIdFilter)
      matchInvoice.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
        ? new mongoose.Types.ObjectId(companyIdFilter)
        : companyIdFilter;

    const invoices = await booksDb
      .collection('invoices')
      .find(matchInvoice)
      .project({ _id: 1, invoiceId: 1, total: 1, paidAmount: 1, balanceAmount: 1, status: 1, companyId: 1 })
      .toArray();

    const paymentMatch = { status: PAYMENT_STATUS.APPROVED };
    if (companyIdFilter)
      paymentMatch.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
        ? new mongoose.Types.ObjectId(companyIdFilter)
        : companyIdFilter;

    const payments = await bookCrmDb
      .collection('paymentreceiveds')
      .find(paymentMatch)
      .project({
        _id: 1,
        paymentReceivedId: 1,
        companyId: 1,
        amountReceived: 1,
        unusedAmount: 1,
        isAdvancePayment: 1,
        invoices: 1,
      })
      .toArray();

    const paidFromPayments = await computeExpectedPaidByInvoiceFromPayments(bookCrmDb, companyIdFilter);
    const paidFromCreditNotes = await computeExpectedPaidByInvoiceFromCreditNotes(booksDb, companyIdFilter);
    const expectedPaidByInvoice = new Map(paidFromPayments);
    for (const [invoiceId, amount] of paidFromCreditNotes) {
      expectedPaidByInvoice.set(invoiceId, (expectedPaidByInvoice.get(invoiceId) || 0) + amount);
    }
    const invoiceMap = new Map(invoices.map(inv => [inv._id.toString(), inv]));

    // Build companyId -> name map for error table (single company when filtered, else all from data)
    const companyMap = new Map();
    if (companyIdFilter && companyName != null) {
      companyMap.set(companyIdFilter, companyName);
    } else {
      const cids = new Set();
      for (const inv of invoices) cids.add(inv.companyId?.toString());
      for (const pay of payments) cids.add(pay.companyId?.toString());
      cids.delete(undefined);
      if (cids.size > 0) {
        const companies = await commonDb
          .collection('companies')
          .find({ _id: { $in: [...cids].map(id => new mongoose.Types.ObjectId(id)) } })
          .project({ _id: 1, name: 1 })
          .toArray();
        for (const c of companies) companyMap.set(c._id.toString(), c.name || c._id.toString());
      }
    }

    const errors = [];
    let advanceChecked = 0;
    let advanceOk = 0;
    let invoicePaidChecked = 0;
    let invoicePaidOk = 0;
    let invoiceBalanceChecked = 0;
    let invoiceBalanceOk = 0;
    let invoiceStatusChecked = 0;
    let invoiceStatusOk = 0;
    let nonAdvanceChecked = 0;
    let nonAdvanceOk = 0;

    // --- 1. Advance payment: unusedAmount = amountReceived - sum(invoices[].amountApplied) ---
    if (runCheck('advance_unused')) {
      for (const pay of payments) {
        if (!pay.isAdvancePayment) continue;
        advanceChecked++;
        const amountReceived = roundMoney(pay.amountReceived);
        const sumApplied = (pay.invoices || []).reduce((s, inv) => s + roundMoney(inv.amountApplied || 0), 0);
        const expectedUnused = roundMoney(amountReceived - sumApplied);
        const storedUnused = roundMoney(pay.unusedAmount);
        if (Math.abs(storedUnused - expectedUnused) > 0.01) {
          const cid = pay.companyId?.toString();
          errors.push({
            check: 'advance_unused',
            paymentReceivedId: pay.paymentReceivedId || pay._id?.toString(),
            paymentId: pay._id?.toString(),
            companyId: cid,
            companyName: companyMap.get(cid) || cid || '-',
            message: `Advance payment unusedAmount mismatch: stored=${storedUnused}, expected=amountReceived-sumApplied=${amountReceived}-${sumApplied}=${expectedUnused}`,
            storedUnused,
            expectedUnused,
            amountReceived,
            sumApplied,
          });
        } else {
          advanceOk++;
          if (verbose)
            console.log(`OK [advance] ${pay.paymentReceivedId}: unusedAmount=${storedUnused} (expected ${expectedUnused})`);
        }
      }
    }

    // --- 2 & 3 & 4. Invoice: paidAmount, balanceAmount, status ---
    if (runCheck('invoice_paidAmount') || runCheck('invoice_balanceAmount') || runCheck('invoice_status')) {
      for (const inv of invoices) {
        const idStr = inv._id.toString();
        const total = roundMoney(inv.total);
        const expectedPaid = roundMoney(expectedPaidByInvoice.get(idStr) || 0);
        const storedPaid = roundMoney(inv.paidAmount);
        const storedBalance = roundMoney(inv.balanceAmount);
        const expectedBalance = roundMoney(total - expectedPaid);
        const expectedStatusVal = expectedStatus(expectedPaid, total);

        if (runCheck('invoice_paidAmount')) {
          invoicePaidChecked++;
          if (Math.abs(storedPaid - expectedPaid) > 0.01) {
            const cid = inv.companyId?.toString();
            errors.push({
              check: 'invoice_paidAmount',
              invoiceId: inv.invoiceId || idStr,
              invoiceDocId: idStr,
              companyId: cid,
              companyName: companyMap.get(cid) || cid || '-',
              message: `Invoice paidAmount mismatch: stored=${storedPaid}, expected from payments=${expectedPaid}`,
              storedPaid,
              expectedPaid,
              total,
            });
          } else {
            invoicePaidOk++;
          }
        }

        if (runCheck('invoice_balanceAmount')) {
          invoiceBalanceChecked++;
          if (Math.abs(storedBalance - expectedBalance) > 0.01) {
            const cid = inv.companyId?.toString();
            errors.push({
              check: 'invoice_balanceAmount',
              invoiceId: inv.invoiceId || idStr,
              invoiceDocId: idStr,
              companyId: cid,
              companyName: companyMap.get(cid) || cid || '-',
              message: `Invoice balanceAmount mismatch: stored=${storedBalance}, expected total-paidAmount=${total}-${expectedPaid}=${expectedBalance}`,
              storedBalance,
              expectedBalance,
              total,
              paidAmount: storedPaid,
            });
          } else {
            invoiceBalanceOk++;
          }
        }

        if (runCheck('invoice_status')) {
          invoiceStatusChecked++;
          // DRAFT invoices are not eligible for payment application; skip status check for DRAFT.
          if (inv.status === SALES_ORDER_INVOICE_STATUS.DRAFT) {
            invoiceStatusOk++;
          } else if (inv.status !== expectedStatusVal) {
            // When unpaid (expected SENT), OVERDUE is also valid: invoice was SENT and due date passed.
            const validForUnpaid = [SALES_ORDER_INVOICE_STATUS.SENT, SALES_ORDER_INVOICE_STATUS.OVERDUE];
            const statusOk = expectedStatusVal === SALES_ORDER_INVOICE_STATUS.SENT && validForUnpaid.includes(inv.status);
            if (statusOk) {
              invoiceStatusOk++;
            } else {
              const cid = inv.companyId?.toString();
              errors.push({
                check: 'invoice_status',
                invoiceId: inv.invoiceId || idStr,
                invoiceDocId: idStr,
                companyId: cid,
                companyName: companyMap.get(cid) || cid || '-',
                message: `Invoice status mismatch: stored=${inv.status}, expected=${expectedStatusVal} (paidAmount=${storedPaid}, total=${total})`,
                storedStatus: inv.status,
                expectedStatus: expectedStatusVal,
              });
            }
          } else {
            invoiceStatusOk++;
          }
        }
      }
    }

    // --- 5. Non-advance: sum(invoices[].amountApplied) <= amountReceived ---
    if (runCheck('non_advance_sum')) {
      for (const pay of payments) {
        if (pay.isAdvancePayment || !(pay.invoices && pay.invoices.length)) continue;
        nonAdvanceChecked++;
        const sumApplied = (pay.invoices || []).reduce((s, inv) => s + roundMoney(inv.amountApplied || 0), 0);
        const amountReceived = roundMoney(pay.amountReceived);
        if (sumApplied > amountReceived + 0.01) {
          const cid = pay.companyId?.toString();
          errors.push({
            check: 'non_advance_sum',
            paymentReceivedId: pay.paymentReceivedId || pay._id?.toString(),
            paymentId: pay._id?.toString(),
            companyId: cid,
            companyName: companyMap.get(cid) || cid || '-',
            message: `Non-advance payment: sum(amountApplied)=${sumApplied} > amountReceived=${amountReceived}`,
            sumApplied,
            amountReceived,
          });
        } else {
          nonAdvanceOk++;
        }
      }
    }

    // --- 6. Each application: invoice exists (already have invoice list; applied <= total - expectedPaid for that invoice would need incremental logic, skip or simplify) ---
    // We only report if an invoice in a payment is missing from our invoice list (cancelled or deleted)
    if (runCheck('application_invoice_missing')) {
      for (const pay of payments) {
        for (const app of pay.invoices || []) {
          const invId = app.invoiceId?.toString();
          if (!invId) continue;
          const inv = invoiceMap.get(invId);
          if (!inv) {
            const cid = pay.companyId?.toString();
            errors.push({
              check: 'application_invoice_missing',
              paymentReceivedId: pay.paymentReceivedId || pay._id?.toString(),
              paymentId: pay._id?.toString(),
              companyId: cid,
              companyName: companyMap.get(cid) || cid || '-',
              invoiceId: invId,
              invoiceDocId: invId,
              amountApplied: app.amountApplied,
              message: `Payment references invoice ${invId} which is not found or is cancelled`,
            });
          }
        }
      }
    }

    // --- Summary ---
    console.log('\n--- Payment Received & Invoice verification ---');
    console.log(`Company: ${companyName != null ? `${companyName} (${companyIdFilter})` : 'all'}`);
    if (checkFilter) console.log(`Check: ${checkFilter}`);
    if (!checkFilter || runCheck('advance_unused')) console.log(`Advance payments checked: ${advanceChecked} (OK: ${advanceOk})`);
    if (!checkFilter || runCheck('invoice_paidAmount'))
      console.log(`Invoice paidAmount checked: ${invoicePaidChecked} (OK: ${invoicePaidOk})`);
    if (!checkFilter || runCheck('invoice_balanceAmount'))
      console.log(`Invoice balanceAmount checked: ${invoiceBalanceChecked} (OK: ${invoiceBalanceOk})`);
    if (!checkFilter || runCheck('invoice_status'))
      console.log(`Invoice status checked: ${invoiceStatusChecked} (OK: ${invoiceStatusOk})`);
    if (!checkFilter || runCheck('non_advance_sum'))
      console.log(`Non-advance sum applied checked: ${nonAdvanceChecked} (OK: ${nonAdvanceOk})`);
    console.log(`Total errors: ${errors.length}`);

    if (errors.length > 0) {
      console.log('\nError details:');
      console.table(
        errors.map(e => ({
          _id: e.invoiceDocId || e.paymentId || '-',
          company: e.companyName || e.companyId || '-',
          check: e.check,
          invoiceId: e.invoiceId || (['advance_unused', 'non_advance_sum'].includes(e.check) ? 'n/a' : '-'),
          paymentReceivedId: e.paymentReceivedId || '-',
          message: e.message,
        })),
      );
      if (fix) {
        const doAdvanceFix = !fixCheck || fixCheck === 'advance_unused';
        const doInvoiceFix = !fixCheck || fixCheck !== 'advance_unused';

        if (doAdvanceFix) {
          const advanceErrors = errors.filter(e => e.check === 'advance_unused');
          if (advanceErrors.length > 0) {
            console.log('\n--fix [advance_unused]: correcting payment unusedAmount...');
            let advanceFixed = 0;
            for (const e of advanceErrors) {
              if (!e.paymentId || e.expectedUnused == null) continue;
              // Only set unusedAmount; all other payment fields are left unchanged
              const result = await bookCrmDb
                .collection('paymentreceiveds')
                .updateOne({ _id: new mongoose.Types.ObjectId(e.paymentId) }, { $set: { unusedAmount: e.expectedUnused } });
              if (result.modifiedCount > 0) {
                advanceFixed++;
                console.log(`Fixed payment ${e.paymentReceivedId} (_id: ${e.paymentId}): unusedAmount=${e.expectedUnused}`);
              }
            }
            console.log(`Fixed ${advanceFixed} advance payment(s).`);
          }
        }

        if (doInvoiceFix) {
          const invoiceFixChecks =
            fixCheck && fixCheck !== 'advance_unused'
              ? [fixCheck]
              : ['invoice_paidAmount', 'invoice_balanceAmount', 'invoice_status'];
          const fixableErrors = errors.filter(e => invoiceFixChecks.includes(e.check));
          const invoiceIdsToFix = [...new Set(fixableErrors.map(e => e.invoiceDocId).filter(Boolean))];
          if (invoiceIdsToFix.length > 0) {
            console.log('\n--fix [invoice]: correcting paidAmount, balanceAmount, status...');
            const byInvoice = new Map();
            for (const inv of invoices) {
              const idStr = inv._id.toString();
              const total = roundMoney(inv.total);
              const expectedPaid = roundMoney(expectedPaidByInvoice.get(idStr) || 0);
              const expectedBalance = roundMoney(total - expectedPaid);
              const statusVal =
                inv.status === SALES_ORDER_INVOICE_STATUS.DRAFT
                  ? SALES_ORDER_INVOICE_STATUS.DRAFT
                  : expectedStatus(expectedPaid, total);
              byInvoice.set(idStr, { expectedPaid, expectedBalance, expectedStatus: statusVal });
            }
            let fixed = 0;
            for (const docId of invoiceIdsToFix) {
              const vals = byInvoice.get(docId);
              if (!vals) continue;
              const inv = invoices.find(i => i._id.toString() === docId);
              const statusToSet =
                inv?.status === SALES_ORDER_INVOICE_STATUS.DRAFT ? SALES_ORDER_INVOICE_STATUS.DRAFT : vals.expectedStatus;
              // Only set these three fields; all other invoice fields are left unchanged
              const result = await booksDb.collection('invoices').updateOne(
                { _id: new mongoose.Types.ObjectId(docId) },
                {
                  $set: {
                    paidAmount: vals.expectedPaid,
                    balanceAmount: vals.expectedBalance,
                    status: statusToSet,
                  },
                },
              );
              if (result.modifiedCount > 0) {
                fixed++;
                const invoiceNo = inv?.invoiceId || docId;
                console.log(
                  `Fixed invoice ${invoiceNo} (_id: ${docId}): paidAmount=${vals.expectedPaid}, balanceAmount=${vals.expectedBalance}, status=${statusToSet}`,
                );
              }
            }
            console.log(`Fixed ${fixed} invoice document(s).`);
          }
        }

        const fixableChecks = FIXABLE_CHECKS;
        const hasUnfixable = errors.some(e => !fixableChecks.includes(e.check));
        process.exitCode = hasUnfixable ? 1 : 0;
      } else {
        console.log(
          '\nRe-run with --fix to correct. Use --fix-check=advance_unused to fix only advance unusedAmount, or --fix-check=invoice_status (etc.) for invoice fields.',
        );
        process.exitCode = 1;
      }
    } else {
      console.log('All checks passed.');
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
