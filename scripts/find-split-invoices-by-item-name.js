/**
 * Find normal + split invoices for an item (Top Items of Sales invoice columns).
 *
 * Usage:
 *   node scripts/find-split-invoices-by-item-name.js "Test Item 20"
 *   node scripts/find-split-invoices-by-item-name.js "Test Item 20" --include-cancelled
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

require('dotenv').config();
const { getConnection, closeConnection } = require('../config/db');

const SPLIT_BY_QTY = 'Split By Qty';
const SPLIT_BY_PRICE = 'Split By Price';

const sumItemLines = lines => ({
  qty: lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0),
  amount: lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0),
});

const toReportSplitFields = (splitWiseType, qty, amount) => {
  const isByQty = splitWiseType === SPLIT_BY_QTY;
  const isByPrice = splitWiseType === SPLIT_BY_PRICE;

  return {
    invoiceSplitByQtyQty: isByQty ? qty : 0,
    invoiceSplitByQtyValue: isByQty ? amount : 0,
    invoiceSplitByPriceQty: isByPrice ? qty : 0,
    invoiceSplitByPriceValue: isByPrice ? amount : 0,
  };
};

const mapInvoiceRows = (invoices, itemIds, { isSplit }) =>
  invoices.map(inv => {
    const lines = inv.items.filter(it => itemIds.some(id => id.equals(it.itemId)));
    const { qty, amount } = sumItemLines(lines);
    const splitFields = isSplit ? toReportSplitFields(inv.splitWiseType, qty, amount) : {};

    return {
      invoiceId: inv.invoiceId,
      invoiceDate: inv.invoiceDate ? new Date(inv.invoiceDate).toISOString().slice(0, 10) : '',
      splitWiseType: inv.splitWiseType || '',
      status: inv.status,
      isSplit: !!inv.isSplit,
      invoiceTotal: inv.total,
      invoiceQty: isSplit ? 0 : qty,
      invoiceValue: isSplit ? 0 : amount,
      itemQty: qty,
      itemAmount: amount,
      ...splitFields,
      _id: inv._id.toString(),
    };
  });

const itemNameArg = process.argv[2];
const includeCancelled = process.argv.includes('--include-cancelled');

if (!itemNameArg) {
  console.error('Usage: node scripts/find-split-invoices-by-item-name.js "<item name>" [--include-cancelled]');
  process.exit(1);
}

(async () => {
  const { booksCrm, books, client } = await getConnection();

  try {
    const items = await booksCrm
      .collection('items')
      .find({ itemName: { $regex: new RegExp(`^${itemNameArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } })
      .project({ _id: 1, itemName: 1, itemNo: 1, companyId: 1 })
      .toArray();

    if (!items.length) {
      const partial = await booksCrm
        .collection('items')
        .find({ itemName: { $regex: itemNameArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })
        .project({ _id: 1, itemName: 1, itemNo: 1, companyId: 1 })
        .limit(20)
        .toArray();

      console.log(`No exact match for "${itemNameArg}".`);
      if (partial.length) {
        console.log('\n[Table 1] Similar items:');
        console.table(partial.map(i => ({ id: i._id.toString(), itemNo: i.itemNo, itemName: i.itemName })));
      }
      return;
    }

    const itemIds = items.map(i => i._id);

    const baseFilter = {
      'items.itemId': { $in: itemIds },
    };

    if (!includeCancelled) {
      baseFilter.status = { $ne: 'CANCELLED' };
    }

    const invoiceProjection = {
      invoiceId: 1,
      invoiceDate: 1,
      status: 1,
      splitWiseType: 1,
      isSplit: 1,
      total: 1,
      companyId: 1,
      items: 1,
    };

    const [normalInvoices, splitInvoices] = await Promise.all([
      books
        .collection('invoices')
        .find({ ...baseFilter, isSplit: false })
        .project(invoiceProjection)
        .sort({ invoiceDate: -1 })
        .toArray(),
      books
        .collection('invoices')
        .find({ ...baseFilter, isSplit: true })
        .project(invoiceProjection)
        .sort({ invoiceDate: -1 })
        .toArray(),
    ]);

    const normalRows = mapInvoiceRows(normalInvoices, itemIds, { isSplit: false });
    const splitRows = mapInvoiceRows(splitInvoices, itemIds, { isSplit: true });

    const normalTotals = normalRows.reduce(
      (acc, row) => ({
        invoiceTotal: acc.invoiceTotal + (parseFloat(row.invoiceTotal) || 0),
        invoiceQty: acc.invoiceQty + row.invoiceQty,
        invoiceValue: acc.invoiceValue + row.invoiceValue,
      }),
      { invoiceTotal: 0, invoiceQty: 0, invoiceValue: 0 },
    );

    const splitTotals = splitRows.reduce(
      (acc, row) => ({
        invoiceSplitByQtyQty: acc.invoiceSplitByQtyQty + (row.invoiceSplitByQtyQty || 0),
        invoiceSplitByQtyValue: acc.invoiceSplitByQtyValue + (row.invoiceSplitByQtyValue || 0),
        invoiceSplitByPriceQty: acc.invoiceSplitByPriceQty + (row.invoiceSplitByPriceQty || 0),
        invoiceSplitByPriceValue: acc.invoiceSplitByPriceValue + (row.invoiceSplitByPriceValue || 0),
      }),
      {
        invoiceSplitByQtyQty: 0,
        invoiceSplitByQtyValue: 0,
        invoiceSplitByPriceQty: 0,
        invoiceSplitByPriceValue: 0,
      },
    );

    console.log('\n[Table 1] Item + normal invoice summary (isSplit: false):');
    console.table(
      items.map(i => ({
        itemNo: i.itemNo,
        itemName: i.itemName,
        itemId: i._id.toString(),
        normalInvoiceCount: normalRows.length,
        invoiceTotal: normalTotals.invoiceTotal,
        invoiceQty: normalTotals.invoiceQty,
        invoiceValue: normalTotals.invoiceValue,
      })),
    );

    console.log(`\n[Table 2] Normal invoices list (${normalRows.length}):`);
    if (normalRows.length) {
      const normalTableRows = normalRows.map(r => ({
        invoiceId: r.invoiceId,
        invoiceDate: r.invoiceDate,
        status: r.status,
        invoiceTotal: r.invoiceTotal,
        invoiceQty: r.invoiceQty,
        invoiceValue: r.invoiceValue,
      }));

      normalTableRows.push({
        invoiceId: '— TOTAL —',
        invoiceDate: '',
        status: '',
        invoiceTotal: normalTotals.invoiceTotal,
        invoiceQty: normalTotals.invoiceQty,
        invoiceValue: normalTotals.invoiceValue,
      });

      console.table(normalTableRows);
    } else {
      console.log('No normal invoices found for this item.');
    }

    console.log(`\n[Table 3] Split invoices (isSplit: true) — split columns per invoice: ${splitRows.length}`);
    if (splitRows.length) {
      console.table(
        splitRows.map(r => ({
          invoiceId: r.invoiceId,
          invoiceDate: r.invoiceDate,
          splitWiseType: r.splitWiseType,
          status: r.status,
          invoiceTotal: r.invoiceTotal,
          'Split Qty (By Qty)': r.invoiceSplitByQtyQty,
          'Split Value (By Qty)': r.invoiceSplitByQtyValue,
          'Split Qty (By Price)': r.invoiceSplitByPriceQty,
          'Split Value (By Price)': r.invoiceSplitByPriceValue,
        })),
      );
    } else {
      console.log('No split invoices found for this item.');
    }

    console.log('\n[Table 4] Totals for Top Items of Sales (this item only):');
    console.table([
      {
        item: itemNameArg,
        invoiceQty: normalTotals.invoiceQty,
        invoiceValue: normalTotals.invoiceValue,
        invoiceSplitByQtyQty: splitTotals.invoiceSplitByQtyQty,
        invoiceSplitByQtyValue: splitTotals.invoiceSplitByQtyValue,
        invoiceSplitByPriceQty: splitTotals.invoiceSplitByPriceQty,
        invoiceSplitByPriceValue: splitTotals.invoiceSplitByPriceValue,
      },
    ]);
  } finally {
    await closeConnection(client);
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
