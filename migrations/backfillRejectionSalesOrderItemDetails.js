/**
 * Migration: Backfill missing item details (itemName/itemNo/hsnCode/gst) and recompute
 * totals on Sales Orders converted from a Rejection Order (PC2PC flow).
 *
 * Root cause: RejectionOrderDetail.jsx's PC2PC prefill only copied
 * { itemId, quantity, rate, itemUnit } per line, so itemName/itemNo/hsnCode were left
 * blank and gst stayed at the schema default ('0.0') instead of the item's real rate —
 * which also left subTotal/totalTax/sgst/cgst/igst/total wrong on those orders.
 *
 * Scope: only SalesOrder docs with rejectionOrderDetails.rejectionOrderRef set.
 *   - itemName/itemNo/hsnCode are always backfilled when missing (cosmetic, no financial impact).
 *   - gst + totals are only recomputed when the order is NOT already INVOICED/PARTIALLY_INVOICED
 *     or PAID — those are reported as NEEDS_MANUAL_REVIEW instead of being silently changed,
 *     since their total has already been used to generate an Invoice / recorded payments.
 *
 * Usage:
 *   node migrations/2026-08-13-backfillRejectionSalesOrderItemDetails.js up            # dry run, no writes
 *   node migrations/2026-08-13-backfillRejectionSalesOrderItemDetails.js up --apply    # writes
 *   node migrations/2026-08-13-backfillRejectionSalesOrderItemDetails.js down          # no-op (see below)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const SKIP_INVOICE_STATUSES = ['INVOICED', 'PARTIALLY_INVOICED'];
const SKIP_PAYMENT_STATUSES = ['PAID'];

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const getGstNumericRate = gst => {
  if (gst == null || gst === '') return 0;
  const normalized = String(gst).trim().toLowerCase();
  return normalized === 'none' || normalized === 'exempted' ? 0 : Number.parseFloat(gst) || 0;
};

const normalizeStateForTaxComparison = state => {
  if (!state || typeof state !== 'string') return '';
  return state
    .trim()
    .replace(/^\[[A-Z]{2,5}\]\s*-\s*/i, '')
    .trim()
    .toLowerCase();
};

// Mirrors middlewares/checkDocTotal.js's isIGSTExists so recomputed totals match what the app would validate.
const isIGSTExists = ({ myState = '', customerState = '', myGSTNo = '', customerGSTNo = '' }) => {
  if (myGSTNo && customerGSTNo) {
    return myGSTNo.substring(0, 2) !== customerGSTNo.substring(0, 2);
  }
  if (myState && customerState) {
    return normalizeStateForTaxComparison(myState) !== normalizeStateForTaxComparison(customerState);
  }
  return false;
};

// Mirrors middlewares/checkDocTotal.js's shipping-address resolution.
const resolveShippingAddress = (order, customer) => {
  if (order.addressId) {
    if (String(order.addressId) === String(customer?.address?.shipping?._id)) {
      return customer.address.shipping;
    }
    const additional = (customer?.address?.additionalShippingAddresses || []).find(
      addr => String(addr._id) === String(order.addressId),
    );
    if (additional) return additional;
  }
  return customer?.address?.shipping || null;
};

const applyRoundOff = (rawTotal, isRoundOff) => {
  const precise = round2(rawTotal);
  if (!isRoundOff) return { total: precise, roundOffAmount: 0 };
  const rounded = Math.round(precise);
  return { total: rounded, roundOffAmount: round2(rounded - precise) };
};

// Mirrors middlewares/checkDocTotal.js's totals formula (item-discount / transaction-discount /
// additional-charges handling) so a recomputed order stays consistent with what the app itself
// would compute and validate for the same input.
const recomputeOrderTotals = (order, company, customer) => {
  const isIGST = isIGSTExists({
    myState: company?.address?.state,
    customerState: resolveShippingAddress(order, customer)?.state,
    myGSTNo: company?.gstNumber,
    customerGSTNo: customer?.otherDetails?.gstinUin || customer?.otherDetails?.registeredBusinessValue,
  });

  const isItemDiscount = order.appliesTo === 'ITEM';
  const isTxnDiscount = order.appliesTo === 'TRANSACTION';

  const prepared = order.items.map(item => {
    const qty = Number(item.quantity) || 0;
    const rate = Number(item.rate) || 0;
    const gst = getGstNumericRate(item.gst);
    const lineAmount = round2(qty * rate);

    let discountAmount = 0;
    let taxableAmount = lineAmount;
    if (isItemDiscount) {
      const { discountType, discountValue } = item.discountConfig || {};
      if (discountType === 'PERCENTAGE') discountAmount = (lineAmount * (Number(discountValue) || 0)) / 100;
      else if (discountType === 'AMOUNT') discountAmount = Number(discountValue) || 0;
      taxableAmount = round2(Math.max(0, lineAmount - discountAmount));
    }

    let gstAmount = 0;
    if (!isIGST) {
      const cgstAmount = round2((taxableAmount * (gst / 2)) / 100);
      gstAmount = round2(cgstAmount * 2);
    } else {
      gstAmount = round2((taxableAmount * gst) / 100);
    }

    return { ...item, gst: String(gst), lineAmount, taxableAmount, amount: taxableAmount, taxAmount: gstAmount };
  });

  let subTotal;
  let totalGstAmount;

  if (isTxnDiscount) {
    const { discountType, discountValue } = order.discountConfig || {};
    const originalSubTotal = prepared.reduce((sum, i) => sum + i.lineAmount, 0);
    subTotal = 0;
    totalGstAmount = 0;
    let allocatedDiscount = 0;

    prepared.forEach((item, index) => {
      let discountedLineAmount = item.lineAmount;
      if (discountType === 'PERCENTAGE') {
        const itemDiscount = round2((item.lineAmount * (Number(discountValue) || 0)) / 100);
        discountedLineAmount = Math.max(0, item.lineAmount - itemDiscount);
      } else if (discountType === 'AMOUNT' && originalSubTotal > 0) {
        let itemDiscount;
        if (index === prepared.length - 1) {
          itemDiscount = round2((Number(discountValue) || 0) - allocatedDiscount);
        } else {
          itemDiscount = round2((item.lineAmount / originalSubTotal) * (Number(discountValue) || 0));
          allocatedDiscount += itemDiscount;
        }
        discountedLineAmount = Math.max(0, item.lineAmount - itemDiscount);
      }

      const gstNum = getGstNumericRate(item.gst);
      let gstAmount;
      if (!isIGST) {
        const cgstAmount = round2((discountedLineAmount * (gstNum / 2)) / 100);
        gstAmount = round2(cgstAmount * 2);
      } else {
        gstAmount = round2((discountedLineAmount * gstNum) / 100);
      }

      item.amount = discountedLineAmount;
      item.taxAmount = gstAmount;
      subTotal += discountedLineAmount;
      totalGstAmount += gstAmount;
    });
  } else {
    subTotal = round2(prepared.reduce((sum, i) => sum + (isItemDiscount ? i.taxableAmount : i.lineAmount), 0));
    totalGstAmount = round2(prepared.reduce((sum, i) => sum + i.taxAmount, 0));
  }

  const additionalCharges = order.additionalCharges || [];
  const additionalChargesTotal = additionalCharges.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  const additionalChargesTaxTotal = additionalCharges.reduce(
    (sum, c) => sum + (c.isTaxable && Number(c.amount) > 0 ? (Number(c.amount) * (Number(c.taxRate) || 0)) / 100 : 0),
    0,
  );
  totalGstAmount = round2(totalGstAmount + additionalChargesTaxTotal);

  const rawTotal = subTotal + totalGstAmount + additionalChargesTotal;
  const { total, roundOffAmount } = applyRoundOff(rawTotal, order.isRoundOff !== false);

  const cgst = isIGST ? 0 : round2(totalGstAmount / 2);
  const sgst = cgst;
  const igst = isIGST ? totalGstAmount : 0;

  return {
    items: prepared.map(({ lineAmount, taxableAmount, ...rest }) => rest),
    subTotal,
    totalTax: totalGstAmount,
    sgst,
    cgst,
    igst,
    total,
    roundOffAmount,
  };
};

const isMissing = value => value === undefined || value === null || value === '';

async function up() {
  const apply = process.argv.includes('--apply');
  const { client, booksCrm, common } = await getConnection();

  try {
    const salesOrders = booksCrm.collection('salesorders');
    const itemsCol = booksCrm.collection('items');
    const customersCol = booksCrm.collection('customers');
    const companiesCol = common.collection('companies');

    const orders = await salesOrders.find({ 'rejectionOrderDetails.rejectionOrderRef': { $exists: true, $ne: null } }).toArray();

    console.log('--- Backfill Rejection-Converted Sales Order Item Details ---');
    console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no writes — pass --apply to write)'}`);
    console.log(`Rejection-converted sales orders found: ${orders.length}`);

    if (orders.length === 0) {
      console.log('\nNothing to do.');
      return;
    }

    const itemIds = [...new Set(orders.flatMap(o => (o.items || []).map(i => i.itemId?.toString()).filter(Boolean)))];
    const itemDocs = await itemsCol
      .find({ _id: { $in: itemIds.map(id => new ObjectId(id)) } })
      .project({ itemName: 1, itemNo: 1, hsnCode: 1, gst: 1 })
      .toArray();
    const itemById = new Map(itemDocs.map(i => [i._id.toString(), i]));

    const customerIds = [...new Set(orders.map(o => o.customerId?.toString()).filter(Boolean))];
    const customerDocs = await customersCol.find({ _id: { $in: customerIds.map(id => new ObjectId(id)) } }).toArray();
    const customerById = new Map(customerDocs.map(c => [c._id.toString(), c]));

    const companyIds = [...new Set(orders.map(o => o.companyId?.toString()).filter(Boolean))];
    const companyDocs = await companiesCol.find({ _id: { $in: companyIds.map(id => new ObjectId(id)) } }).toArray();
    const companyById = new Map(companyDocs.map(c => [c._id.toString(), c]));

    const bulkOps = [];
    const needsManualReview = [];
    let itemDetailsFixedCount = 0;
    let totalsFixedCount = 0;
    let skippedNoChange = 0;

    const fmt = v => (v === undefined ? 'undefined' : v === null ? 'null' : v === '' ? '""' : v);

    for (const order of orders) {
      let itemsChanged = false;
      const fieldDiffs = [];

      const patchedItems = (order.items || []).map((item, index) => {
        if (!item.itemId) return item;
        const master = itemById.get(item.itemId.toString());
        if (!master) return item;

        const needsDetailFix = isMissing(item.itemName) || isMissing(item.itemNo) || isMissing(item.hsnCode);
        if (!needsDetailFix) return item;

        itemsChanged = true;
        const patched = {
          ...item,
          itemName: isMissing(item.itemName) ? master.itemName : item.itemName,
          itemNo: isMissing(item.itemNo) ? master.itemNo : item.itemNo,
          hsnCode: isMissing(item.hsnCode) ? master.hsnCode : item.hsnCode,
        };

        ['itemName', 'itemNo', 'hsnCode'].forEach(field => {
          if (item[field] !== patched[field]) {
            fieldDiffs.push({ path: `items[${index}].${field}`, oldValue: item[field], newValue: patched[field] });
          }
        });

        return patched;
      });

      if (!itemsChanged) {
        skippedNoChange += 1;
        continue;
      }

      const isInvoiced = SKIP_INVOICE_STATUSES.includes(order.invoiceStatus);
      const isPaid = SKIP_PAYMENT_STATUSES.includes(order.paymentStatus);

      console.log(`\n${apply ? 'UPDATING' : '[DRY RUN] WOULD UPDATE'} ${order.orderId} (${order._id})`);
      fieldDiffs.forEach(d => console.log(`  ${d.path}: ${fmt(d.oldValue)} -> ${fmt(d.newValue)}`));

      if (isInvoiced || isPaid) {
        // Safe cosmetic backfill only — leave gst/totals untouched since they've already
        // been used to generate an Invoice / recorded payments.
        console.log(`  (invoiceStatus=${order.invoiceStatus}, paymentStatus=${order.paymentStatus} — gst/totals left untouched)`);
        bulkOps.push({
          updateOne: {
            filter: { _id: order._id },
            update: { $set: { items: patchedItems } },
          },
        });
        itemDetailsFixedCount += 1;
        needsManualReview.push({
          orderId: order.orderId,
          _id: order._id,
          invoiceStatus: order.invoiceStatus,
          paymentStatus: order.paymentStatus,
        });
        continue;
      }

      const orderForRecompute = {
        ...order,
        items: patchedItems.map(i => ({ ...i, gst: itemById.get(i.itemId?.toString())?.gst ?? i.gst })),
      };
      const company = companyById.get(order.companyId?.toString());
      const customer = customerById.get(order.customerId?.toString());
      const recomputed = recomputeOrderTotals(orderForRecompute, company, customer);

      recomputed.items.forEach((patchedItem, index) => {
        const originalItem = order.items[index];
        if (originalItem.gst !== patchedItem.gst) {
          console.log(`  items[${index}].gst: ${fmt(originalItem.gst)} -> ${fmt(patchedItem.gst)}`);
        }
        if (originalItem.amount !== patchedItem.amount) {
          console.log(`  items[${index}].amount: ${fmt(originalItem.amount)} -> ${fmt(patchedItem.amount)}`);
        }
        if (originalItem.taxAmount !== patchedItem.taxAmount) {
          console.log(`  items[${index}].taxAmount: ${fmt(originalItem.taxAmount)} -> ${fmt(patchedItem.taxAmount)}`);
        }
      });

      ['subTotal', 'totalTax', 'sgst', 'cgst', 'igst', 'total', 'roundOffAmount'].forEach(field => {
        if (order[field] !== recomputed[field]) {
          console.log(`  ${field}: ${fmt(order[field])} -> ${fmt(recomputed[field])}`);
        }
      });

      bulkOps.push({
        updateOne: {
          filter: { _id: order._id },
          update: {
            $set: {
              items: recomputed.items,
              subTotal: recomputed.subTotal,
              totalTax: recomputed.totalTax,
              sgst: recomputed.sgst,
              cgst: recomputed.cgst,
              igst: recomputed.igst,
              total: recomputed.total,
              roundOffAmount: recomputed.roundOffAmount,
            },
          },
        },
      });
      itemDetailsFixedCount += 1;
      totalsFixedCount += 1;
    }

    console.log(`\nOrders with nothing to fix         : ${skippedNoChange}`);
    console.log(`Orders with item details backfilled: ${itemDetailsFixedCount}`);
    console.log(`  of which totals also recomputed   : ${totalsFixedCount}`);
    console.log(`  of which flagged for manual review: ${needsManualReview.length} (already invoiced/paid)`);

    if (needsManualReview.length) {
      console.log('\nNEEDS_MANUAL_REVIEW (item details fixed, gst/totals left untouched):');
      needsManualReview.forEach(r =>
        console.log(`  - ${r.orderId} (${r._id}): invoiceStatus=${r.invoiceStatus}, paymentStatus=${r.paymentStatus}`),
      );
    }

    if (bulkOps.length === 0) {
      console.log('\nNothing to update.');
      return;
    }

    if (!apply) {
      console.log(`\nDRY RUN: ${bulkOps.length} order(s) would be updated. Re-run with --apply to write.`);
      return;
    }

    const result = await salesOrders.bulkWrite(bulkOps);
    console.log(`\nUpdated ${result.modifiedCount} sales order(s).`);
  } catch (err) {
    console.error('❌ Migration up failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

async function down() {
  console.log(
    'This migration backfills previously-missing item details and recomputes totals derived from them. ' +
      'The prior (incomplete) state was a data-quality defect, not a deliberate value, so there is nothing meaningful to revert to — ' +
      'reverting would mean re-blanking itemName/itemNo/hsnCode and restoring the incorrect totals. No-op.',
  );
}

module.exports = { up, down };

if (require.main === module) {
  const direction = process.argv[2];
  if (!['up', 'down'].includes(direction)) {
    console.error('Usage: node migrations/2026-08-13-backfillRejectionSalesOrderItemDetails.js [up|down] [--apply]');
    process.exit(1);
  }
  module.exports[direction]()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
