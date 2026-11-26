/**
 * Backfill zero-price itembatches by recovering the price from the batch's SOURCE,
 * per source type, falling back to the item's costPrice.
 *
 * Every batch stores `sourceType` + `sourceId`. For each zero-price batch this
 * script replays how that source computed the batch price, in priority order:
 *   source-specific price  →  item.purchaseInformation.costPrice  →  unresolved
 *
 * Per-source recovery (all source docs are in the `books` DB unless noted;
 * itembatches/items are in `booksCrm`):
 *   BILL / SPLIT_BILL            bills[sourceId].items[itemId].rate            (bill.service does not apply line discount to the batch)
 *   GRPO                         grpoorders[sourceId].items[itemId].rate − discount
 *   CREDIT_NOTE                  creditnotes[sourceId].items[itemId].rate
 *   MANUAL_STOCK_ADD             inventorylogs[sourceId].price                 (exact entered price)
 *   INVENTORY_ADJUSTMENT         inventoryadjustments[sourceId].items[itemId].purchasePrice
 *   PRODUCTION_ORDER             productionorders[sourceId].batches[itemBatchId==batch._id].purchasePrice
 *                                (+ processBased.processes[].scrapOutProcess[].batches[] for scrap)
 *   MANUAL_STOCK_TRANSFER        source batch deductions[].sellingPrice (deductedSourceId==sourceId, matched by qty)
 *   PRODUCTIONORDER_STOCK_TRANSFER   same as MANUAL_STOCK_TRANSFER
 *   EXISTING_INVENTORY           item costPrice — seeded by seedInventoryToBatches.js from the now-deprecated
 *                                defaultPrice, so it is recovered from the item cost like OPENING_STOCK
 *   OPENING_STOCK / REJECTION_RECOVERY / anything else   →  item costPrice fallback
 *
 * defaultPrice is deliberately NOT used as a fallback (it is being removed).
 *
 * Caveat: a batch is often zero-priced because its source recorded zero at
 * creation (e.g. a bill line with no rate, or production from zero-cost raw
 * materials). In those cases source recovery also yields 0 and the batch falls
 * through to item costPrice (or Unresolved). Production FG recompute (rolling up
 * raw-material costs) and multi-batch transfer disambiguation are out of scope;
 * those fall back to costPrice.
 *
 * DRY RUN BY DEFAULT — pass --apply to write. After --apply, run
 * `verifyItemValuation.js --apply` to reconcile ItemInventory stored value.
 *
 * Usage:
 *   node migrations/backfillZeroPurchasePriceBatchesFromSource.js                    # dry run, print report
 *   node migrations/backfillZeroPurchasePriceBatchesFromSource.js --export           # dry run + write JSON report
 *   node migrations/backfillZeroPurchasePriceBatchesFromSource.js --apply            # actually write the backfill
 *   node migrations/backfillZeroPurchasePriceBatchesFromSource.js --company=<id>     # scope to one company
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

const BILL_SOURCE_TYPES = new Set(['BILL', 'SPLIT_BILL']);
const GRPO_SOURCE_TYPES = new Set(['GRPO']);
const TRANSFER_SOURCE_TYPES = new Set(['MANUAL_STOCK_TRANSFER', 'PRODUCTIONORDER_STOCK_TRANSFER']);

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const idStr = v => (v == null ? '' : String(v));

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

const findLine = (doc, itemId) => (doc?.items || []).find(l => l?.itemId && idStr(l.itemId) === idStr(itemId));

// BILL/SPLIT_BILL: bill.service sets finalPurchasePrice = rate (line discount is NOT applied to the batch).
const billLinePrice = line => round2(line?.rate);

// GRPO: rate − discount, AMOUNT discount is per-unit (discountValue / quantity).
const grpoLinePrice = line => {
  const rate = Number(line?.rate) || 0;
  const dc = line?.discountConfig;
  let discountAmount = 0;
  if (dc && Number(dc.discountValue) > 0) {
    if (dc.discountType === 'PERCENTAGE') discountAmount = (rate * Number(dc.discountValue)) / 100;
    else if (dc.discountType === 'AMOUNT') discountAmount = Number(dc.discountValue) / (Number(line?.quantity) || 1);
  }
  return round2(rate - discountAmount);
};

// PRODUCTION_ORDER: the FG/scrap batch price is snapshotted back onto the order,
// linked by itemBatchId. Scan root batches[] and every process's scrapOutProcess[].batches[].
const productionBatchPrice = (order, batchId) => {
  const scan = arr => (arr || []).find(b => b?.itemBatchId && idStr(b.itemBatchId) === idStr(batchId));
  const root = scan(order?.batches);
  if (root) return round2(root.purchasePrice);
  for (const proc of order?.processBased?.processes || []) {
    for (const scrap of proc?.scrapOutProcess || []) {
      const s = scan(scrap?.batches);
      if (s) return round2(s.purchasePrice);
    }
  }
  return 0;
};

async function run() {
  const { client, books, booksCrm, common } = await getConnection();

  try {
    const ItemBatch = booksCrm.collection('itembatches');
    const Item = booksCrm.collection('items');
    const Company = common.collection('companies');
    const Bill = books.collection('bills');
    const Grpo = books.collection('grpoorders');
    const CreditNote = books.collection('creditnotes');
    const InventoryLog = books.collection('inventorylogs');
    const InventoryAdjustment = books.collection('inventoryadjustments');
    const ProductionOrder = books.collection('productionorders');

    const filter = {
      $or: [{ purchasePrice: 0 }, { purchasePrice: null }, { purchasePrice: { $exists: false } }],
    };
    if (COMPANY) filter.companyId = new ObjectId(COMPANY);

    const zeroBatches = await ItemBatch.find(filter).toArray();

    printSection('backfillZeroPurchasePriceBatchesFromSource', '═');
    console.log(`Mode: ${shouldApply ? 'APPLY (will write changes)' : 'DRY RUN (no changes written)'}`);
    console.log(`Scope: ${COMPANY ? 'company=' + COMPANY : 'all companies'}`);

    if (!zeroBatches.length) {
      console.log('\n  ✅ No zero-price batches found.\n');
      return;
    }

    // ── Collect ids to preload, per source type ──────────────────────
    const oids = strs => [...new Set(strs.filter(Boolean))].map(s => new ObjectId(s));
    const sourceIdsFor = pred => zeroBatches.filter(b => pred(b.sourceType) && b.sourceId).map(b => idStr(b.sourceId));

    const itemIds = oids(zeroBatches.filter(b => b.itemId).map(b => idStr(b.itemId)));
    const companyIds = oids(zeroBatches.filter(b => b.companyId).map(b => idStr(b.companyId)));
    const billIds = oids(sourceIdsFor(t => BILL_SOURCE_TYPES.has(t)));
    const grpoIds = oids(sourceIdsFor(t => GRPO_SOURCE_TYPES.has(t)));
    const creditIds = oids(sourceIdsFor(t => t === 'CREDIT_NOTE'));
    const logIds = oids(sourceIdsFor(t => t === 'MANUAL_STOCK_ADD'));
    const adjIds = oids(sourceIdsFor(t => t === 'INVENTORY_ADJUSTMENT'));
    const prodIds = oids(sourceIdsFor(t => t === 'PRODUCTION_ORDER'));
    const transferIds = oids(sourceIdsFor(t => TRANSFER_SOURCE_TYPES.has(t)));

    const projItems = { projection: { items: 1 } };
    const [itemDocs, companyDocs, billDocs, grpoDocs, creditDocs, logDocs, adjDocs, prodDocs, transferSourceBatches] =
      await Promise.all([
        itemIds.length
          ? Item.find(
              { _id: { $in: itemIds } },
              { projection: { itemName: 1, itemNo: 1, itemCode: 1, 'purchaseInformation.costPrice': 1 } },
            ).toArray()
          : [],
        companyIds.length ? Company.find({ _id: { $in: companyIds } }, { projection: { name: 1 } }).toArray() : [],
        billIds.length ? Bill.find({ _id: { $in: billIds } }, projItems).toArray() : [],
        grpoIds.length ? Grpo.find({ _id: { $in: grpoIds } }, projItems).toArray() : [],
        creditIds.length ? CreditNote.find({ _id: { $in: creditIds } }, projItems).toArray() : [],
        logIds.length ? InventoryLog.find({ _id: { $in: logIds } }, { projection: { price: 1 } }).toArray() : [],
        adjIds.length ? InventoryAdjustment.find({ _id: { $in: adjIds } }, projItems).toArray() : [],
        prodIds.length
          ? ProductionOrder.find({ _id: { $in: prodIds } }, { projection: { batches: 1, 'processBased.processes': 1 } }).toArray()
          : [],
        // Transfers: the transferred price survives as sellingPrice on the SOURCE batch's deduction.
        transferIds.length
          ? ItemBatch.find(
              { 'deductions.deductedSourceId': { $in: transferIds } },
              { projection: { itemId: 1, deductions: 1 } },
            ).toArray()
          : [],
      ]);

    const itemById = new Map(itemDocs.map(d => [idStr(d._id), d]));
    const itemNameById = new Map(
      itemDocs.map(d => [
        idStr(d._id),
        `${d.itemName || ''}${d.itemNo || d.itemCode ? ' (' + (d.itemNo || d.itemCode) + ')' : ''}`.trim(),
      ]),
    );
    const companyNameById = new Map(companyDocs.map(c => [idStr(c._id), c.name || '']));
    const billById = new Map(billDocs.map(d => [idStr(d._id), d]));
    const grpoById = new Map(grpoDocs.map(d => [idStr(d._id), d]));
    const creditById = new Map(creditDocs.map(d => [idStr(d._id), d]));
    const logById = new Map(logDocs.map(d => [idStr(d._id), d]));
    const adjById = new Map(adjDocs.map(d => [idStr(d._id), d]));
    const prodById = new Map(prodDocs.map(d => [idStr(d._id), d]));

    // Transfer price index: key = `${deductedSourceId}|${itemId}|${round2(quantityDeducted)}` → sellingPrice.
    // Ambiguous keys (same source+item+qty across batches at different prices) are marked null.
    const transferPriceByKey = new Map();
    for (const src of transferSourceBatches) {
      for (const d of src.deductions || []) {
        if (!TRANSFER_SOURCE_TYPES.has(d?.deductedSourceType)) continue;
        const key = `${idStr(d.deductedSourceId)}|${idStr(src.itemId)}|${round2(d.quantityDeducted)}`;
        const price = round2(d.sellingPrice);
        if (!(price > 0)) continue;
        if (transferPriceByKey.has(key) && transferPriceByKey.get(key) !== price)
          transferPriceByKey.set(key, null); // ambiguous
        else transferPriceByKey.set(key, price);
      }
    }

    // ── Resolve a price per batch: source-specific → item costPrice → none ──
    const resolvePrice = batch => {
      const type = batch.sourceType;
      let price = 0;
      let from = null;

      if (BILL_SOURCE_TYPES.has(type)) {
        const line = findLine(billById.get(idStr(batch.sourceId)), batch.itemId);
        price = line ? billLinePrice(line) : 0;
        from = `${type} line`;
      } else if (GRPO_SOURCE_TYPES.has(type)) {
        const line = findLine(grpoById.get(idStr(batch.sourceId)), batch.itemId);
        price = line ? grpoLinePrice(line) : 0;
        from = 'GRPO line';
      } else if (type === 'CREDIT_NOTE') {
        const line = findLine(creditById.get(idStr(batch.sourceId)), batch.itemId);
        price = line ? round2(line.rate) : 0;
        from = 'CREDIT_NOTE line';
      } else if (type === 'MANUAL_STOCK_ADD') {
        price = round2(logById.get(idStr(batch.sourceId))?.price);
        from = 'inventory log price';
      } else if (type === 'INVENTORY_ADJUSTMENT') {
        const line = findLine(adjById.get(idStr(batch.sourceId)), batch.itemId);
        price = line ? round2(line.purchasePrice) : 0;
        from = 'adjustment line';
      } else if (type === 'PRODUCTION_ORDER') {
        price = productionBatchPrice(prodById.get(idStr(batch.sourceId)), batch._id);
        from = 'production order batch';
      } else if (TRANSFER_SOURCE_TYPES.has(type)) {
        const key = `${idStr(batch.sourceId)}|${idStr(batch.itemId)}|${round2(batch.quantity)}`;
        const p = transferPriceByKey.get(key);
        price = p || 0; // null (ambiguous) or missing → 0 → fall through
        from = 'transfer source batch';
      }

      if (price > 0 && from) return { price, from };

      // Fallback: item cost price
      const item = itemById.get(idStr(batch.itemId));
      if (!item) return { price: 0, from: null, reason: 'Item not found' };
      const costPrice = Number(item.purchaseInformation?.costPrice) || 0;
      if (costPrice > 0) return { price: round2(costPrice), from: 'item costPrice' };

      return { price: 0, from: null, reason: `No source price for ${type || 'unknown source'} and item has no costPrice` };
    };

    const resolved = [];
    const unresolved = [];
    for (const batch of zeroBatches) {
      const r = resolvePrice(batch);
      if (r.price > 0 && r.from) resolved.push({ batch, newPrice: r.price, from: r.from });
      else unresolved.push({ batch, reason: r.reason || 'Could not resolve a price' });
    }

    // ── Resolved (would backfill) ───────────────────────────────────
    printSection(`Resolved — will backfill (${resolved.length})`, '─');
    if (!resolved.length) console.log('\n  None.\n');
    else
      console.table(
        resolved.map(r => ({
          'Batch ID': r.batch._id.toString(),
          Company: r.batch.companyId ? companyNameById.get(idStr(r.batch.companyId)) || '' : '—',
          Item: itemNameById.get(idStr(r.batch.itemId)) || idStr(r.batch.itemId) || '—',
          'Source Type': r.batch.sourceType || '—',
          'Price From': r.from,
          'Old Price': r.batch.purchasePrice ?? 0,
          'New Price': r.newPrice,
        })),
      );

    // ── Unresolved (needs manual entry) ─────────────────────────────
    printSection(`Unresolved — needs manual correction (${unresolved.length})`, '─');
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

    // ── Zero-price batches grouped by source type (where they came from) ──
    const bySourceType = new Map();
    for (const b of zeroBatches) {
      const key = b.sourceType || '—';
      const entry = bySourceType.get(key) || { total: 0, withStock: 0 };
      entry.total += 1;
      if ((Number(b.remainingQty) || 0) > 0) entry.withStock += 1;
      bySourceType.set(key, entry);
    }
    printSection('Zero-price batches by source type', '─');
    console.table(
      [...bySourceType.entries()]
        .map(([sourceType, s]) => ({ 'Source Type': sourceType, Batches: s.total, 'With remaining stock': s.withStock }))
        .sort((a, b) => b.Batches - a.Batches),
    );

    // ── Resolved breakdown by price source ──────────────────────────
    const resolvedBySource = new Map();
    for (const r of resolved) resolvedBySource.set(r.from, (resolvedBySource.get(r.from) || 0) + 1);
    printSection('Resolved by price source', '─');
    console.table([...resolvedBySource.entries()].map(([from, count]) => ({ 'Price From': from, Count: count })));

    // ── Company-wise counts ──────────────────────────────────────────
    const resolvedByCompany = new Map();
    for (const r of resolved) {
      const key = r.batch.companyId ? idStr(r.batch.companyId) : '—';
      resolvedByCompany.set(key, (resolvedByCompany.get(key) || 0) + 1);
    }
    const unresolvedByCompany = new Map();
    for (const u of unresolved) {
      const key = u.batch.companyId ? idStr(u.batch.companyId) : '—';
      unresolvedByCompany.set(key, (unresolvedByCompany.get(key) || 0) + 1);
    }
    const allCompanyKeys = new Set([...resolvedByCompany.keys(), ...unresolvedByCompany.keys()]);
    printSection('Company-wise Count', '─');
    console.table(
      [...allCompanyKeys]
        .map(companyId => ({
          'Company Name': companyId !== '—' ? companyNameById.get(companyId) || '' : '—',
          'Company ID': companyId,
          'Resolved (will backfill)': resolvedByCompany.get(companyId) || 0,
          'Unresolved (manual)': unresolvedByCompany.get(companyId) || 0,
        }))
        .sort((a, b) => b['Resolved (will backfill)'] - a['Resolved (will backfill)']),
    );

    printSection('Summary', '─');
    console.table([
      { Metric: 'Zero-price batches scanned', Value: zeroBatches.length },
      { Metric: 'Resolved (will backfill)', Value: resolved.length },
      { Metric: 'Unresolved (needs manual entry)', Value: unresolved.length },
    ]);

    if (shouldApply) {
      if (!resolved.length) {
        console.log('\n  Nothing to apply.\n');
      } else {
        const bulkOps = resolved.map(r => ({
          updateOne: { filter: { _id: r.batch._id }, update: { $set: { purchasePrice: r.newPrice } } },
        }));
        const result = await ItemBatch.bulkWrite(bulkOps, { ordered: false });
        console.log(`\n  ✅ Applied backfill to ${result.modifiedCount}/${resolved.length} batches.`);
        console.log(
          '  ⚠  Batch prices changed the batch ledger but NOT ItemInventory stored value —' +
            '\n     run `node migrations/verifyItemValuation.js --apply` next to reconcile stored value to the ledger.\n',
        );
      }
    } else {
      console.log('\n  ℹ️  DRY RUN — no changes were written. Re-run with --apply to commit the backfill.');
      console.log('     After --apply, run `node migrations/verifyItemValuation.js --apply` to reconcile stored value.\n');
    }

    if (shouldExport) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = path.join(__dirname, `backfill-zero-purchase-price-batches-${timestamp}.json`);
      fs.writeFileSync(
        outputFile,
        JSON.stringify(
          {
            mode: shouldApply ? 'apply' : 'dry-run',
            resolved: resolved.map(r => ({
              batchId: r.batch._id,
              companyId: r.batch.companyId,
              companyName: r.batch.companyId ? companyNameById.get(idStr(r.batch.companyId)) || '' : '—',
              itemId: r.batch.itemId,
              sourceType: r.batch.sourceType,
              sourceId: r.batch.sourceId,
              priceFrom: r.from,
              oldPrice: r.batch.purchasePrice ?? 0,
              newPrice: r.newPrice,
            })),
            unresolved: unresolved.map(u => ({
              batchId: u.batch._id,
              companyId: u.batch.companyId,
              companyName: u.batch.companyId ? companyNameById.get(idStr(u.batch.companyId)) || '' : '—',
              itemId: u.batch.itemId,
              sourceType: u.batch.sourceType,
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
    console.error('❌ Backfill failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

run().catch(() => process.exit(1));
