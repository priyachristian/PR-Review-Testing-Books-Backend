/**
 * Migration: Round ItemBatch.quantity / remainingQty / purchasePrice and
 * deductions[].quantityDeducted / deductions[].sellingPrice to 2 decimal places.
 *
 * Each field is rounded independently (no recalculation from other fields) — this
 * only fixes binary-double rounding noise (see findFloatingPointPrecisionIssues.js),
 * it does not recompute quantity/value totals.
 *
 * Runs as a DRY RUN by default — pass --apply to actually write.
 *
 * Usage:
 *   node migrations/roundItemBatchPrecision.js                    # dry run, all companies
 *   node migrations/roundItemBatchPrecision.js --apply
 *   node migrations/roundItemBatchPrecision.js --companyId=<id>
 *   node migrations/roundItemBatchPrecision.js --companyId=<id> --apply
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const BATCH_COLLECTION = 'itembatches';
const BATCH_SIZE = 500;

const round2 = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

function parseArgs(argv) {
  const hit = argv.find(a => a.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { companyId: companyArg ? new ObjectId(companyArg) : null };
}

/**
 * Round a document's fields independently to 2 decimal places.
 * Returns null if the document already matches (nothing to fix).
 */
function reconcile(doc) {
  let changed = false;

  const quantity = round2(doc.quantity);
  const remainingQty = round2(doc.remainingQty);
  const purchasePrice = round2(doc.purchasePrice);

  if (
    quantity !== Number(doc.quantity || 0) ||
    remainingQty !== Number(doc.remainingQty || 0) ||
    purchasePrice !== Number(doc.purchasePrice || 0)
  ) {
    changed = true;
  }

  const deductions = (doc.deductions || []).map(d => {
    const roundedQuantityDeducted = round2(d.quantityDeducted);
    const roundedSellingPrice = round2(d.sellingPrice);

    if (roundedQuantityDeducted !== Number(d.quantityDeducted || 0) || roundedSellingPrice !== Number(d.sellingPrice || 0)) {
      changed = true;
    }

    return { ...d, quantityDeducted: roundedQuantityDeducted, sellingPrice: roundedSellingPrice };
  });

  if (!changed) return null;

  return { quantity, remainingQty, purchasePrice, deductions };
}

async function up(apply = false) {
  const { companyId: onlyCompanyId } = parseArgs(process.argv);
  const { client, booksCrm } = await getConnection();

  const stats = { scanned: 0, needsFix: 0, updated: 0 };
  const details = [];

  try {
    const batchCol = booksCrm.collection(BATCH_COLLECTION);
    const filter = onlyCompanyId ? { companyId: onlyCompanyId } : {};

    console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);

    const cursor = batchCol.find(filter);
    let buffer = [];

    const flush = async () => {
      if (!buffer.length) return;

      if (apply) {
        const ops = buffer.map(({ doc, fix }) => ({
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                quantity: fix.quantity,
                remainingQty: fix.remainingQty,
                purchasePrice: fix.purchasePrice,
                deductions: fix.deductions,
                updatedAt: new Date(),
              },
            },
          },
        }));

        const res = await batchCol.bulkWrite(ops, { ordered: false });
        stats.updated += res.modifiedCount;
      }

      buffer = [];
    };

    for await (const doc of cursor) {
      stats.scanned += 1;

      const fix = reconcile(doc);
      if (!fix) continue;

      stats.needsFix += 1;
      details.push({
        itemBatchId: String(doc._id),
        itemId: String(doc.itemId),
        companyId: String(doc.companyId),
        batchNo: doc.batchNo,
        quantity: `${doc.quantity} -> ${fix.quantity}`,
        remainingQty: `${doc.remainingQty} -> ${fix.remainingQty}`,
        purchasePrice: `${doc.purchasePrice} -> ${fix.purchasePrice}`,
        deductionCount: fix.deductions.length,
      });

      buffer.push({ doc, fix });
      if (buffer.length >= BATCH_SIZE) await flush();
    }
    await flush();

    if (details.length) {
      console.log('\nAffected item batches:');
      console.table(details);
    }

    console.log('\nSummary:');
    console.table([
      { metric: 'Item batches scanned', value: stats.scanned },
      { metric: 'Item batches needing fix', value: stats.needsFix },
      {
        metric: apply ? 'Item batches updated' : 'Item batches that would be updated',
        value: apply ? stats.updated : stats.needsFix,
      },
    ]);

    console.log(apply ? '\n✅ Migration up completed' : '\nDry run — no changes written. Re-run with --apply to persist.');
  } catch (err) {
    console.error('❌ Migration up failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { up };

if (require.main === module) {
  const apply = process.argv.includes('--apply');

  up(apply)
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
