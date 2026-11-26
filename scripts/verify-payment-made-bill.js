/**
 * Verify Payment Made and Bill data consistency (purchase side).
 *
 * Checks:
 * 1. Advance payment: unusedAmount = paymentMade - sum(bills[].amountApplied)
 * 2. Bill: paidAmount = sum of APPROVED PaymentMade applications + DebitNote.billsApplied (non-CANCELLED) to this bill
 * 3. Bill: balanceAmount = total - paidAmount
 * 4. Bill: status matches paidAmount (PAID / PARTIALLY_PAID / OPEN). DRAFT skipped. For unpaid, OPEN or OVERDUE accepted.
 * 5. Non-advance payment: sum(bills[].amountApplied) <= paymentMade
 * 6. Each payment application: bill exists (not missing/cancelled)
 *
 * Usage:
 *   node scripts/verify-payment-made-bill.js [--companyId=xxx] [--verbose]
 *   node scripts/verify-payment-made-bill.js --fix
 *   node scripts/verify-payment-made-bill.js --check=advance_unused
 *   node scripts/verify-payment-made-bill.js --list-checks
 *   node scripts/verify-payment-made-bill.js --fix --fix-check=advance_unused
 *   node scripts/verify-payment-made-bill.js --fix --fix-check=bill_status
 *
 * Requires: NODE_ENV and .env with ABSS_CLUSTER and db names.
 */

const CHECK_TYPES = [
  { id: 'advance_unused', desc: 'Advance payment: unusedAmount = paymentMade - sum(bills[].amountApplied)' },
  { id: 'bill_paidAmount', desc: 'Bill: paidAmount = sum of payment + debit note applications' },
  { id: 'bill_balanceAmount', desc: 'Bill: balanceAmount = total - paidAmount' },
  { id: 'bill_status', desc: 'Bill: status matches PAID/PARTIALLY_PAID/OPEN' },
  { id: 'non_advance_sum', desc: 'Non-advance: sum(amountApplied) <= paymentMade' },
  { id: 'application_bill_missing', desc: 'Each application references an existing bill' },
];

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

const PAYMENT_STATUS = { APPROVED: 'APPROVED', CANCELLED: 'CANCELLED' };
const BILL_STATUSES = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  OVERDUE: 'OVERDUE',
};
const DEBIT_NOTE_STATUS_CANCELLED = 'CANCELLED';

const FIXABLE_CHECKS = ['advance_unused', 'bill_paidAmount', 'bill_balanceAmount', 'bill_status'];

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
 * Compute expected paidAmount per bill from APPROVED PaymentMade (bills[].amountApplied).
 */
async function computeExpectedPaidByBillFromPayments(booksDb, companyIdFilter) {
  const match = { status: PAYMENT_STATUS.APPROVED };
  if (companyIdFilter)
    match.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;

  const payments = await booksDb.collection('paymentmades').find(match).project({ bills: 1 }).toArray();

  const paidByBill = new Map();
  for (const pay of payments) {
    for (const b of pay.bills || []) {
      const id = b.billId?.toString();
      if (!id) continue;
      const applied = Number(b.amountApplied) || 0;
      paidByBill.set(id, (paidByBill.get(id) || 0) + applied);
    }
  }
  return paidByBill;
}

/**
 * Compute amount applied to each bill from DebitNote.billsApplied (non-CANCELLED).
 */
async function computeExpectedPaidByBillFromDebitNotes(booksDb, companyIdFilter) {
  const match = { status: { $ne: DEBIT_NOTE_STATUS_CANCELLED } };
  if (companyIdFilter)
    match.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
      ? new mongoose.Types.ObjectId(companyIdFilter)
      : companyIdFilter;

  const debitNotes = await booksDb.collection('debitnotes').find(match).project({ billsApplied: 1 }).toArray();

  const appliedByBill = new Map();
  for (const vc of debitNotes) {
    for (const app of vc.billsApplied || []) {
      const id = app.billId?.toString();
      if (!id) continue;
      const applied = Number(app.amountApplied) || 0;
      appliedByBill.set(id, (appliedByBill.get(id) || 0) + applied);
    }
  }
  return appliedByBill;
}

function expectedBillStatus(paidAmount, total) {
  if (roundMoney(paidAmount) >= roundMoney(total)) return BILL_STATUSES.PAID;
  if (roundMoney(paidAmount) > 0) return BILL_STATUSES.PARTIALLY_PAID;
  return BILL_STATUSES.OPEN;
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

    const matchBill = {};
    if (companyIdFilter)
      matchBill.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
        ? new mongoose.Types.ObjectId(companyIdFilter)
        : companyIdFilter;

    const bills = await booksDb
      .collection('bills')
      .find(matchBill)
      .project({ _id: 1, billId: 1, total: 1, paidAmount: 1, balanceAmount: 1, status: 1, companyId: 1 })
      .toArray();

    const paymentMatch = { status: PAYMENT_STATUS.APPROVED };
    if (companyIdFilter)
      paymentMatch.companyId = mongoose.Types.ObjectId.isValid(companyIdFilter)
        ? new mongoose.Types.ObjectId(companyIdFilter)
        : companyIdFilter;

    const payments = await booksDb
      .collection('paymentmades')
      .find(paymentMatch)
      .project({
        _id: 1,
        paymentMadeId: 1,
        companyId: 1,
        paymentMade: 1,
        unusedAmount: 1,
        isAdvancePayment: 1,
        bills: 1,
      })
      .toArray();

    const paidFromPayments = await computeExpectedPaidByBillFromPayments(booksDb, companyIdFilter);
    const paidFromDebitNotes = await computeExpectedPaidByBillFromDebitNotes(booksDb, companyIdFilter);
    const expectedPaidByBill = new Map(paidFromPayments);
    for (const [billId, amount] of paidFromDebitNotes) {
      expectedPaidByBill.set(billId, (expectedPaidByBill.get(billId) || 0) + amount);
    }
    const billMap = new Map(bills.map(b => [b._id.toString(), b]));

    const companyMap = new Map();
    if (companyIdFilter && companyName != null) {
      companyMap.set(companyIdFilter, companyName);
    } else {
      const cids = new Set();
      for (const b of bills) cids.add(b.companyId?.toString());
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
    let billPaidChecked = 0;
    let billPaidOk = 0;
    let billBalanceChecked = 0;
    let billBalanceOk = 0;
    let billStatusChecked = 0;
    let billStatusOk = 0;
    let nonAdvanceChecked = 0;
    let nonAdvanceOk = 0;

    // --- 1. Advance payment: unusedAmount = paymentMade - sum(bills[].amountApplied) ---
    if (runCheck('advance_unused')) {
      for (const pay of payments) {
        if (!pay.isAdvancePayment) continue;
        advanceChecked++;
        const paymentMade = roundMoney(pay.paymentMade);
        const sumApplied = (pay.bills || []).reduce((s, b) => s + roundMoney(b.amountApplied || 0), 0);
        const expectedUnused = roundMoney(paymentMade - sumApplied);
        const storedUnused = roundMoney(pay.unusedAmount);
        if (Math.abs(storedUnused - expectedUnused) > 0.01) {
          const cid = pay.companyId?.toString();
          errors.push({
            check: 'advance_unused',
            paymentMadeId: pay.paymentMadeId || pay._id?.toString(),
            paymentId: pay._id?.toString(),
            companyId: cid,
            companyName: companyMap.get(cid) || cid || '-',
            message: `Advance payment unusedAmount mismatch: stored=${storedUnused}, expected=paymentMade-sumApplied=${paymentMade}-${sumApplied}=${expectedUnused}`,
            storedUnused,
            expectedUnused,
            paymentMade,
            sumApplied,
          });
        } else {
          advanceOk++;
          if (verbose)
            console.log(`OK [advance] ${pay.paymentMadeId}: unusedAmount=${storedUnused} (expected ${expectedUnused})`);
        }
      }
    }

    // --- 2 & 3 & 4. Bill: paidAmount, balanceAmount, status ---
    if (runCheck('bill_paidAmount') || runCheck('bill_balanceAmount') || runCheck('bill_status')) {
      for (const bill of bills) {
        const idStr = bill._id.toString();
        const total = roundMoney(bill.total);
        const expectedPaid = roundMoney(expectedPaidByBill.get(idStr) || 0);
        const storedPaid = roundMoney(bill.paidAmount);
        const storedBalance = roundMoney(bill.balanceAmount);
        const expectedBalance = roundMoney(total - expectedPaid);
        const expectedStatusVal = expectedBillStatus(expectedPaid, total);

        if (runCheck('bill_paidAmount')) {
          billPaidChecked++;
          if (Math.abs(storedPaid - expectedPaid) > 0.01) {
            const cid = bill.companyId?.toString();
            errors.push({
              check: 'bill_paidAmount',
              billId: bill.billId || idStr,
              billDocId: idStr,
              companyId: cid,
              companyName: companyMap.get(cid) || cid || '-',
              message: `Bill paidAmount mismatch: stored=${storedPaid}, expected from payments/credits=${expectedPaid}`,
              storedPaid,
              expectedPaid,
              total,
            });
          } else {
            billPaidOk++;
          }
        }

        if (runCheck('bill_balanceAmount')) {
          billBalanceChecked++;
          if (Math.abs(storedBalance - expectedBalance) > 0.01) {
            const cid = bill.companyId?.toString();
            errors.push({
              check: 'bill_balanceAmount',
              billId: bill.billId || idStr,
              billDocId: idStr,
              companyId: cid,
              companyName: companyMap.get(cid) || cid || '-',
              message: `Bill balanceAmount mismatch: stored=${storedBalance}, expected total-paidAmount=${total}-${expectedPaid}=${expectedBalance}`,
              storedBalance,
              expectedBalance,
              total,
              paidAmount: storedPaid,
            });
          } else {
            billBalanceOk++;
          }
        }

        if (runCheck('bill_status')) {
          billStatusChecked++;
          if (bill.status === BILL_STATUSES.DRAFT) {
            billStatusOk++;
          } else if (bill.status !== expectedStatusVal) {
            const validForUnpaid = [BILL_STATUSES.OPEN, BILL_STATUSES.OVERDUE];
            const statusOk = expectedStatusVal === BILL_STATUSES.OPEN && validForUnpaid.includes(bill.status);
            if (statusOk) {
              billStatusOk++;
            } else {
              const cid = bill.companyId?.toString();
              errors.push({
                check: 'bill_status',
                billId: bill.billId || idStr,
                billDocId: idStr,
                companyId: cid,
                companyName: companyMap.get(cid) || cid || '-',
                message: `Bill status mismatch: stored=${bill.status}, expected=${expectedStatusVal} (paidAmount=${storedPaid}, total=${total})`,
                storedStatus: bill.status,
                expectedStatus: expectedStatusVal,
              });
            }
          } else {
            billStatusOk++;
          }
        }
      }
    }

    // --- 5. Non-advance: sum(bills[].amountApplied) <= paymentMade ---
    if (runCheck('non_advance_sum')) {
      for (const pay of payments) {
        if (pay.isAdvancePayment || !(pay.bills && pay.bills.length)) continue;
        nonAdvanceChecked++;
        const sumApplied = (pay.bills || []).reduce((s, b) => s + roundMoney(b.amountApplied || 0), 0);
        const paymentMade = roundMoney(pay.paymentMade);
        if (sumApplied > paymentMade + 0.01) {
          const cid = pay.companyId?.toString();
          errors.push({
            check: 'non_advance_sum',
            paymentMadeId: pay.paymentMadeId || pay._id?.toString(),
            paymentId: pay._id?.toString(),
            companyId: cid,
            companyName: companyMap.get(cid) || cid || '-',
            message: `Non-advance payment: sum(amountApplied)=${sumApplied} > paymentMade=${paymentMade}`,
            sumApplied,
            paymentMade,
          });
        } else {
          nonAdvanceOk++;
        }
      }
    }

    // --- 6. Each application: bill exists ---
    if (runCheck('application_bill_missing')) {
      for (const pay of payments) {
        for (const app of pay.bills || []) {
          const billId = app.billId?.toString();
          if (!billId) continue;
          const bill = billMap.get(billId);
          if (!bill) {
            const cid = pay.companyId?.toString();
            errors.push({
              check: 'application_bill_missing',
              paymentMadeId: pay.paymentMadeId || pay._id?.toString(),
              paymentId: pay._id?.toString(),
              companyId: cid,
              companyName: companyMap.get(cid) || cid || '-',
              billId,
              billDocId: billId,
              amountApplied: app.amountApplied,
              message: `Payment references bill ${billId} which is not found`,
            });
          }
        }
      }
    }

    // --- Summary ---
    console.log('\n--- Payment Made & Bill verification ---');
    console.log(`Company: ${companyName != null ? `${companyName} (${companyIdFilter})` : 'all'}`);
    if (checkFilter) console.log(`Check: ${checkFilter}`);
    if (!checkFilter || runCheck('advance_unused')) console.log(`Advance payments checked: ${advanceChecked} (OK: ${advanceOk})`);
    if (!checkFilter || runCheck('bill_paidAmount'))
      console.log(`Bill paidAmount checked: ${billPaidChecked} (OK: ${billPaidOk})`);
    if (!checkFilter || runCheck('bill_balanceAmount'))
      console.log(`Bill balanceAmount checked: ${billBalanceChecked} (OK: ${billBalanceOk})`);
    if (!checkFilter || runCheck('bill_status')) console.log(`Bill status checked: ${billStatusChecked} (OK: ${billStatusOk})`);
    if (!checkFilter || runCheck('non_advance_sum'))
      console.log(`Non-advance sum applied checked: ${nonAdvanceChecked} (OK: ${nonAdvanceOk})`);
    console.log(`Total errors: ${errors.length}`);

    if (errors.length > 0) {
      console.log('\nError details:');
      console.table(
        errors.map(e => ({
          _id: e.billDocId || e.paymentId || '-',
          company: e.companyName || e.companyId || '-',
          check: e.check,
          billId: e.billId || (['advance_unused', 'non_advance_sum'].includes(e.check) ? 'n/a' : '-'),
          paymentMadeId: e.paymentMadeId || '-',
          message: e.message,
        })),
      );
      if (fix) {
        const doAdvanceFix = !fixCheck || fixCheck === 'advance_unused';
        const doBillFix = !fixCheck || fixCheck !== 'advance_unused';

        if (doAdvanceFix) {
          const advanceErrors = errors.filter(e => e.check === 'advance_unused');
          if (advanceErrors.length > 0) {
            console.log('\n--fix [advance_unused]: correcting payment unusedAmount...');
            let advanceFixed = 0;
            for (const e of advanceErrors) {
              if (!e.paymentId || e.expectedUnused == null) continue;
              const result = await booksDb
                .collection('paymentmades')
                .updateOne({ _id: new mongoose.Types.ObjectId(e.paymentId) }, { $set: { unusedAmount: e.expectedUnused } });
              if (result.modifiedCount > 0) {
                advanceFixed++;
                console.log(`Fixed payment ${e.paymentMadeId} (_id: ${e.paymentId}): unusedAmount=${e.expectedUnused}`);
              }
            }
            console.log(`Fixed ${advanceFixed} advance payment(s).`);
          }
        }

        if (doBillFix) {
          const billFixChecks =
            fixCheck && fixCheck !== 'advance_unused' ? [fixCheck] : ['bill_paidAmount', 'bill_balanceAmount', 'bill_status'];
          const fixableErrors = errors.filter(e => billFixChecks.includes(e.check));
          const billIdsToFix = [...new Set(fixableErrors.map(e => e.billDocId).filter(Boolean))];
          if (billIdsToFix.length > 0) {
            console.log('\n--fix [bill]: correcting paidAmount, balanceAmount, status...');
            const byBill = new Map();
            for (const bill of bills) {
              const idStr = bill._id.toString();
              const total = roundMoney(bill.total);
              const expectedPaid = roundMoney(expectedPaidByBill.get(idStr) || 0);
              const expectedBalance = roundMoney(total - expectedPaid);
              const statusVal =
                bill.status === BILL_STATUSES.DRAFT ? BILL_STATUSES.DRAFT : expectedBillStatus(expectedPaid, total);
              byBill.set(idStr, { expectedPaid, expectedBalance, expectedStatus: statusVal });
            }
            let fixed = 0;
            for (const docId of billIdsToFix) {
              const vals = byBill.get(docId);
              if (!vals) continue;
              const bill = bills.find(b => b._id.toString() === docId);
              const statusToSet = bill?.status === BILL_STATUSES.DRAFT ? BILL_STATUSES.DRAFT : vals.expectedStatus;
              const result = await booksDb.collection('bills').updateOne(
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
                const billNo = bill?.billId || docId;
                console.log(
                  `Fixed bill ${billNo} (_id: ${docId}): paidAmount=${vals.expectedPaid}, balanceAmount=${vals.expectedBalance}, status=${statusToSet}`,
                );
              }
            }
            console.log(`Fixed ${fixed} bill document(s).`);
          }
        }

        const hasUnfixable = errors.some(e => !FIXABLE_CHECKS.includes(e.check));
        process.exitCode = hasUnfixable ? 1 : 0;
      } else {
        console.log('\nRe-run with --fix to correct. Use --fix-check=advance_unused or --fix-check=bill_status (etc.).');
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
