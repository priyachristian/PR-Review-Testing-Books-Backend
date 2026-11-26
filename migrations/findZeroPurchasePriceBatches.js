/**
 * Audit: Find itembatches documents with purchasePrice = 0
 *
 * Reports ItemBatch documents where purchasePrice is 0, null, or missing.
 * A zero purchase price on a batch that still has remaining quantity means
 * that batch is silently contributing 0 value to inventory valuation, which
 * usually indicates a bad purchase/GRPO entry or a missed price backfill.
 *
 * This script is READ-ONLY — it does not modify any data.
 *
 * Usage:
 *   node migrations/findZeroPurchasePriceBatches.js                    # print report to console
 *   node migrations/findZeroPurchasePriceBatches.js --export           # also write a JSON file
 *   node migrations/findZeroPurchasePriceBatches.js --company=<id>     # scope to one company
 *   node migrations/findZeroPurchasePriceBatches.js --item=<id>        # scope to one item
 */

const fs = require('fs');
const path = require('path');
const { getConnection } = require('../config/db');
const { ObjectId } = require('mongoose').Types;

const args = process.argv.slice(2);
const shouldExport = args.includes('--export');
const getArg = name => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : null;
};
const COMPANY = getArg('company');
const ITEM = getArg('item');

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

async function run() {
  const { client, booksCrm, common } = await getConnection();

  try {
    const ItemBatch = booksCrm.collection('itembatches');
    const Item = booksCrm.collection('items');
    const Company = common.collection('companies');

    const filter = {
      $or: [{ purchasePrice: 0 }, { purchasePrice: null }, { purchasePrice: { $exists: false } }],
    };
    if (COMPANY) filter.companyId = new ObjectId(COMPANY);
    if (ITEM) filter.itemId = new ObjectId(ITEM);

    const zeroPriceBatches = await ItemBatch.find(filter).toArray();

    printSection('findZeroPurchasePriceBatches (grouped by company)', '═');
    console.log(`Scope: ${COMPANY ? 'company=' + COMPANY : 'all companies'}${ITEM ? ', item=' + ITEM : ''}`);

    if (!zeroPriceBatches.length) {
      console.log('\n  ✅ No itembatches found with purchasePrice = 0.\n');
      return;
    }

    const itemIds = [...new Set(zeroPriceBatches.filter(b => b.itemId).map(b => String(b.itemId)))].map(id => new ObjectId(id));
    const companyIds = [...new Set(zeroPriceBatches.filter(b => b.companyId).map(b => String(b.companyId)))].map(
      id => new ObjectId(id),
    );

    const [itemDocs, companyDocs] = await Promise.all([
      itemIds.length
        ? Item.find({ _id: { $in: itemIds } }, { projection: { itemName: 1, itemNo: 1, itemCode: 1 } }).toArray()
        : [],
      companyIds.length ? Company.find({ _id: { $in: companyIds } }, { projection: { name: 1 } }).toArray() : [],
    ]);

    const itemNameById = new Map(
      itemDocs.map(d => [
        String(d._id),
        `${d.itemName || ''}${d.itemNo || d.itemCode ? ' (' + (d.itemNo || d.itemCode) + ')' : ''}`.trim(),
      ]),
    );
    const companyNameById = new Map(companyDocs.map(c => [String(c._id), c.name || '']));

    const byCompany = new Map();
    for (const b of zeroPriceBatches) {
      const key = b.companyId ? String(b.companyId) : '—';
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(b);
    }

    for (const [companyId, batches] of byCompany.entries()) {
      const companyName = companyId !== '—' ? companyNameById.get(companyId) || '' : '—';
      printSection(`Company: ${companyName} (${companyId})`, '─');

      const rows = batches.map(b => ({
        'Batch ID': b._id?.toString(),
        Item: itemNameById.get(String(b.itemId)) || String(b.itemId) || '—',
        'Warehouse ID': b.warehouseId?.toString() ?? '—',
        'Batch No': b.batchNo ?? '—',
        'Remaining Qty': b.remainingQty ?? 0,
        'Purchase Price': b.purchasePrice ?? 0,
      }));
      console.table(rows);
    }

    printSection('Summary', '─');
    console.table([
      { Metric: 'Batches with purchasePrice = 0/null/missing', Value: zeroPriceBatches.length },
      {
        Metric: 'Of those, with remainingQty > 0',
        Value: zeroPriceBatches.filter(b => (b.remainingQty || 0) > 0).length,
      },
      { Metric: 'Distinct companies affected', Value: companyIds.length },
      { Metric: 'Distinct items affected', Value: itemIds.length },
    ]);

    printSection('Company-wise Count', '─');
    const companyCountRows = [...byCompany.entries()]
      .map(([companyId, batches]) => ({
        'Company Name': companyId !== '—' ? companyNameById.get(companyId) || '' : '—',
        'Company ID': companyId,
        Count: batches.length,
      }))
      .sort((a, b) => b.Count - a.Count);
    console.table(companyCountRows);

    console.log('\n  ⚠  This is a READ-ONLY report — nothing was modified.\n');

    if (shouldExport) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = path.join(__dirname, `zero-purchase-price-batches-${timestamp}.json`);
      const grouped = [...byCompany.entries()].map(([companyId, batches]) => ({
        companyId,
        companyName: companyId !== '—' ? companyNameById.get(companyId) || '' : '—',
        batches,
      }));
      fs.writeFileSync(outputFile, JSON.stringify({ groups: grouped }, null, 2));
      console.log(`  📄 Full detail exported to: ${outputFile}\n`);
    }
  } catch (err) {
    console.error('❌ Audit failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

run().catch(() => process.exit(1));
