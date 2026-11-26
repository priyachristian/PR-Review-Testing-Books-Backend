/**
 * Audit: Find iteminventories documents with negative stock/valuation
 *
 * Reports iteminventories documents where totalAvailableStock or
 * totalInventoryValue is less than 0. Negative values here usually indicate
 * an upstream bug (e.g. oversold stock, bad batch reconciliation) and are
 * worth investigating before they skew stock/valuation reports.
 *
 * This script is READ-ONLY — it does not modify any data. It reports what it
 * finds so the right fix can be decided on a case-by-case basis.
 *
 * Usage:
 *   node migrations/findNegativeInventory.js              # print report to console
 *   node migrations/findNegativeInventory.js --export      # also write a JSON file
 */

const fs = require('fs');
const path = require('path');
const { getConnection } = require('../config/db');

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

async function run(shouldExport) {
  const { client, booksCrm, common } = await getConnection();

  try {
    const itemInventories = booksCrm.collection('iteminventories');

    const negativeItems = await itemInventories
      .find({
        $or: [{ totalAvailableStock: { $lt: 0 } }, { totalInventoryValue: { $lt: 0 } }],
      })
      .toArray();

    printSection('findNegativeInventory', '═');

    if (!negativeItems.length) {
      console.log('\n  ✅ No iteminventories found with negative stock or valuation.\n');
      return;
    }

    const companyIds = [...new Set(negativeItems.filter(item => item.companyId).map(item => item.companyId.toString()))];
    const companies = await common
      .collection('companies')
      .find({ _id: { $in: negativeItems.filter(item => item.companyId).map(item => item.companyId) } })
      .toArray();
    const companyNameById = new Map(companies.map(company => [company._id.toString(), company.name || '']));

    const detailRows = negativeItems.map(item => ({
      'Inventory ID': item._id?.toString(),
      'Item ID': item.itemId?.toString() ?? '—',
      'Company ID': item.companyId?.toString() ?? '—',
      'Company Name': item.companyId ? companyNameById.get(item.companyId.toString()) || '' : '—',
      'Total Available Stock': item.totalAvailableStock ?? 0,
      'Total Inventory Value': item.totalInventoryValue ?? 0,
    }));

    console.log(`\n🔻  Negative inventory found (${detailRows.length} documents):`);
    console.table(detailRows);

    printSection('Summary', '─');
    console.table([
      { Metric: 'Documents with negative stock or valuation', Value: negativeItems.length },
      {
        Metric: 'Documents with negative totalAvailableStock',
        Value: negativeItems.filter(i => (i.totalAvailableStock ?? 0) < 0).length,
      },
      {
        Metric: 'Documents with negative totalInventoryValue',
        Value: negativeItems.filter(i => (i.totalInventoryValue ?? 0) < 0).length,
      },
      { Metric: 'Distinct companies affected', Value: companyIds.length },
    ]);

    console.log('\n  ⚠  This is a READ-ONLY report — nothing was modified.\n');

    if (shouldExport) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = path.join(__dirname, `negative-inventory-${timestamp}.json`);
      fs.writeFileSync(outputFile, JSON.stringify({ items: negativeItems }, null, 2));
      console.log(`  📄 Full detail exported to: ${outputFile}\n`);
    }
  } catch (err) {
    console.error('❌ Audit failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

// ─── entry point ────────────────────────────────────────────────────────────

const shouldExport = process.argv.includes('--export');
run(shouldExport).catch(() => process.exit(1));
