/**
 * Recompute and correct subTotal, totalTax, total, roundOffAmount, sgst, cgst and igst
 * on old sales/purchase documents using the SAME formula as the `checkDocTotal` validator
 * (middlewares/checkDocTotal.js) — the formula every new document is validated against.
 * Older documents saved under a previous formula (or edited outside validation) can carry
 * stale totals; this migration recomputes them from the stored items/discountConfig/
 * additionalCharges and rewrites whichever fields no longer match.
 *
 * This migration corrects only these structural defects and nothing else:
 *   1. Tax split / mode — a document carrying BOTH sgst/cgst AND igst (the double-tax bug), a
 *      split missing while totalTax > 0, or a single side stored on the WRONG side of the
 *      intra/inter divide. The correct mode is derived from the company/party GSTIN+state the
 *      same way checkDocTotal does (GSTIN prefix first, then state) — so a same-state pair such
 *      as Gujarat→Gujarat becomes SGST+CGST even if it was saved as IGST. The mode is only
 *      flipped when it is actually determinable (both GSTINs, or both states, present); when it
 *      is not, the stored mode is preserved. Each corrected row is tagged [MODE ...] (modeFixed).
 *   2. Tax-inclusive subTotal — subTotal was saved with the tax folded in
 *      (subTotal === correctSubTotal + totalTax), which then cascades into total. Each such
 *      row is tagged [SUBTOTAL+TAX] and counted (subtotalIncludedTax).
 *
 * It deliberately does NOT rewrite documents that merely differ from the current checkDocTotal
 * formula by sub-rupee rounding. Older docs were saved by the legacy FE `calculateAmounts`,
 * which rounds each line's FULL gst (round2(taxable*gst/100)); checkDocTotal instead rounds the
 * CGST half then doubles (round2(round2(taxable*gst/2/100)*2)). For intra-state docs these
 * differ by up to ₹0.01 per line, so a blind recompute would flag every legacy document. Those
 * are treated as already-correct and left untouched.
 *
 * Safety:
 * - Report-only unless --apply is passed. Always run a report first.
 * - Scope: every document carrying any tax (totalTax/sgst/cgst/igst > 0). 0% GST docs are
 *   never fetched — they have nothing to recompute.
 * - A document is left untouched (unchanged) when its tax split reconciles with totalTax on the
 *   single side it carries AND its stored subTotal already equals the tax-free subtotal
 *   recomputed from the items — this is what spares legacy-rounding docs from being rewritten.
 * - A stored subTotal that disagrees with the items for any reason OTHER than tax-inclusion is
 *   logged as [SUBTOTAL-MISMATCH review] (counted subtotalMismatchReview) but never written —
 *   the items, not the subTotal, may be the stale side, so a human decides.
 * - A document with sgst>0 AND cgst>0 AND igst>0 all at once is always corrected — a document
 *   can't legitimately be both intra- and inter-state at the same time.
 * - isSplit documents (split invoices/challans) are skipped entirely; their totals follow
 *   a different, split-specific formula not covered here.
 * - Documents that are PAID/PARTIALLY_PAID or have paidAmount > 0 are still corrected (per
 *   the guard above) but are logged with a [PAID] tag since a changed total can desync from
 *   amounts already recorded against it — review those lines before trusting --apply.
 *
 * Run: node migrations/fixDocumentTotals.js                        (report, all companies)
 *      node migrations/fixDocumentTotals.js <companyId>             (report, one company)
 *      node migrations/fixDocumentTotals.js <companyId> --apply     (write)
 *      node migrations/fixDocumentTotals.js --collection=invoices   (report, one collection)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

const TARGETS = [
  { db: 'books', collection: 'invoices', party: 'customerId' },
  { db: 'books', collection: 'creditnotes', party: 'customerId' },
  { db: 'books', collection: 'deliverychallans', party: 'customerId' },
  { db: 'booksCrm', collection: 'quotes', party: 'customerId' },
  { db: 'booksCrm', collection: 'salesorders', party: 'customerId' },
  { db: 'books', collection: 'bills', party: 'vendorId' },
  { db: 'books', collection: 'debitnotes', party: 'vendorId' },
  { db: 'books', collection: 'purchaseorders', party: 'vendorId' },
  { db: 'books', collection: 'grpoorders', party: 'vendorId' },
];

const toNumber = (value, fallback = 0) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

const round2 = value => Math.round(toNumber(value, 0) * 100) / 100;

const getGstNumericRate = gst => {
  if (gst == null || gst === '') return 0;
  const normalized = String(gst).trim().toLowerCase();
  return normalized === 'none' || normalized === 'exempted' ? 0 : toNumber(gst, 0);
};

const normalizeStateForTaxComparison = state => {
  if (!state || typeof state !== 'string') return '';
  return state
    .trim()
    .replace(/^\[[A-Z]{2,5}\]\s*-\s*/i, '')
    .trim()
    .toLowerCase();
};

const isIGSTExists = ({ myState = '', customerState = '', myGSTNo = '', customerGSTNo = '' }) => {
  if (myGSTNo && customerGSTNo) {
    return myGSTNo.substring(0, 2) !== customerGSTNo.substring(0, 2);
  }
  const normalizedMyState = normalizeStateForTaxComparison(myState);
  const normalizedCustomerState = normalizeStateForTaxComparison(customerState);
  if (!normalizedMyState || !normalizedCustomerState) return false;
  return normalizedMyState !== normalizedCustomerState;
};

const applyRoundOff = (rawTotal, isRoundOff) => {
  const preciseTotal = round2(rawTotal);
  if (!isRoundOff) return { total: preciseTotal, roundOffAmount: 0 };
  const rounded = Math.round(preciseTotal);
  return { total: rounded, roundOffAmount: round2(rounded - preciseTotal) };
};

const resolveShippingAddress = (document, party) => {
  if (document.addressId) {
    const addressId = document.addressId.toString();
    if (addressId === party?.address?.shipping?._id?.toString()) {
      return party.address.shipping;
    }
    const additional = (party?.address?.additionalShippingAddresses || []).find(addr => addr._id?.toString() === addressId);
    if (additional) return additional;
  }
  return party?.address?.shipping || null;
};

/** Recompute totals the way the LEGACY FE `calculateAmounts` did (see
 * verifyDocumentTotalsLegacyFe.js) — it rounds each line's FULL gst, whereas checkDocTotal
 * rounds the CGST half then doubles. A document whose stored money totals match EITHER formula
 * was saved correctly and must not be rewritten for sub-rupee rounding drift. State-independent:
 * the total tax is the same intra or inter, so no company/customer lookup is needed. */
const computeLegacyExpected = document => {
  const isItemDiscount = document?.appliesTo === 'ITEM';
  const isTxnDiscount = document?.appliesTo === 'TRANSACTION';
  const txnDiscountType = document?.discountConfig?.discountType;
  const txnDiscountValue = toNumber(document?.discountConfig?.discountValue, 0);

  const lines = (Array.isArray(document?.items) ? document.items : []).map(item => {
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

  const subTotal = lines.reduce((acc, line) => acc + line.amount, 0);
  let totalTax = lines.reduce((acc, line) => acc + line.taxAmount, 0);
  let transactionDiscountAmount = 0;

  if (isTxnDiscount && txnDiscountValue > 0) {
    transactionDiscountAmount = txnDiscountType === 'AMOUNT' ? txnDiscountValue : (subTotal * txnDiscountValue) / 100;
    const totalItemAmount = lines.reduce((acc, line) => acc + line.amount, 0);
    let recalculatedTax = 0;
    lines.forEach(line => {
      const taxableAmount =
        txnDiscountType === 'AMOUNT'
          ? line.amount - (totalItemAmount > 0 ? (line.amount / totalItemAmount) * txnDiscountValue : 0)
          : line.amount - (line.amount * txnDiscountValue) / 100;
      recalculatedTax += (line.gstRate / 100) * taxableAmount;
    });
    totalTax = recalculatedTax;
  }

  let chargesTax = 0;
  let chargesTotal = 0;
  (Array.isArray(document?.additionalCharges) ? document.additionalCharges : []).forEach(charge => {
    if (charge?.isTaxable && charge?.amount) {
      chargesTax += (toNumber(charge?.amount, 0) * toNumber(charge?.taxRate, 0)) / 100;
    }
    chargesTotal += toNumber(charge?.amount, 0);
  });

  totalTax += chargesTax;

  const isImportDoc = Boolean(document?.importBill || document?.importGrpo || document?.importPurchaseOrder);
  const rawTotal = isImportDoc ? subTotal + chargesTotal : subTotal - transactionDiscountAmount + totalTax + chargesTotal;
  const { total, roundOffAmount } = applyRoundOff(rawTotal, document?.isRoundOff);

  return { subTotal: round2(subTotal), totalTax: round2(totalTax), total, roundOffAmount };
};

/** Mirrors middlewares/checkDocTotal.js exactly (plus the import-doc total exception
 * already established in verifyDocumentTotalsLegacyFe.js, for docs that never go through
 * that validator).
 *
 * `knownIsIGST` (true/false) preserves the tax MODE the document already carries — a
 * customer's address/GSTIN can be edited long after a document was created, so recomputing
 * intra-vs-inter-state from CURRENT company/customer data would silently flip old, correctly
 * split documents. Only fall back to the address-based determination (`knownIsIGST === null`)
 * when the document itself carries no unambiguous signal: no tax at all, or the "both SGST/CGST
 * AND IGST populated" double-tax bug (see fixDocumentTaxSplit.js), where current company/customer
 * data is the only way to pick which side is correct. */
const computeExpected = (document, company, party, knownIsIGST) => {
  const items = Array.isArray(document.items) ? document.items : [];
  const additionalCharges = Array.isArray(document.additionalCharges) ? document.additionalCharges : [];
  const shippingAddress = resolveShippingAddress(document, party);

  const isIGST =
    knownIsIGST !== null
      ? knownIsIGST
      : isIGSTExists({
          myState: company?.address?.state,
          customerState: shippingAddress?.state,
          myGSTNo: company?.gstNumber,
          customerGSTNo: party?.otherDetails?.gstinUin || party?.otherDetails?.registeredBusinessValue,
        });

  const isItemDiscount = document.appliesTo === 'ITEM';
  const isTxnDiscount = document.appliesTo === 'TRANSACTION';

  const prepared = items.map(item => {
    const qty = toNumber(item?.quantity, 0);
    const rate = toNumber(item?.rate, 0);
    const gst = getGstNumericRate(item?.gst);
    const lineAmount = round2(qty * rate);

    let discountAmount = 0;
    let taxableAmount = lineAmount;

    if (isItemDiscount) {
      const { discountType, discountValue } = item?.discountConfig || {};
      if (discountType === 'PERCENTAGE') {
        discountAmount = (lineAmount * toNumber(discountValue, 0)) / 100;
      } else if (discountType === 'AMOUNT') {
        discountAmount = toNumber(discountValue, 0);
      }
      taxableAmount = round2(Math.max(0, lineAmount - discountAmount));
    }

    let gstAmount = 0;
    if (!isIGST) {
      const cgstAmount = round2((taxableAmount * (gst / 2)) / 100);
      gstAmount = round2(cgstAmount * 2);
    } else {
      gstAmount = round2((taxableAmount * gst) / 100);
    }

    return { gst, lineAmount, taxableAmount, gstAmount };
  });

  let subTotal = prepared.reduce((sum, item) => sum + item.taxableAmount, 0);
  const validatedSubTotal = round2(
    isItemDiscount
      ? prepared.reduce((sum, item) => sum + item.taxableAmount, 0)
      : prepared.reduce((sum, item) => sum + item.lineAmount, 0),
  );

  let totalGstAmount = prepared.reduce((sum, item) => sum + item.gstAmount, 0);

  if (isTxnDiscount) {
    const { discountType, discountValue } = document.discountConfig || {};
    const originalSubTotal = prepared.reduce((sum, item) => sum + item.lineAmount, 0);
    subTotal = 0;
    totalGstAmount = 0;
    let allocatedDiscount = 0;

    prepared.forEach((item, index) => {
      let discountedLineAmount = item.lineAmount;

      if (discountType === 'PERCENTAGE') {
        const itemDiscount = round2((item.lineAmount * toNumber(discountValue, 0)) / 100);
        discountedLineAmount = Math.max(0, item.lineAmount - itemDiscount);
      } else if (discountType === 'AMOUNT' && originalSubTotal > 0) {
        let itemDiscount;
        if (index === prepared.length - 1) {
          itemDiscount = round2(toNumber(discountValue, 0) - allocatedDiscount);
        } else {
          itemDiscount = round2((item.lineAmount / originalSubTotal) * toNumber(discountValue, 0));
          allocatedDiscount += itemDiscount;
        }
        discountedLineAmount = Math.max(0, item.lineAmount - itemDiscount);
      }

      let gstAmount = 0;
      if (!isIGST) {
        const cgstAmount = round2((discountedLineAmount * (item.gst / 2)) / 100);
        gstAmount = round2(cgstAmount * 2);
      } else {
        gstAmount = round2((discountedLineAmount * item.gst) / 100);
      }

      totalGstAmount += gstAmount;
      subTotal += discountedLineAmount;
    });
  }

  let additionalChargesTotal = 0;
  let additionalChargesTaxTotal = 0;
  additionalCharges.forEach(charge => {
    const amount = toNumber(charge?.amount, 0);
    additionalChargesTotal += amount;
    if (charge?.isTaxable && amount > 0) {
      additionalChargesTaxTotal += (amount * toNumber(charge?.taxRate, 0)) / 100;
    }
  });

  totalGstAmount = round2(totalGstAmount + additionalChargesTaxTotal);

  // Import docs are created outside the checkDocTotal-validated routes; total excludes tax.
  const isImportDoc = Boolean(document.importBill || document.importGrpo || document.importPurchaseOrder);
  const rawTotal = isImportDoc ? subTotal + additionalChargesTotal : subTotal + totalGstAmount + additionalChargesTotal;

  const { total, roundOffAmount } = applyRoundOff(rawTotal, document.isRoundOff);

  let sgst = 0;
  let cgst = 0;
  let igst = 0;
  if (!isIGST) {
    cgst = round2(totalGstAmount / 2);
    sgst = cgst;
  } else {
    igst = totalGstAmount;
  }

  return { subTotal: validatedSubTotal, totalTax: totalGstAmount, total, roundOffAmount, sgst, cgst, igst };
};

const documentDisplayId = document =>
  document.invoiceId ||
  document.billId ||
  document.debitNoteId ||
  document.purchaseOrderId ||
  document.grpoOrderId ||
  document.orderId ||
  document.quoteId ||
  document.creditNoteId ||
  document.challanId ||
  document._id.toString();

const migrate = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const collectionFilter = args.find(arg => arg.startsWith('--collection='))?.split('=')[1];
    const targetCompanyId = args.find(arg => !arg.startsWith('--'))
      ? new ObjectId(args.find(arg => !arg.startsWith('--')))
      : null;

    if (targetCompanyId && isCompanyExcluded(targetCompanyId)) {
      console.log(`Company ${targetCompanyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
      return;
    }

    const companyScope = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludedObjectIds.length
        ? { companyId: { $nin: excludedObjectIds } }
        : {};

    const db = await getConnection();
    client = db.client;
    console.log(`Connected to MongoDB — ${apply ? 'APPLYING CHANGES' : 'report only (pass --apply to write)'}`);
    if (!targetCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}`);
    }

    const companies = new Map();
    const parties = new Map();

    const targets = collectionFilter ? TARGETS.filter(t => t.collection === collectionFilter) : TARGETS;

    const grand = {
      scanned: 0,
      fixed: 0,
      skippedSplit: 0,
      skippedInconsistent: 0,
      unchanged: 0,
      subtotalTaxInclusive: 0,
      subtotalMismatchReview: 0,
      modeFixed: 0,
    };
    const perCollection = [];

    for (const target of targets) {
      const collection = db[target.db].collection(target.collection);
      const documents = await collection
        .find({
          ...companyScope,
          $or: [{ totalTax: { $gt: 0 } }, { igst: { $gt: 0 } }, { sgst: { $gt: 0 } }, { cgst: { $gt: 0 } }],
        })
        .project({
          _id: 1,
          companyId: 1,
          items: 1,
          appliesTo: 1,
          discountConfig: 1,
          additionalCharges: 1,
          addressId: 1,
          isSplit: 1,
          isRoundOff: 1,
          subTotal: 1,
          totalTax: 1,
          total: 1,
          roundOffAmount: 1,
          sgst: 1,
          cgst: 1,
          igst: 1,
          status: 1,
          paidAmount: 1,
          importBill: 1,
          importGrpo: 1,
          importPurchaseOrder: 1,
          [target.party]: 1,
          invoiceId: 1,
          billId: 1,
          debitNoteId: 1,
          purchaseOrderId: 1,
          grpoOrderId: 1,
          orderId: 1,
          quoteId: 1,
          creditNoteId: 1,
          challanId: 1,
        })
        .toArray();

      let fixed = 0;
      let skippedSplit = 0;
      let skippedInconsistent = 0;
      let unchanged = 0;
      let subtotalTaxInclusive = 0;
      let subtotalMismatchReview = 0;
      let modeFixed = 0;

      for (const document of documents) {
        grand.scanned += 1;

        if (document.isSplit) {
          skippedSplit += 1;
          continue;
        }

        // The $or above can match docs without a real items array (e.g. via the
        // sgst/cgst/igst>0 branch alone) — never recompute against an empty item list,
        // that would zero out real totals instead of fixing them.
        if (!Array.isArray(document.items) || document.items.length === 0) {
          console.log(
            `  [${target.db}.${target.collection}] ${documentDisplayId(document)} — skipped: no items array to recompute from`,
          );
          skippedInconsistent += 1;
          continue;
        }

        const taxTotal = round2(document.totalTax);
        const intraPresent = toNumber(document.sgst) > 0 || toNumber(document.cgst) > 0;
        const interPresent = toNumber(document.igst) > 0;
        const storedSubTotal = round2(document.subTotal);
        const storedTotal = round2(document.total);

        const companyId = document.companyId?.toString();
        if (!companies.has(companyId)) {
          companies.set(companyId, await db.common.collection('companies').findOne({ _id: document.companyId }));
        }
        const company = companies.get(companyId);

        const partyId = document[target.party]?.toString();
        if (partyId && !parties.has(partyId)) {
          parties.set(partyId, await db.booksCrm.collection('customers').findOne({ _id: document[target.party] }));
        }
        const party = partyId ? parties.get(partyId) : null;

        // Tax mode is derived from the actual company/party GSTIN+state, exactly like
        // checkDocTotal — GSTIN prefix first, then state. A same-state pair (e.g. both Gujarat)
        // is intra-state (SGST+CGST) even when the doc was wrongly saved as IGST. We only trust
        // this — and therefore only flip the mode — when it is actually determinable (both
        // GSTINs, or both states, present); otherwise the stored mode is preserved so a missing
        // party record can't silently turn a genuine inter-state doc intra.
        const shippingAddress = resolveShippingAddress(document, party);
        const companyGstin = company?.gstNumber;
        const partyGstin = party?.otherDetails?.gstinUin || party?.otherDetails?.registeredBusinessValue;
        const companyState = company?.address?.state;
        const partyState = shippingAddress?.state;
        const modeDeterminable = Boolean(companyGstin && partyGstin) || Boolean(companyState && partyState);
        const addressIsIGST = isIGSTExists({
          myState: companyState,
          customerState: partyState,
          myGSTNo: companyGstin,
          customerGSTNo: partyGstin,
        });

        const storedMode = interPresent && !intraPresent ? true : intraPresent && !interPresent ? false : null;
        const knownIsIGST = modeDeterminable ? addressIsIGST : storedMode;

        const expected = computeExpected(document, company, party, knownIsIGST);
        const legacy = computeLegacyExpected(document);

        // Money totals are valid if they match EITHER the current (checkDocTotal) formula or the
        // legacy FE formula — this is what spares legacy sub-rupee rounding docs from a rewrite.
        const subTotalMatches = storedSubTotal === expected.subTotal || storedSubTotal === legacy.subTotal;
        const taxMatches = taxTotal === expected.totalTax || taxTotal === legacy.totalTax;
        const totalMatches = storedTotal === expected.total || storedTotal === legacy.total;
        const moneyValid = subTotalMatches && taxMatches && totalMatches;

        const subTotalWasTaxInclusive =
          expected.totalTax > 0 &&
          storedSubTotal !== expected.subTotal &&
          storedSubTotal === round2(expected.subTotal + expected.totalTax);

        // The tax split is wrong when both sides are present (double-tax), when totalTax>0 but no
        // side is stored (split missing), or when a determinable single side sits opposite the
        // address-derived mode (the Gujarat→Gujarat IGST case).
        const splitWrong =
          (intraPresent && interPresent) ||
          (taxTotal > 0 && !intraPresent && !interPresent) ||
          (modeDeterminable && storedMode !== null && storedMode !== addressIsIGST);

        if (moneyValid && !splitWrong) {
          unchanged += 1;
          continue;
        }

        // A subtotal that disagrees with the items under BOTH formulas, with no tax-inclusion and
        // no split fault, is ambiguous — the items may be the stale side. Surface, do not write.
        if (!subTotalMatches && !subTotalWasTaxInclusive && !splitWrong) {
          console.log(
            `  [${target.db}.${target.collection}] company=${document.companyId} [SUBTOTAL-MISMATCH review] ${documentDisplayId(document)} — subTotal db=${storedSubTotal} vs items=${expected.subTotal}, totalTax db=${taxTotal} vs ${expected.totalTax}`,
          );
          subtotalMismatchReview += 1;
          continue;
        }

        const fields = ['subTotal', 'totalTax', 'total', 'roundOffAmount', 'sgst', 'cgst', 'igst'];
        const diffs = fields.filter(field => round2(document[field]) !== expected[field]);

        if (diffs.length === 0) {
          unchanged += 1;
          continue;
        }

        if (subTotalWasTaxInclusive) subtotalTaxInclusive += 1;
        if (splitWrong) modeFixed += 1;

        const paidTag =
          document.status === 'PAID' || document.status === 'PARTIALLY_PAID' || toNumber(document.paidAmount) > 0
            ? '[PAID] '
            : '';
        const subTotalTag = subTotalWasTaxInclusive ? '[SUBTOTAL+TAX] ' : '';
        const modeTag = splitWrong ? `[MODE ${addressIsIGST ? 'IGST' : 'CGST+SGST'}] ` : '';
        const diffText = diffs.map(field => `${field}: db=${round2(document[field])} -> ${expected[field]}`).join(', ');
        console.log(
          `  [${target.db}.${target.collection}] company=${document.companyId} ${paidTag}${subTotalTag}${modeTag}${documentDisplayId(document)} — ${diffText}`,
        );

        if (apply) {
          await collection.updateOne({ _id: document._id }, { $set: expected });
        }
        fixed += 1;
      }

      console.log(
        `${target.collection}: ${documents.length} scanned — ${fixed} ${apply ? 'fixed' : 'to fix'} (${subtotalTaxInclusive} tax-inclusive subtotal, ${modeFixed} tax-mode), ${subtotalMismatchReview} subtotal-mismatch (review), ${unchanged} already correct, ${skippedSplit} skipped (isSplit), ${skippedInconsistent} skipped (no items)`,
      );

      perCollection.push({
        label: `${target.db}.${target.collection}`,
        scanned: documents.length,
        fixed,
        unchanged,
        skippedSplit,
        skippedInconsistent,
        subtotalTaxInclusive,
        subtotalMismatchReview,
        modeFixed,
      });

      grand.fixed += fixed;
      grand.unchanged += unchanged;
      grand.skippedSplit += skippedSplit;
      grand.skippedInconsistent += skippedInconsistent;
      grand.subtotalTaxInclusive += subtotalTaxInclusive;
      grand.subtotalMismatchReview += subtotalMismatchReview;
      grand.modeFixed += modeFixed;
    }

    console.log('\n--- Summary by collection ---');
    for (const row of perCollection) {
      console.log(
        `  ${row.label}: ${row.scanned} scanned, ${row.fixed} ${apply ? 'fixed' : 'to fix'} (${row.subtotalTaxInclusive} tax-inclusive subtotal, ${row.modeFixed} tax-mode), ${row.subtotalMismatchReview} subtotal-mismatch (review), ${row.unchanged} already correct, ${row.skippedSplit} skipped (isSplit), ${row.skippedInconsistent} skipped (no items)`,
      );
    }

    console.log('\n--- Total across all collections ---');
    console.log(
      `scanned=${grand.scanned}, ${apply ? 'fixed' : 'to fix'}=${grand.fixed}, subtotalIncludedTax=${grand.subtotalTaxInclusive}, taxModeFixed=${grand.modeFixed}, subtotalMismatchReview=${grand.subtotalMismatchReview}, unchanged=${grand.unchanged}, skipped(isSplit)=${grand.skippedSplit}, skipped(noItems)=${grand.skippedInconsistent}`,
    );
    console.log(apply ? 'Totals repair completed successfully!' : 'Report complete — no changes were written.');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
