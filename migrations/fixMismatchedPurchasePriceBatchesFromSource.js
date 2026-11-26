/**
 * Find (and optionally fix) itembatches whose purchasePrice does not match
 * the price recorded on its origin document (GRPO / BILL).
 *
 * Every batch stores `sourceType` + `sourceId`. For GRPO and BILL sourced
 * batches, the source document's `items[]` array carries the line that
 * produced the batch (matched by itemId), with a `rate` field and an
 * optional `discountConfig`. Both grpoOrder.service and bill.service compute
 * the batch price the same way:
 *
 *   expectedPrice = rate - discountAmount
 *   discountAmount = PERCENTAGE  → (rate * discountValue) / 100
 *                     AMOUNT      → discountValue / quantity
 *
 * This script recomputes that expected price from the source document and
 * flags batches where batch.purchasePrice differs from it.
 *
 * Only sourceType GRPO / BILL are checked (mirrors the SOURCE_TYPES used
 * when a batch is created off these modules). Other source types are
 * skipped entirely.
 *
 * DRY RUN BY DEFAULT — pass --apply to write.
 *
 * Usage:
 *   node migrations/fixMismatchedPurchasePriceBatchesFromSource.js                 # dry run, print report
 *   node migrations/fixMismatchedPurchasePriceBatchesFromSource.js --export        # dry run + write JSON report
 *   node migrations/fixMismatchedPurchasePriceBatchesFromSource.js --apply         # actually write the fix
 *   node migrations/fixMismatchedPurchasePriceBatchesFromSource.js --company=<id>  # scope to one company
 */

const fs = require('fs');
const path = require('path');
const { getConnection } = require('../config/db');
const { ObjectId } = require('mongoose').Types;

const args = process.argv.slice(2);
const shouldApply = args.includes('--apply');
const shouldExport = args.includes('--export');
const getArg = name => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : null;
};
const COMPANY = getArg('company');

const MODULE_NAMES = { GRPO: 'GRPO', BILL: 'BILL' };
const SOURCE_TYPES = [MODULE_NAMES.GRPO, MODULE_NAMES.BILL];

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const idStr = v => (v == null ? '' : String(v));

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

const findLine = (doc, itemId) => (doc?.items || []).find(l => l?.itemId && idStr(l.itemId) === idStr(itemId));

// GRPO/BILL: expectedPrice = rate - discountAmount (identical formula in both services).
const sourceLinePrice = line => {
  const rate = Number(line?.rate) || 0;
  const dc = line?.discountConfig;
  let discountAmount = 0;
  if (dc && Number(dc.discountValue) > 0) {
    if (dc.discountType === 'PERCENTAGE') discountAmount = (rate * Number(dc.discountValue)) / 100;
    else if (dc.discountType === 'AMOUNT') discountAmount = Number(dc.discountValue) / (Number(line?.quantity) || 1);
  }
  return round2(rate - discountAmount);
};

async function run() {
  const { client, books, booksCrm, common } = await getConnection();

  try {
    const ItemBatch = booksCrm.collection('itembatches');
    const Item = booksCrm.collection('items');
    const Company = common.collection('companies');
    const Bill = books.collection('bills');
    const Grpo = books.collection('grpoorders');

    const filter = { sourceType: { $in: SOURCE_TYPES } };
    if (COMPANY) filter.companyId = new ObjectId(COMPANY);

    const batches = await ItemBatch.find(filter).toArray();

    printSection('fixMismatchedPurchasePriceBatchesFromSource', '═');
    console.log(`Mode: ${shouldApply ? 'APPLY (will write changes)' : 'DRY RUN (no changes written)'}`);
    console.log(`Scope: ${COMPANY ? 'company=' + COMPANY : 'all companies'}, sourceType in [${SOURCE_TYPES.join(', ')}]`);

    if (!batches.length) {
      console.log('\n  ✅ No GRPO/BILL sourced batches found.\n');
      return;
    }

    // ── Preload items, companies, and source documents ───────────────
    const oids = strs => [...new Set(strs.filter(Boolean))].map(s => new ObjectId(s));
    const sourceIdsFor = type => batches.filter(b => b.sourceType === type && b.sourceId).map(b => idStr(b.sourceId));

    const itemIds = oids(batches.filter(b => b.itemId).map(b => idStr(b.itemId)));
    const companyIds = oids(batches.filter(b => b.companyId).map(b => idStr(b.companyId)));
    const grpoIds = oids(sourceIdsFor(MODULE_NAMES.GRPO));
    const billIds = oids(sourceIdsFor(MODULE_NAMES.BILL));

    const projItems = { projection: { items: 1 } };
    const [itemDocs, companyDocs, grpoDocs, billDocs] = await Promise.all([
      itemIds.length
        ? Item.find({ _id: { $in: itemIds } }, { projection: { itemName: 1, itemNo: 1, itemCode: 1 } }).toArray()
        : [],
      companyIds.length ? Company.find({ _id: { $in: companyIds } }, { projection: { name: 1 } }).toArray() : [],
      grpoIds.length ? Grpo.find({ _id: { $in: grpoIds } }, projItems).toArray() : [],
      billIds.length ? Bill.find({ _id: { $in: billIds } }, projItems).toArray() : [],
    ]);

    const itemNameById = new Map(
      itemDocs.map(d => [
        idStr(d._id),
        `${d.itemName || ''}${d.itemNo || d.itemCode ? ' (' + (d.itemNo || d.itemCode) + ')' : ''}`.trim(),
      ]),
    );
    const companyNameById = new Map(companyDocs.map(c => [idStr(c._id), c.name || '']));
    const grpoById = new Map(grpoDocs.map(d => [idStr(d._id), d]));
    const billById = new Map(billDocs.map(d => [idStr(d._id), d]));

    // ── Compare batch.purchasePrice against the source document's rate ──
    const mismatched = [];
    const matched = [];
    const unresolved = [];

    for (const batch of batches) {
      const sourceDoc =
        batch.sourceType === MODULE_NAMES.GRPO ? grpoById.get(idStr(batch.sourceId)) : billById.get(idStr(batch.sourceId));

      if (!sourceDoc) {
        unresolved.push({ batch, reason: `${batch.sourceType} source document not found` });
        continue;
      }

      const line = findLine(sourceDoc, batch.itemId);
      if (!line) {
        unresolved.push({ batch, reason: `Item not found in ${batch.sourceType} source items[]` });
        continue;
      }

      const expectedPrice = sourceLinePrice(line);
      const currentPrice = round2(batch.purchasePrice);

      if (Math.abs(expectedPrice - currentPrice) > 0.01) {
        mismatched.push({ batch, expectedPrice, currentPrice, rate: round2(line.rate) });
      } else {
        matched.push(batch);
      }
    }

    // ── Mismatched (would fix) ────────────────────────────────────────
    printSection(`Mismatched — will fix (${mismatched.length})`, '─');
    if (!mismatched.length) console.log('\n  None.\n');
    else
      console.table(
        mismatched.map(m => ({
          'Batch ID': m.batch._id.toString(),
          Company: m.batch.companyId ? companyNameById.get(idStr(m.batch.companyId)) || '' : '—',
          Item: itemNameById.get(idStr(m.batch.itemId)) || idStr(m.batch.itemId) || '—',
          'Source Type': m.batch.sourceType || '—',
          'Source Rate': m.rate,
          'Current Price': m.currentPrice,
          'Expected Price': m.expectedPrice,
        })),
      );

    // ── Unresolved (source doc/line missing — cannot verify) ──────────
    printSection(`Unresolved — cannot verify (${unresolved.length})`, '─');
    if (!unresolved.length) console.log('\n  None.\n');
    else
      console.table(
        unresolved.map(u => ({
          'Batch ID': u.batch._id.toString(),
          Company: u.batch.companyId ? companyNameById.get(idStr(u.batch.companyId)) || '' : '—',
          Item: itemNameById.get(idStr(u.batch.itemId)) || idStr(u.batch.itemId) || '—',
          'Source Type': u.batch.sourceType || '—',
          Reason: u.reason,
        })),
      );

    // ── Company-wise counts ──────────────────────────────────────────
    const mismatchedByCompany = new Map();
    for (const m of mismatched) {
      const key = m.batch.companyId ? idStr(m.batch.companyId) : '—';
      mismatchedByCompany.set(key, (mismatchedByCompany.get(key) || 0) + 1);
    }
    const unresolvedByCompany = new Map();
    for (const u of unresolved) {
      const key = u.batch.companyId ? idStr(u.batch.companyId) : '—';
      unresolvedByCompany.set(key, (unresolvedByCompany.get(key) || 0) + 1);
    }
    const allCompanyKeys = new Set([...mismatchedByCompany.keys(), ...unresolvedByCompany.keys()]);
    printSection('Company-wise Count', '─');
    console.table(
      [...allCompanyKeys]
        .map(companyId => ({
          'Company Name': companyId !== '—' ? companyNameById.get(companyId) || '' : '—',
          'Company ID': companyId,
          'Mismatched (will fix)': mismatchedByCompany.get(companyId) || 0,
          'Unresolved (cannot verify)': unresolvedByCompany.get(companyId) || 0,
        }))
        .sort((a, b) => b['Mismatched (will fix)'] - a['Mismatched (will fix)']),
    );

    printSection('Summary', '─');
    console.table([
      { Metric: 'GRPO/BILL sourced batches scanned', Value: batches.length },
      { Metric: 'Matched (already correct)', Value: matched.length },
      { Metric: 'Mismatched (will fix)', Value: mismatched.length },
      { Metric: 'Unresolved (cannot verify)', Value: unresolved.length },
    ]);

    if (shouldApply) {
      if (!mismatched.length) {
        console.log('\n  Nothing to apply.\n');
      } else {
        const bulkOps = mismatched.map(m => ({
          updateOne: { filter: { _id: m.batch._id }, update: { $set: { purchasePrice: m.expectedPrice } } },
        }));
        const result = await ItemBatch.bulkWrite(bulkOps, { ordered: false });
        console.log(`\n  ✅ Applied fix to ${result.modifiedCount}/${mismatched.length} batches.`);
        console.log(
          '  ⚠  Batch prices changed the batch ledger but NOT ItemInventory stored value —' +
            '\n     run `node migrations/verifyItemValuation.js --apply` next to reconcile stored value to the ledger.\n',
        );
      }
    } else {
      console.log('\n  ℹ️  DRY RUN — no changes were written. Re-run with --apply to commit the fix.');
      console.log('     After --apply, run `node migrations/verifyItemValuation.js --apply` to reconcile stored value.\n');
    }

    if (shouldExport) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = path.join(__dirname, `fix-mismatched-purchase-price-batches-${timestamp}.json`);
      fs.writeFileSync(
        outputFile,
        JSON.stringify(
          {
            mode: shouldApply ? 'apply' : 'dry-run',
            mismatched: mismatched.map(m => ({
              batchId: m.batch._id,
              companyId: m.batch.companyId,
              companyName: m.batch.companyId ? companyNameById.get(idStr(m.batch.companyId)) || '' : '—',
              itemId: m.batch.itemId,
              sourceType: m.batch.sourceType,
              sourceId: m.batch.sourceId,
              sourceRate: m.rate,
              currentPrice: m.currentPrice,
              expectedPrice: m.expectedPrice,
            })),
            unresolved: unresolved.map(u => ({
              batchId: u.batch._id,
              companyId: u.batch.companyId,
              companyName: u.batch.companyId ? companyNameById.get(idStr(u.batch.companyId)) || '' : '—',
              itemId: u.batch.itemId,
              sourceType: u.batch.sourceType,
              sourceId: u.batch.sourceId,
              reason: u.reason,
            })),
          },
          null,
          2,
        ),
      );
      console.log(`  📄 Full detail exported to: ${outputFile}\n`);
    }
  } catch (err) {
    console.error('❌ Fix failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

run().catch(() => process.exit(1));
