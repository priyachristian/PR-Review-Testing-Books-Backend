/**
 * Audit: Find documents whose $inc-updated numeric field currently holds
 * more than 2 decimal places.
 *
 * Scope:
 *   1. Customer.branch[].currentBalance             (booksCrm DB, collection: customers)
 *      — incremented via $inc + toIncrement()
 *   2. ItemInventory.totalAvailableStock / totalInventoryValue, and per-warehouse
 *      warehouses[].availableStock / warehouses[].inventoryValue (booksCrm DB, collection: iteminventories)
 *      — incremented via plain $inc (services/warehouseBatch.service.js), no toIncrement/Decimal128 involved,
 *        so any drift here is classic binary-double rounding noise, not the type-promotion issue below.
 *   3. ItemBatch.quantity / remainingQty / purchasePrice (booksCrm DB, collection: itembatches)
 *      — mutated in JS (batch.remainingQty -= x, etc.) then .save()'d (services/warehouseBatch.service.js),
 *        no $inc/toIncrement/Decimal128 involved, so any drift here is also classic double rounding noise.
 *
 * Why (1) matters: toIncrement() wraps the increment amount as a BSON
 * Decimal128 before it hits `$inc`. MongoDB's numeric type-promotion rule
 * means incrementing a `double` field with a `Decimal128` value converts the
 * STORED field itself to Decimal128 — even though both schemas still declare
 * the field as plain `Number`. From then on the field's actual BSON type
 * depends on which code path last wrote it ($inc → Decimal128, any direct
 * `.save()`/`$set` with a JS number → double). Consumers that read the raw
 * value via `.lean()` or aggregation (bypassing Mongoose's schema cast) and
 * then do plain `+` arithmetic on it can silently get string concatenation
 * instead of addition once the value is Decimal128.
 *
 * This script reports, per schema/field:
 *   - how many documents have a value with more than 2 decimal places
 *   - how many of those are stored as Decimal128 vs double
 * so the actual scope of the drift can be seen before deciding on a fix.
 *
 * This script is READ-ONLY — it does not modify any data.
 *
 * Usage:
 *   node migrations/findFloatingPointPrecisionIssues.js                    # all companies
 *   node migrations/findFloatingPointPrecisionIssues.js --companyId=xxx    # one company
 *   node migrations/findFloatingPointPrecisionIssues.js --export           # also write a JSON file
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  let shouldExport = false;
  for (const a of args) {
    if (a.startsWith('--companyId=')) companyId = a.split('=')[1].trim();
    else if (a === '--export') shouldExport = true;
  }
  return { companyId, shouldExport };
}

/**
 * Inspect a raw field value (as read straight off the driver, no Mongoose casting)
 * and report whether it carries more than 2 decimal digits, plus its actual BSON type.
 */
function inspectValue(value) {
  if (value == null) return null;

  if (value && value._bsontype === 'Decimal128') {
    const str = value.toString();
    const dot = str.indexOf('.');
    const decimalPlaces = dot === -1 ? 0 : str.length - dot - 1;
    return { type: 'Decimal128', display: str, decimalPlaces, flagged: decimalPlaces > 2 };
  }

  const num = Number(value);
  if (Number.isNaN(num)) return null;
  const rounded = Math.round(num * 100) / 100;
  const diff = Math.abs(num - rounded);
  // Not a Decimal128, so it's a JS double — report actual decimal digit count for display,
  // but flag based on a small epsilon since binary doubles rarely print exact digit counts.
  const str = String(num);
  const dot = str.indexOf('.');
  const decimalPlaces = dot === -1 ? 0 : str.length - dot - 1;
  return { type: 'Double', display: str, decimalPlaces, flagged: diff > 1e-9 };
}

async function run() {
  const { companyId, shouldExport } = parseArgs();
  const { client, books, booksCrm, common } = await getConnection();

  try {
    const companyMatch = {};
    if (companyId) {
      companyMatch.companyId = mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : companyId;
    }

    printSection('findFloatingPointPrecisionIssues', '═');

    const findings = [];

    // ── 1. Customer.branch[].currentBalance ────────────────────────────────
    const customers = await booksCrm
      .collection('customers')
      .find(companyMatch)
      .project({ customerDisplayName: 1, companyName: 1, companyId: 1, branch: 1 })
      .toArray();

    for (const cust of customers) {
      for (const b of cust.branch || []) {
        const info = inspectValue(b.currentBalance);
        if (info && info.flagged) {
          findings.push({
            schema: 'Customer.branch.currentBalance',
            recordId: cust._id?.toString(),
            companyId: cust.companyId?.toString() || '',
            label: cust.customerDisplayName || cust.companyName || cust._id?.toString(),
            branchId: b.branchId?.toString() || '',
            value: info.display,
            bsonType: info.type,
            decimalPlaces: info.decimalPlaces,
          });
        }
      }
    }

    // ── 2. ItemInventory.totalAvailableStock / totalInventoryValue ─────────
    //      (+ per-warehouse warehouses[].availableStock / warehouses[].inventoryValue)
    const itemInventories = await booksCrm
      .collection('iteminventories')
      .find(companyMatch)
      .project({ itemId: 1, companyId: 1, totalAvailableStock: 1, totalInventoryValue: 1, warehouses: 1 })
      .toArray();

    for (const doc of itemInventories) {
      const stockInfo = inspectValue(doc.totalAvailableStock);
      if (stockInfo && stockInfo.flagged) {
        findings.push({
          schema: 'ItemInventory.totalAvailableStock',
          recordId: doc._id?.toString(),
          companyId: doc.companyId?.toString() || '',
          label: doc.itemId?.toString() || doc._id?.toString(),
          branchId: '',
          value: stockInfo.display,
          bsonType: stockInfo.type,
          decimalPlaces: stockInfo.decimalPlaces,
        });
      }

      const valueInfo = inspectValue(doc.totalInventoryValue);
      if (valueInfo && valueInfo.flagged) {
        findings.push({
          schema: 'ItemInventory.totalInventoryValue',
          recordId: doc._id?.toString(),
          companyId: doc.companyId?.toString() || '',
          label: doc.itemId?.toString() || doc._id?.toString(),
          branchId: '',
          value: valueInfo.display,
          bsonType: valueInfo.type,
          decimalPlaces: valueInfo.decimalPlaces,
        });
      }

      for (const wh of doc.warehouses || []) {
        const whLabel = `${doc.itemId?.toString() || doc._id?.toString()} / wh ${wh.warehouseId?.toString() || ''}`;

        const whStockInfo = inspectValue(wh.availableStock);
        if (whStockInfo && whStockInfo.flagged) {
          findings.push({
            schema: 'ItemInventory.warehouses.availableStock',
            recordId: doc._id?.toString(),
            companyId: doc.companyId?.toString() || '',
            label: whLabel,
            branchId: wh.branchId?.toString() || '',
            value: whStockInfo.display,
            bsonType: whStockInfo.type,
            decimalPlaces: whStockInfo.decimalPlaces,
          });
        }

        const whValueInfo = inspectValue(wh.inventoryValue);
        if (whValueInfo && whValueInfo.flagged) {
          findings.push({
            schema: 'ItemInventory.warehouses.inventoryValue',
            recordId: doc._id?.toString(),
            companyId: doc.companyId?.toString() || '',
            label: whLabel,
            branchId: wh.branchId?.toString() || '',
            value: whValueInfo.display,
            bsonType: whValueInfo.type,
            decimalPlaces: whValueInfo.decimalPlaces,
          });
        }
      }
    }

    // ── 3. ItemBatch.quantity / remainingQty / purchasePrice ───────────────
    const itemBatches = await booksCrm
      .collection('itembatches')
      .find(companyMatch)
      .project({ itemId: 1, companyId: 1, batchNo: 1, quantity: 1, remainingQty: 1, purchasePrice: 1 })
      .toArray();

    const batchFields = ['quantity', 'remainingQty', 'purchasePrice'];
    for (const doc of itemBatches) {
      for (const field of batchFields) {
        const info = inspectValue(doc[field]);
        if (info && info.flagged) {
          findings.push({
            schema: `ItemBatch.${field}`,
            recordId: doc._id?.toString(),
            companyId: doc.companyId?.toString() || '',
            label: doc.itemId?.toString() || doc._id?.toString(),
            branchId: '',
            value: info.display,
            bsonType: info.type,
            decimalPlaces: info.decimalPlaces,
          });
        }
      }
    }

    if (findings.length === 0) {
      console.log('\n  ✅ No records found with more than 2 decimal places in any $inc field.\n');
      return;
    }

    // ── Company name lookup for readability ────────────────────────────────
    const companyIds = [...new Set(findings.map(f => f.companyId).filter(Boolean))];
    const companies = await common
      .collection('companies')
      .find({ _id: { $in: companyIds.map(id => new mongoose.Types.ObjectId(id)) } })
      .project({ _id: 1, name: 1 })
      .toArray();
    const companyNameById = new Map(companies.map(c => [c._id.toString(), c.name || '']));

    const detailRows = findings.map(f => ({
      Schema: f.schema,
      'Record ID': f.recordId,
      'Branch ID': f.branchId || '—',
      Company: companyNameById.get(f.companyId) || f.companyId || '—',
      Label: f.label,
      Value: f.value,
      'BSON Type': f.bsonType,
      'Decimal Places': f.decimalPlaces,
    }));

    console.log(`\n🔻  Records with more than 2 decimal places (${detailRows.length} found):`);
    console.table(detailRows);

    // ── Per-schema summary ──────────────────────────────────────────────────
    const bySchema = {};
    for (const f of findings) {
      bySchema[f.schema] = bySchema[f.schema] || { total: 0, double: 0, decimal128: 0 };
      bySchema[f.schema].total++;
      if (f.bsonType === 'Decimal128') bySchema[f.schema].decimal128++;
      else bySchema[f.schema].double++;
    }

    printSection('Summary by schema', '─');
    console.table(
      Object.entries(bySchema).map(([schema, s]) => ({
        Schema: schema,
        'Total flagged records': s.total,
        'Stored as Double': s.double,
        'Stored as Decimal128': s.decimal128,
      })),
    );
    console.log(`\nDistinct companies affected: ${companyIds.length}`);
    console.log('\n  ⚠  This is a READ-ONLY report — nothing was modified.\n');

    if (shouldExport) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = path.join(__dirname, `floating-point-precision-issues-${timestamp}.json`);
      fs.writeFileSync(outputFile, JSON.stringify({ findings }, null, 2));
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
