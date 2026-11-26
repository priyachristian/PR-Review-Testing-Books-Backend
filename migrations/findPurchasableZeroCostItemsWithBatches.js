/**
 * Audit: Find purchasable items with costPrice = 0 that already have itembatches
 *
 * Reports Item documents where:
 *   - purchaseInformation?.isPurchasable === true
 *   - purchaseInformation?.costPrice is 0, null, or missing
 *   - at least one itembatches document exists for that item
 *
 * These are items that are marked purchasable and have already been received
 * (batches exist) but never got a cost price set, which silently under-values
 * inventory for those items.
 *
 * This script is READ-ONLY — it does not modify any data.
 *
 * Usage:
 *   node migrations/findPurchasableZeroCostItemsWithBatches.js                # print report to console
 *   node migrations/findPurchasableZeroCostItemsWithBatches.js --export       # also write one JSON file per company
 *   node migrations/findPurchasableZeroCostItemsWithBatches.js --company=<id> # scope to one company
 *
 * With --export, one JSON file per company is written to:
 *   migrations/output/purchasable-zero-cost-items-with-batches-<timestamp>/<companyName>_<companyId>.json
 * Each file contains: { companyId, companyName, itemCount, items: [{ itemName, itemNo }, ...] }
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
      'purchaseInformation.isPurchasable': true,
      $or: [
        { 'purchaseInformation.costPrice': 0 },
        { 'purchaseInformation.costPrice': null },
        { 'purchaseInformation.costPrice': { $exists: false } },
      ],
    };
    if (COMPANY) filter.companyId = new ObjectId(COMPANY);

    const candidateItems = await Item.find(filter).toArray();

    printSection('findPurchasableZeroCostItemsWithBatches (grouped by company)', '═');
    console.log(`Scope: ${COMPANY ? 'company=' + COMPANY : 'all companies'}`);

    if (!candidateItems.length) {
      console.log('\n  ✅ No purchasable items found with costPrice = 0.\n');
      return;
    }

    const candidateItemIds = candidateItems.map(i => i._id);
    const itemIdsWithBatch = new Set(
      (await ItemBatch.distinct('itemId', { itemId: { $in: candidateItemIds } })).map(id => String(id)),
    );

    const items = candidateItems.filter(i => itemIdsWithBatch.has(String(i._id)));

    if (!items.length) {
      console.log('\n  ✅ No purchasable, zero-cost-price items with existing itembatches found.\n');
      return;
    }

    const companyIds = [...new Set(items.filter(i => i.companyId).map(i => String(i.companyId)))].map(id => new ObjectId(id));

    const companyDocs = companyIds.length
      ? await Company.find({ _id: { $in: companyIds } }, { projection: { name: 1 } }).toArray()
      : [];
    const companyNameById = new Map(companyDocs.map(c => [String(c._id), c.name || '']));

    const zeroPriceBatches = await ItemBatch.find({
      itemId: { $in: items.map(i => i._id) },
      $or: [{ purchasePrice: 0 }, { purchasePrice: null }, { purchasePrice: { $exists: false } }],
    }).toArray();

    const zeroPriceBatchCountByCompany = new Map();
    for (const b of zeroPriceBatches) {
      const key = b.companyId ? String(b.companyId) : '—';
      zeroPriceBatchCountByCompany.set(key, (zeroPriceBatchCountByCompany.get(key) || 0) + 1);
    }

    const byCompany = new Map();
    for (const i of items) {
      const key = i.companyId ? String(i.companyId) : '—';
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(i);
    }

    for (const [companyId, itemsList] of byCompany.entries()) {
      const companyName = companyId !== '—' ? companyNameById.get(companyId) || '' : '—';
      printSection(`Company: ${companyName} (${companyId})`, '─');

      const rows = itemsList.map(i => ({
        'Item ID': i._id?.toString(),
        Item: `${i.itemName || ''}${i.itemNo || i.itemCode ? ' (' + (i.itemNo || i.itemCode) + ')' : ''}`.trim(),
        'Is Purchasable': i.purchaseInformation?.isPurchasable ?? false,
        'Cost Price': i.purchaseInformation?.costPrice ?? 0,
        'Default Price': i.defaultPrice ?? 0,
      }));
      console.table(rows);
    }

    printSection('Summary', '─');
    console.table([
      { Metric: 'Purchasable items with costPrice = 0/null/missing (with batches)', Value: items.length },
      { Metric: 'Distinct companies affected', Value: companyIds.length },
      { Metric: 'Itembatches with purchasePrice = 0/null/missing (for those items)', Value: zeroPriceBatches.length },
    ]);

    printSection('Company-wise Count', '─');
    const companyCountRows = [...byCompany.entries()]
      .map(([companyId, itemsList]) => ({
        'Company Name': companyId !== '—' ? companyNameById.get(companyId) || '' : '—',
        'Company ID': companyId,
        'Item Count': itemsList.length,
        'Zero Price Batch Count': zeroPriceBatchCountByCompany.get(companyId) || 0,
      }))
      .sort((a, b) => b['Item Count'] - a['Item Count']);
    console.table(companyCountRows);

    console.log('\n  ⚠  This is a READ-ONLY report — nothing was modified.\n');

    if (shouldExport) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = path.join(__dirname, 'output', `purchasable-zero-cost-items-with-batches-${timestamp}`);
      fs.mkdirSync(outputDir, { recursive: true });

      const sanitize = name =>
        (name || 'unknown-company')
          .replace(/[\\/:*?"<>|]/g, '')
          .trim()
          .replace(/\s+/g, ' ');

      printSection('Exported Files', '─');
      for (const [companyId, itemsList] of byCompany.entries()) {
        const companyName = companyId !== '—' ? companyNameById.get(companyId) || '' : '—';
        const fileName = `${sanitize(companyName)}_${companyId}.json`;
        const filePath = path.join(outputDir, fileName);

        const itemRows = itemsList.map(i => ({
          itemName: i.itemName || '',
          itemNo: i.itemNo || i.itemCode || '',
        }));

        fs.writeFileSync(
          filePath,
          JSON.stringify(
            {
              companyId,
              companyName,
              itemCount: itemsList.length,
              zeroPriceBatchCount: zeroPriceBatchCountByCompany.get(companyId) || 0,
              items: itemRows,
            },
            null,
            2,
          ),
        );
        console.log(`  📄 ${fileName}  (${itemsList.length} items)`);
      }
      console.log(`\n  All files written to: ${outputDir}\n`);
    }
  } catch (err) {
    console.error('❌ Audit failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

run().catch(() => process.exit(1));
