/**
 * Verify stored document totals in MongoDB against the CURRENT core calculation logic.
 *
 * Why:
 * - Totals are now produced by the shared core logic (FE `calculateAmounts` in
 *   services.js, mirrored by the BE `checkDocTotal` validator).
 * - This script recomputes each document with that logic and flags any stored
 *   value that no longer matches (typically older docs saved by the previous formula).
 *
 * Core logic recap (what "expected" mirrors):
 * - ITEM discount: GST is computed on the discounted line amount.
 * - TRANSACTION discount: `subTotal` is stored PRE-discount; the discount is applied
 *   once at the total level, and GST is recomputed per line on the taxable amount
 *   (a fixed amount discount is distributed proportionally across line amounts).
 * - Additional charges: amount always counts; tax counts only when the charge is taxable.
 *
 * Usage:
 *   node migrations/verifyDocumentTotalsLegacyFe.js
 *   node migrations/verifyDocumentTotalsLegacyFe.js --companyId=<companyId>
 *   node migrations/verifyDocumentTotalsLegacyFe.js --collection=invoices --verbose
 *   node migrations/verifyDocumentTotalsLegacyFe.js --epsilon=0.01 --limit=1000
 *
 * Fields checked (only what is persisted on the document):
 * - All docs: subTotal, totalTax, total, roundOffAmount, isRoundOff
 * - Expense docs additionally check `amount` (which mirrors `total`).
 *   Expense modules now go through the same baseTransformer/core logic as base docs.
 * - totalTaxablevalue is NOT checked — it is a PDF/display-only value, not stored in models.
 *
 * Output:
 * - Each mismatched document is printed ONCE with all of its mismatched fields.
 * - `mismatchDocs` counts unique documents (never double-counted per field).
 *
 * Notes:
 * - Read-only (no DB writes). Exits with code 2 when mismatches are found.
 * - Split docs without splitTax on lines (old data): skips totalTax check.
 * - importBill / importGrpo / importPurchaseOrder: total = subTotal + chargesTotal (no tax in total).
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

const DEFAULT_EPSILON = 0.01;
const DEFAULT_BATCH_SIZE = 500;

/** Base docs: subTotal, totalTax, total. Expense docs: amount only at root. */
const TARGETS = [
  { db: 'booksCrm', name: 'quotes', kind: 'base' },
  { db: 'booksCrm', name: 'salesorders', kind: 'base' },
  { db: 'books', name: 'deliverychallans', kind: 'base' },
  { db: 'books', name: 'invoices', kind: 'base' },
  { db: 'books', name: 'recurringinvoices', kind: 'base' },
  { db: 'books', name: 'creditnotes', kind: 'base' },
  { db: 'books', name: 'purchaseorders', kind: 'base' },
  { db: 'books', name: 'grpoorders', kind: 'base' },
  { db: 'books', name: 'bills', kind: 'base' },
  { db: 'books', name: 'recurringbills', kind: 'base' },
  { db: 'books', name: 'debitnotes', kind: 'base' },
  { db: 'books', name: 'expenses', kind: 'expense' },
  { db: 'books', name: 'recurringexpenses', kind: 'expense' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    companyId: null,
    collection: null,
    verbose: false,
    epsilon: DEFAULT_EPSILON,
    limit: null,
  };

  for (const arg of args) {
    if (arg.startsWith('--companyId=')) out.companyId = arg.split('=')[1].trim();
    else if (arg.startsWith('--collection=')) out.collection = arg.split('=')[1].trim();
    else if (arg.startsWith('--epsilon=')) out.epsilon = Number(arg.split('=')[1].trim());
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.split('=')[1].trim());
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
  }

  if (!Number.isFinite(out.epsilon) || out.epsilon < 0) {
    out.epsilon = DEFAULT_EPSILON;
  }

  if (out.limit != null && (!Number.isFinite(out.limit) || out.limit <= 0)) {
    out.limit = null;
  }

  return out;
}

function toNumber(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function getGstNumericRate(gst) {
  if (gst == null || gst === '') return 0;
  const s = String(gst).trim().toLowerCase();
  if (s === 'none' || s === 'exempted') return 0;
  const n = Number.parseFloat(gst);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

/** True when any line has splitTax — new split-tax feature. Old split docs have none. */
function hasSplitItemTax(data) {
  return (data?.items || []).some(item => toNumber(item?.splitTax, 0) > 0);
}

/**
 * Recompute totals using the CURRENT core logic (FE `calculateAmounts` / BE `checkDocTotal`)
 * for base docs (invoice, quote, bill, etc.).
 *
 * Single pass builds each line's discounted amount and GST; the transaction-discount
 * branch then recomputes GST proportionally and applies the discount once at total level.
 */
function computeExpectedBaseTotals(data) {
  const isItemDiscount = data?.appliesTo === 'ITEM';
  const isTxnDiscount = data?.appliesTo === 'TRANSACTION';

  const txnDiscountType = data?.discountConfig?.discountType;
  const txnDiscountValue = toNumber(data?.discountConfig?.discountValue, 0);

  // Per-line amount (after any item-level discount) and per-line GST, rounded as the FE stores them.
  const lines = (data?.items || []).map(item => {
    const quantity = toNumber(item?.quantity, 0);
    const rate = toNumber(item?.rate, 0);
    const gstRate = getGstNumericRate(item?.gst);

    let amount = quantity * rate;

    const itemDiscountValue = toNumber(item?.discountConfig?.discountValue, 0);
    if (isItemDiscount && itemDiscountValue > 0) {
      if (item?.discountConfig?.discountType === 'AMOUNT') {
        amount -= itemDiscountValue;
      } else {
        amount -= (amount * itemDiscountValue) / 100;
      }
    }

    const lineAmount = amount ? round2(amount) : 0;
    const lineTax = round2((gstRate / 100) * lineAmount);

    return { gstRate, amount: lineAmount, taxAmount: lineTax };
  });

  // subTotal is stored PRE transaction-discount.
  let subTotal = lines.reduce((acc, line) => acc + line.amount, 0);
  let totalTax = lines.reduce((acc, line) => acc + line.taxAmount, 0);

  let transactionDiscountAmount = 0;

  if (isTxnDiscount && txnDiscountValue > 0) {
    if (txnDiscountType === 'AMOUNT') {
      transactionDiscountAmount = txnDiscountValue;
    } else {
      transactionDiscountAmount = (subTotal * txnDiscountValue) / 100;
    }

    // Recompute GST on each line's post-discount taxable amount.
    const totalItemAmount = lines.reduce((acc, line) => acc + line.amount, 0);
    let recalculatedTax = 0;

    lines.forEach(line => {
      let taxableAmount = line.amount;

      if (txnDiscountType === 'AMOUNT') {
        // Fixed invoice discount distributed proportionally across line amounts.
        const proportionalDiscount = totalItemAmount > 0 ? (line.amount / totalItemAmount) * txnDiscountValue : 0;
        taxableAmount = line.amount - proportionalDiscount;
      } else {
        taxableAmount = line.amount - (line.amount * txnDiscountValue) / 100;
      }

      recalculatedTax += (line.gstRate / 100) * taxableAmount;
    });

    totalTax = recalculatedTax;
  }

  let chargesTax = 0;
  let chargesTotal = 0;

  (data?.additionalCharges || []).forEach(item => {
    if (item?.isTaxable && item?.amount) {
      chargesTax += (toNumber(item?.amount, 0) * toNumber(item?.taxRate, 0)) / 100;
    }
    chargesTotal += toNumber(item?.amount, 0);
  });

  totalTax += chargesTax;

  // Grand total = (subTotal - transaction discount) + GST + additional charges.
  let total = subTotal - transactionDiscountAmount + totalTax + chargesTotal;

  // Split docs: total uses splitTax per line. Old entries have no splitTax → tax portion is 0.
  if (data?.isSplit) {
    const splitTotalTax = hasSplitItemTax(data)
      ? (data?.items || []).reduce((acc, item) => {
          const quantity = toNumber(item?.quantity, 1);
          const rate = toNumber(item?.rate, 0);
          const gst = toNumber(item?.splitTax, 0);
          const amount = quantity * rate;
          return acc + (gst / 100) * amount;
        }, 0)
      : 0;

    total = subTotal + splitTotalTax + chargesTotal;
  }

  if (data?.importBill || data?.importGrpo || data?.importPurchaseOrder) {
    total = subTotal + chargesTotal;
  }

  const preciseTotal = round2(total);
  let roundOffAmount = 0;
  let finalTotal = preciseTotal;

  if (data?.isRoundOff) {
    const rounded = Math.round(preciseTotal);
    roundOffAmount = round2(rounded - preciseTotal);
    finalTotal = rounded;
  }

  return {
    subTotal: round2(subTotal),
    totalTax: round2(totalTax),
    total: finalTotal,
    roundOffAmount,
    isRoundOff: Boolean(data?.isRoundOff),
  };
}

/** Values read directly from the MongoDB document (persisted fields only). */
function readDbBaseTotals(doc) {
  return {
    subTotal: toNumber(doc?.subTotal, 0),
    totalTax: toNumber(doc?.totalTax, 0),
    total: toNumber(doc?.total, 0),
    roundOffAmount: toNumber(doc?.roundOffAmount, 0),
    isRoundOff: Boolean(doc?.isRoundOff),
  };
}

/**
 * Fields to verify for a document.
 *
 * - Expense docs persist the same base totals as other docs, plus `amount` (= total).
 * - Old split docs (no splitTax on lines) skip totalTax; it was not part of stored split totals.
 */
function getFieldsToVerify(doc, isExpense) {
  const fields = ['subTotal', 'totalTax', 'total', 'roundOffAmount'];
  if (isExpense) {
    fields.push('amount');
  }
  if (doc?.isSplit && !hasSplitItemTax(doc)) {
    return fields.filter(field => field !== 'totalTax');
  }
  return fields;
}

function createEmptyFieldCounts() {
  return {
    subTotal: 0,
    totalTax: 0,
    total: 0,
    amount: 0,
    roundOffAmount: 0,
    isRoundOff: 0,
  };
}

function withinEpsilon(a, b, epsilon) {
  return Math.abs(round2(a) - round2(b)) <= epsilon;
}

function getObjectIdOrRaw(value) {
  if (!value) return value;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
}

function documentDisplayId(doc) {
  return (
    doc?.invoiceId ||
    doc?.billId ||
    doc?.debitNoteId ||
    doc?.expenseId ||
    doc?.recurringExpenseId ||
    doc?.recurringInvoiceId ||
    doc?.recurringBillId ||
    doc?.purchaseOrderId ||
    doc?.grpoOrderId ||
    doc?.orderId ||
    doc?.quoteId ||
    doc?.creditNoteId ||
    doc?._id?.toString()
  );
}

async function verifyCollection(booksDb, collectionName, collectionKind, options) {
  const { companyId, epsilon, verbose, limit } = options;
  const coll = booksDb.collection(collectionName);

  const match = { items: { $exists: true, $type: 'array' } };
  if (companyId) {
    match.companyId = getObjectIdOrRaw(companyId);
  }

  const projection = {
    _id: 1,
    companyId: 1,
    status: 1,
    items: 1,
    appliesTo: 1,
    discountConfig: 1,
    additionalCharges: 1,
    isSplit: 1,
    importBill: 1,
    importGrpo: 1,
    importPurchaseOrder: 1,
    isRoundOff: 1,
    roundOffAmount: 1,
    subTotal: 1,
    totalTax: 1,
    total: 1,
    amount: 1,
    invoiceId: 1,
    billId: 1,
    debitNoteId: 1,
    expenseId: 1,
    recurringExpenseId: 1,
    recurringInvoiceId: 1,
    recurringBillId: 1,
    purchaseOrderId: 1,
    grpoOrderId: 1,
    orderId: 1,
    quoteId: 1,
    creditNoteId: 1,
  };

  const cursor = coll.find(match).project(projection).batchSize(DEFAULT_BATCH_SIZE);
  if (limit) cursor.limit(limit);

  const summary = {
    collection: collectionName,
    scanned: 0,
    mismatchDocs: 0,
    mismatchFields: 0,
    fieldMismatchCounts: createEmptyFieldCounts(),
  };

  for await (const doc of cursor) {
    summary.scanned += 1;

    // Expense docs now persist the same totals as base docs (they go through baseTransformer),
    // so both kinds use the same core calculation. Expense docs additionally store `amount` (= total).
    const isExpense = collectionKind === 'expense';
    const expected = computeExpectedBaseTotals(doc);
    const inDb = readDbBaseTotals(doc);

    if (isExpense) {
      expected.amount = expected.total;
      inDb.amount = toNumber(doc?.amount, 0);
    }

    const fields = getFieldsToVerify(doc, isExpense);

    // Collect every mismatched field for this document so it is reported exactly once.
    const mismatchedFields = [];

    for (const field of fields) {
      if (!withinEpsilon(expected[field], inDb[field], epsilon)) {
        summary.fieldMismatchCounts[field] += 1;
        mismatchedFields.push(
          `${field}: db=${round2(inDb[field])} expected=${round2(expected[field])} (Δ${round2(
            Math.abs(expected[field] - inDb[field]),
          )})`,
        );
      }
    }

    if (Boolean(expected.isRoundOff) !== Boolean(inDb.isRoundOff)) {
      summary.fieldMismatchCounts.isRoundOff += 1;
      mismatchedFields.push(`isRoundOff: db=${Boolean(inDb.isRoundOff)} expected=${Boolean(expected.isRoundOff)}`);
    }

    if (mismatchedFields.length > 0) {
      summary.mismatchDocs += 1;
      summary.mismatchFields += mismatchedFields.length;

      const id = documentDisplayId(doc);
      console.log(`[MISMATCH] ${collectionName} id=${id} _id=${doc?._id?.toString()} status=${doc?.status || 'N/A'}`);
      for (const detail of mismatchedFields) {
        console.log(`    - ${detail}`);
      }
      if (verbose) {
        console.log(
          `    context => items=${(doc?.items || []).length}, appliesTo=${doc?.appliesTo || 'NONE'}, isSplit=${Boolean(
            doc?.isSplit,
          )}, discountConfig=${JSON.stringify(doc?.discountConfig || null)}`,
        );
      }
    }
  }

  return summary;
}

async function run() {
  const options = parseArgs();
  const targets = options.collection ? TARGETS.filter(t => t.name === options.collection) : TARGETS;
  let client;

  try {
    const conn = await getConnection();
    client = conn.client;

    console.log('--- Verify DB totals vs current core calculation logic ---');
    console.log(`Targets: ${targets.map(t => `${t.db}.${t.name}`).join(', ')}`);
    console.log(`Company filter: ${options.companyId || 'ALL'}`);
    console.log(`Epsilon: ${options.epsilon}`);
    if (options.limit) console.log(`Per-collection limit: ${options.limit}`);
    console.log('');

    const all = [];
    for (const target of targets) {
      const db = conn[target.db];
      if (!db) {
        // console.log(`[skip] no db handle for "${target.db}" (collection ${target.name})`);
        continue;
      }
      const result = await verifyCollection(db, target.name, target.kind, options);
      result.label = `${target.db}.${target.name}`;
      all.push(result);
      console.log(
        `${result.label}: scanned=${result.scanned}, mismatchDocs=${result.mismatchDocs}, mismatchFields=${result.mismatchFields}`,
      );
      if (result.mismatchFields > 0) {
        console.log(
          `  fieldBreakdown => subTotal=${result.fieldMismatchCounts.subTotal}, totalTax=${result.fieldMismatchCounts.totalTax}, total=${result.fieldMismatchCounts.total}, amount=${result.fieldMismatchCounts.amount}, roundOffAmount=${result.fieldMismatchCounts.roundOffAmount}, isRoundOff=${result.fieldMismatchCounts.isRoundOff}`,
        );
      }
    }

    const totals = all.reduce(
      (acc, item) => {
        acc.scanned += item.scanned;
        acc.mismatchDocs += item.mismatchDocs;
        acc.mismatchFields += item.mismatchFields;
        for (const field of Object.keys(acc.fieldMismatchCounts)) {
          acc.fieldMismatchCounts[field] += item.fieldMismatchCounts[field] || 0;
        }
        return acc;
      },
      {
        scanned: 0,
        mismatchDocs: 0,
        mismatchFields: 0,
        fieldMismatchCounts: createEmptyFieldCounts(),
      },
    );

    console.log('\n--- Summary ---');
    console.log(`Total scanned docs: ${totals.scanned}`);
    console.log(`Total mismatch docs (unique): ${totals.mismatchDocs}`);
    console.log(`Total mismatch fields: ${totals.mismatchFields}`);
    if (totals.mismatchFields > 0) {
      console.log(
        `Field mismatch totals => subTotal=${totals.fieldMismatchCounts.subTotal}, totalTax=${totals.fieldMismatchCounts.totalTax}, total=${totals.fieldMismatchCounts.total}, amount=${totals.fieldMismatchCounts.amount}, roundOffAmount=${totals.fieldMismatchCounts.roundOffAmount}, isRoundOff=${totals.fieldMismatchCounts.isRoundOff}`,
      );
    }

    if (totals.mismatchDocs > 0) {
      process.exitCode = 2;
    }
  } finally {
    if (client) {
      await client.close();
    }
  }
}

run().catch(error => {
  console.error('Verification failed:', error);
  process.exit(1);
});
