/**
 * Verify Bank Balance — checks that each bank's stored availableBalance
 * matches the value recomputed from all transactions.
 *
 * Formula:
 *   expectedBalance
 *     = openingBalance
 *     + Σ PaymentReceived.amountReceived        (status=APPROVED, bankId)
 *     - Σ PaymentReceived refunds.amountRefunded (refund.bankId)
 *     - Σ PaymentMade.paymentMade               (status=APPROVED, bankId)
 *     + Σ PaymentMade refunds.amountRefunded     (refund.bankId)
 *     - Σ Expense.amount                        (no status filter, bankId)
 *     + Σ BankTransferLog DEPOSIT  (APPROVED, toBankId)   → +toAmount||amount
 *     - Σ BankTransferLog WITHDRAWAL (APPROVED, fromBankId) → -fromAmount||amount
 *     + Σ BankTransferLog TRANSFER (APPROVED, toBankId)   → +toAmount||amount
 *     - Σ BankTransferLog TRANSFER (APPROVED, fromBankId) → -fromAmount||amount
 *     + Σ DebitNote refunds.refundAmount         (refund.bankId, all statuses)
 *     - Σ CreditNote refunds.refundAmount        (refund.bankId)
 *
 * Usage:
 *   node scripts/verify-bank-balance.js [--companyId=xxx] [--verbose] [--fix]
 *
 * Flags:
 *   --companyId=<id>   Scope to one company
 *   --verbose          Print OK lines too
 *   --fix              Update availableBalance to the recomputed value (USE CAREFULLY)
 *
 * Requires: NODE_ENV and .env with ABSS_CLUSTER and db names.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

// ─── constants ────────────────────────────────────────────────────────────────
const APPROVED = 'APPROVED';
const DEPOSIT = 'DEPOSIT';
const WITHDRAWAL = 'WITHDRAWAL';
const PAID = 'PAID';
const TRANSFER = 'TRANSFER';
const TOLERANCE = 0.01; // floating-point tolerance

// ─── helpers ──────────────────────────────────────────────────────────────────
const round = n => Math.round((n || 0) * 100) / 100;

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  let verbose = false;
  let fix = false;
  for (const a of args) {
    if (a.startsWith('--companyId=')) companyId = a.split('=')[1].trim();
    else if (a === '--verbose') verbose = true;
    else if (a === '--fix') fix = true;
  }
  return { companyId, verbose, fix };
}

function toOid(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

/**
 * Aggregate sum of a numeric field grouped by a bankId field.
 * Returns Map<bankIdStr, number>.
 */
async function sumByBank(collection, matchExtra, bankField, sumField) {
  const pipeline = [
    { $match: matchExtra },
    { $group: { _id: `$${bankField}`, total: { $sum: { $ifNull: [`$${sumField}`, 0] } } } },
  ];
  const rows = await collection.aggregate(pipeline).toArray();
  const map = new Map();
  for (const r of rows) {
    if (r._id) map.set(r._id.toString(), round(r.total));
  }
  return map;
}

/**
 * Aggregate refunds embedded in documents.
 * Unwinds the refunds array, groups by refund.bankId.
 * Returns Map<bankIdStr, number>.
 */
async function sumRefundsByBank(collection, matchExtra, refundsField, amountField) {
  const pipeline = [
    { $match: matchExtra },
    { $unwind: `$${refundsField}` },
    {
      $group: {
        _id: `$${refundsField}.bankId`,
        total: { $sum: { $ifNull: [`$${refundsField}.${amountField}`, 0] } },
      },
    },
  ];
  const rows = await collection.aggregate(pipeline).toArray();
  const map = new Map();
  for (const r of rows) {
    if (r._id) map.set(r._id.toString(), round(r.total));
  }
  return map;
}

/**
 * BankTransferLog: aggregate amounts for APPROVED transfers.
 * For a given role ('from' | 'to') and optional type filter.
 * Uses fromAmount||amount for 'from' role, toAmount||amount for 'to' role.
 * Returns Map<bankIdStr, number>.
 */
async function sumTransfersByBank(collection, matchExtra, role, typeFilter) {
  const bankField = role === 'from' ? 'fromBankId' : 'toBankId';
  const amountExpr = role === 'from' ? { $ifNull: ['$fromAmount', '$amount'] } : { $ifNull: ['$toAmount', '$amount'] };

  const match = { ...matchExtra, transactionStatus: APPROVED };
  if (typeFilter) match.transactionType = typeFilter;

  const pipeline = [{ $match: match }, { $group: { _id: `$${bankField}`, total: { $sum: amountExpr } } }];
  const rows = await collection.aggregate(pipeline).toArray();
  const map = new Map();
  for (const r of rows) {
    if (r._id) map.set(r._id.toString(), round(r.total));
  }
  return map;
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function run() {
  const { companyId, verbose, fix } = parseArgs();

  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const booksCrmDb = db.booksCrm;
    const booksDb = db.books;
    const commonDb = db.common;

    // ── company filter ────────────────────────────────────────────────────────
    const companyMatch = {};
    if (companyId) companyMatch.companyId = toOid(companyId);

    let companyName = null;
    if (companyId) {
      const cDoc = await commonDb.collection('companies').findOne({ _id: toOid(companyId) }, { projection: { name: 1 } });
      companyName = cDoc?.name || companyId;
      console.log(`\nCompany: ${companyName} (${companyId})\n`);
    } else {
      console.log('\nScanning ALL companies...\n');
    }

    // ── load all banks ────────────────────────────────────────────────────────
    const banks = await booksCrmDb
      .collection('banks')
      .find(companyMatch)
      .project({ _id: 1, accountName: 1, accountType: 1, openingBalance: 1, availableBalance: 1, companyId: 1 })
      .toArray();

    if (banks.length === 0) {
      console.log('No banks found.');
      return;
    }
    console.log(`Loaded ${banks.length} bank account(s).\n`);

    // build companyId → name map for display
    const companyMap = new Map();
    if (companyName) {
      companyMap.set(companyId, companyName);
    } else {
      const cids = [...new Set(banks.map(b => b.companyId?.toString()).filter(Boolean))];
      if (cids.length > 0) {
        const companies = await commonDb
          .collection('companies')
          .find({ _id: { $in: cids.map(toOid) } })
          .project({ _id: 1, name: 1 })
          .toArray();
        for (const c of companies) companyMap.set(c._id.toString(), c.name || c._id.toString());
      }
    }

    // ── aggregate all transaction sources ─────────────────────────────────────
    console.log('Aggregating transactions...');

    // 1. PaymentReceived (APPROVED) — booksCrm
    const prColl = booksCrmDb.collection('paymentreceiveds');
    const prCredits = await sumByBank(prColl, { ...companyMatch, status: APPROVED }, 'bankId', 'amountReceived');

    // 2. PaymentReceived refunds (bankId inside refunds[]) — booksCrm
    const prRefundDebits = await sumRefundsByBank(prColl, companyMatch, 'refunds', 'amountRefunded');

    // 3. PaymentMade (APPROVED) — books
    const pmColl = booksDb.collection('paymentmades');
    const pmDebits = await sumByBank(pmColl, { ...companyMatch, status: APPROVED }, 'bankId', 'paymentMade');

    // 4. PaymentMade refunds (bankId inside refunds[]) — books
    const pmRefundCredits = await sumRefundsByBank(pmColl, companyMatch, 'refunds', 'amountRefunded');

    // 5. Expense — books
    // The Expense model has no status field; every expense immediately debits the bank
    // at creation. Deleted expenses now restore the bank balance (fixed in expense.service.js),
    // so no status filter is needed here.
    const expColl = booksDb.collection('expenses');
    const expDebits = await sumByBank(expColl, companyMatch, 'bankId', 'amount');

    // 6. BankTransferLog — booksCrm
    const btlColl = booksCrmDb.collection('banktransferlogs');
    // DEPOSIT: credit the toBankId
    const btlDepositCredits = await sumTransfersByBank(btlColl, companyMatch, 'to', DEPOSIT);
    // WITHDRAWAL: debit the fromBankId
    const btlWithdrawDebits = await sumTransfersByBank(btlColl, companyMatch, 'from', WITHDRAWAL);
    // TRANSFER: debit fromBankId, credit toBankId
    const btlTransferDebits = await sumTransfersByBank(btlColl, companyMatch, 'from', TRANSFER);
    const btlTransferCredits = await sumTransfersByBank(btlColl, companyMatch, 'to', TRANSFER);

    // 7. DebitNote refunds — books
    // Note: cancelling a debit note does NOT reverse embedded refunds; the bank
    // credits from those refunds are permanent, so no parent-status filter here.
    const dnColl = booksDb.collection('debitnotes');
    const dnRefundCredits = await sumRefundsByBank(dnColl, companyMatch, 'refunds', 'refundAmount');

    // 8. CreditNote refunds — books (debits bank on refund)
    const cnColl = booksDb.collection('creditnotes');
    const cnRefundDebits = await sumRefundsByBank(cnColl, companyMatch, 'refunds', 'refundAmount');

    console.log('Aggregation complete.\n');

    // ── compare ───────────────────────────────────────────────────────────────
    const errors = [];
    let okCount = 0;

    for (const bank of banks) {
      const bid = bank._id.toString();
      const opening = round(bank.openingBalance || 0);
      const stored = round(bank.availableBalance || 0);

      const credits = {
        opening,
        paymentReceived: prCredits.get(bid) || 0,
        paymentMadeRefunds: pmRefundCredits.get(bid) || 0,
        btlDeposit: btlDepositCredits.get(bid) || 0,
        btlTransferIn: btlTransferCredits.get(bid) || 0,
        debitNoteRefunds: dnRefundCredits.get(bid) || 0,
      };

      const debits = {
        paymentMade: pmDebits.get(bid) || 0,
        paymentReceivedRef: prRefundDebits.get(bid) || 0,
        expense: expDebits.get(bid) || 0,
        btlWithdrawal: btlWithdrawDebits.get(bid) || 0,
        btlTransferOut: btlTransferDebits.get(bid) || 0,
        creditNoteRefunds: cnRefundDebits.get(bid) || 0,
      };

      const totalCredits = Object.values(credits).reduce((a, b) => a + b, 0);
      const totalDebits = Object.values(debits).reduce((a, b) => a + b, 0);
      const expected = round(totalCredits - totalDebits);
      const diff = round(stored - expected);

      const cid = bank.companyId?.toString();
      const cName = companyMap.get(cid) || cid || '-';

      if (Math.abs(diff) > TOLERANCE) {
        errors.push({ bank, cName, stored, expected, diff, credits, debits });
        console.log(
          `❌  MISMATCH  [${cName}] "${bank.accountName}" (${bank.accountType})` +
            `\n    stored=${stored}  expected=${expected}  diff=${diff > 0 ? '+' : ''}${diff}` +
            `\n    Credits breakdown:` +
            `\n      openingBalance       : ${credits.opening}` +
            `\n      paymentReceived      : +${credits.paymentReceived}` +
            `\n      paymentMadeRefunds   : +${credits.paymentMadeRefunds}` +
            `\n      btlDeposit           : +${credits.btlDeposit}` +
            `\n      btlTransferIn        : +${credits.btlTransferIn}` +
            `\n      debitNoteRefunds     : +${credits.debitNoteRefunds}` +
            `\n    Debits breakdown:` +
            `\n      paymentMade          : -${debits.paymentMade}` +
            `\n      paymentReceivedRef   : -${debits.paymentReceivedRef}` +
            `\n      expense              : -${debits.expense}` +
            `\n      btlWithdrawal        : -${debits.btlWithdrawal}` +
            `\n      btlTransferOut       : -${debits.btlTransferOut}` +
            `\n      creditNoteRefunds    : -${debits.creditNoteRefunds}`,
        );
      } else {
        okCount++;
        if (verbose) {
          console.log(`✅  OK       [${cName}] "${bank.accountName}"  balance=${stored}`);
        }
      }
    }

    // ── summary ───────────────────────────────────────────────────────────────
    console.log('\n─────────────────────────────────────────');
    console.log(`Total banks  : ${banks.length}`);
    console.log(`✅ Correct   : ${okCount}`);
    console.log(`❌ Mismatches: ${errors.length}`);

    // ── fix ───────────────────────────────────────────────────────────────────
    if (fix && errors.length > 0) {
      console.log('\n⚠️  --fix flag detected. Updating mismatched availableBalance values...\n');
      let fixed = 0;
      for (const { bank, cName, expected, stored } of errors) {
        try {
          await booksCrmDb.collection('banks').updateOne({ _id: bank._id }, { $set: { availableBalance: expected } });
          console.log(`  Fixed [${cName}] "${bank.accountName}": ${stored} → ${expected}`);
          fixed++;
        } catch (err) {
          console.error(`  ERROR fixing bank ${bank._id}: ${err.message}`);
        }
      }
      console.log(`\n✅ Fixed ${fixed} / ${errors.length} banks.`);
    } else if (errors.length > 0) {
      console.log('\nRun with --fix to auto-correct the mismatched balances.');
    }

    if (errors.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
  }
}

run();
