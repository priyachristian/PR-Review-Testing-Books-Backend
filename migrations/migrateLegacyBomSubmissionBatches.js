/**
 * Migrate: BOM production orders created before per-submission costing keep the raw-material
 * batches (quantity + purchase price) only on the order's rawMaterials list. Their submissions'
 * rawMaterialsConsumed rows carry no batches - and single-submission orders often list only some
 * raw materials - and the finished-goods batches are not linked to the submission that made them.
 * Costing, the cost breakdown, completion journals and edit/delete read each submission's own
 * batches, so these orders show a zero finished cost and a zero cost per unit.
 *
 * For every such order this script rebuilds each submission's rawMaterialsConsumed from the order:
 *   - one submission: it consumed everything the order consumed, so each raw material's batches
 *     (and its used / BOM / reject / return quantities when the submission did not list it) go to it
 *   - several submissions: each raw material's batches are handed out oldest-first, in submission
 *     order, by what each submission used + rejected (the order stock was deducted in); a quantity
 *     the submissions did not account for goes to the last one
 * and links the finished-goods batches: batch N to submission N when the counts match, a single
 * batch to the first submission otherwise. Orders whose figures do not reconcile are listed for
 * review.
 *
 * It does not touch stock, item batches, finished-goods batch prices or ledger journals.
 *
 * Idempotent / safe to re-run: only orders with no batches on any submission's raw materials
 * match, and each update re-checks that condition and the order's updatedAt, so an order changed
 * since it was read, or already migrated, is skipped.
 *
 * DRY RUN BY DEFAULT - pass --apply to write. --dry-run forces a dry run.
 *
 * Usage:
 *   node migrations/migrateLegacyBomSubmissionBatches.js                           (dry run, all companies)
 *   node migrations/migrateLegacyBomSubmissionBatches.js --dry-run --companyId=<id>
 *   node migrations/migrateLegacyBomSubmissionBatches.js --apply
 *   node migrations/migrateLegacyBomSubmissionBatches.js --apply --companyId=<id>
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const WRITE_CHUNK = 500;
const SAMPLE_SIZE = 5;

function parseArgs(argv) {
  const shouldApply = argv.includes('--apply') && !argv.includes('--dry-run');
  const hit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { shouldApply, companyId: companyArg ? new ObjectId(companyArg) : null };
}

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const roundQty = value => Math.round((Number(value) || 0) * 1000) / 1000;
const batchQty = batches => roundQty((batches || []).reduce((sum, batch) => sum + (batch.quantity || 0), 0));
const batchValue = batches => (batches || []).reduce((sum, batch) => sum + (batch.quantity || 0) * (batch.purchasePrice || 0), 0);

// Older orders store additionalCost as one { notes, amount } object; an empty one carries no cost.
// Same rule as fixProductionOrderAdditionalCostShape-remove.
function toCostArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || (!value.notes && !value.amount)) return [];
  return [{ notes: value.notes || '', amount: value.amount || 0 }];
}

// Hands batches out oldest-first: takes `wanted` units off the front of `queue`.
function takeBatches(queue, wanted) {
  const taken = [];
  let left = roundQty(wanted);
  while (left > 0 && queue.length) {
    const batch = queue[0];
    const used = roundQty(Math.min(batch.quantity, left));
    taken.push({ ...batch, quantity: used });
    left = roundQty(left - used);
    batch.quantity = roundQty(batch.quantity - used);
    if (batch.quantity <= 0) queue.shift();
  }
  return { taken, shortBy: left };
}

function consumedRowFor(submission, rawMaterialId) {
  return (submission.rawMaterialsConsumed || []).find(row => String(row.rawMaterialId) === String(rawMaterialId));
}

function buildSubmissions(order) {
  const submissions = order.submissionHistory || [];
  const isSingle = submissions.length === 1;
  const notes = [];
  const consumedBySubmission = submissions.map(submission =>
    (submission.rawMaterialsConsumed || []).map(row => ({ ...row, batches: row.batches || [] })),
  );

  for (const rm of order.rawMaterials || []) {
    if (!(rm.batches || []).length) continue;
    const queue = rm.batches.map(batch => ({ ...batch }));

    submissions.forEach((submission, index) => {
      const existing = consumedRowFor(submission, rm.rawMaterialId);
      const rows = consumedBySubmission[index];

      if (isSingle) {
        const batches = queue.splice(0, queue.length);
        if (existing) {
          rows.find(row => String(row.rawMaterialId) === String(rm.rawMaterialId)).batches = batches;
        } else {
          rows.push({
            _id: new ObjectId(),
            rawMaterialId: rm.rawMaterialId,
            productionOrderSubmittedUnit: rm.productionOrderSubmittedUnit || 0,
            bomRRQty: rm.bomRRQty || 0,
            rejectQty: rm.rejectQty || 0,
            returnQty: rm.returnQty || 0,
            batches,
          });
        }
        return;
      }

      if (!existing) return;
      const wanted = (existing.productionOrderSubmittedUnit || 0) + (existing.rejectQty || 0);
      const { taken, shortBy } = takeBatches(queue, wanted);
      rows.find(row => String(row.rawMaterialId) === String(rm.rawMaterialId)).batches = taken;
      if (shortBy > 0)
        notes.push(`raw material ${rm.rawMaterialId}: submission ${index + 1} claims ${shortBy} more than the batches hold`);
    });

    // Units the submissions did not account for still came out of stock for this order.
    if (!isSingle && queue.length) {
      const lastIndex = submissions.length - 1;
      const rows = consumedBySubmission[lastIndex];
      const leftover = queue.splice(0, queue.length);
      const row = rows.find(r => String(r.rawMaterialId) === String(rm.rawMaterialId));
      if (row) row.batches = [...row.batches, ...leftover];
      else {
        rows.push({
          _id: new ObjectId(),
          rawMaterialId: rm.rawMaterialId,
          productionOrderSubmittedUnit: batchQty(leftover),
          bomRRQty: 0,
          rejectQty: 0,
          returnQty: 0,
          batches: leftover,
        });
      }
      notes.push(`raw material ${rm.rawMaterialId}: ${batchQty(leftover)} unit(s) not on any submission, given to the last`);
    }
  }

  const fgBatches = order.batches || [];
  let batchesBySubmission;
  if (fgBatches.length === submissions.length) {
    batchesBySubmission = submissions.map((_, index) => [fgBatches[index]]);
  } else if (fgBatches.length === 1) {
    batchesBySubmission = submissions.map((_, index) => (index === 0 ? [fgBatches[0]] : []));
    if (submissions.length > 1) notes.push(`1 finished batch for ${submissions.length} submissions, linked to the first`);
  } else {
    batchesBySubmission = submissions.map(() => []);
    if (fgBatches.length) notes.push(`${fgBatches.length} finished batches for ${submissions.length} submissions, not linked`);
  }

  const nextSubmissions = submissions.map((submission, index) => ({
    ...submission,
    rawMaterialsConsumed: consumedBySubmission[index],
    batches: (submission.batches || []).length ? submission.batches : batchesBySubmission[index],
    additionalCost: toCostArray(submission.additionalCost),
  }));

  return { nextSubmissions, notes };
}

function unitCost(submission) {
  const material = (submission.rawMaterialsConsumed || []).reduce((sum, row) => sum + batchValue(row.batches), 0);
  const labour = (submission.manpowerCost || []).reduce((sum, worker) => sum + (Number(worker?.workerCost) || 0), 0);
  const overhead = toCostArray(submission.additionalCost).reduce((sum, cost) => sum + (Number(cost?.amount) || 0), 0);
  const handled = (submission.fgSubmittedQty || 0) + (submission.fgRejectedQty || 0);
  return handled > 0 ? round2((material + labour + overhead) / handled) : 0;
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

const ISSUE = {
  NO_COST_SHOWN: 'NO COST SHOWN - fixed',
  COST_TOO_LOW: 'COST TOO LOW - fixed',
  NOTHING_BOOKED: 'NO COST BOOKED - stays 0',
};

// What the cost breakdown shows today vs after the migration, per submission.
function issueOf(beforeCosts, afterCosts) {
  if (afterCosts.every(cost => !cost)) return ISSUE.NOTHING_BOOKED;
  if (beforeCosts.every(cost => !cost)) return ISSUE.NO_COST_SHOWN;
  return ISSUE.COST_TOO_LOW;
}

function describe(order, nextSubmissions) {
  const recorded = (order.batches || []).map(batch => round2(batch.purchasePrice)).join(', ') || '-';
  const beforeCosts = (order.submissionHistory || []).map(unitCost);
  const afterCosts = nextSubmissions.map(unitCost);
  const issue = issueOf(beforeCosts, afterCosts);
  const line =
    `${order.productionOrderCode || order._id} | ${order.status} | ${nextSubmissions.length} submission(s) | ` +
    `cost per unit ${beforeCosts.join(', ')} -> ${afterCosts.join(', ')} | FG batch price ${recorded} | ${issue}`;
  return { line, issue };
}

const migrate = async () => {
  let client;
  try {
    const { shouldApply, companyId: onlyCompanyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;

    printSection('migrateLegacyBomSubmissionBatches', '═');
    console.log(`\nMode: ${shouldApply ? 'APPLY (will write changes)' : 'DRY RUN (no changes written)'}`);
    console.log(`Scope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}`);

    const ProductionOrders = db.books.collection('productionorders');
    const legacyFilter = {
      productionManageMethod: 'BOM_BASED',
      'rawMaterials.batches.0': { $exists: true },
      'submissionHistory.0': { $exists: true },
      'submissionHistory.rawMaterialsConsumed.batches.0': { $exists: false },
      ...(onlyCompanyId && { companyId: onlyCompanyId }),
    };

    const orders = await ProductionOrders.find(legacyFilter).sort({ companyId: 1, createdAt: 1 }).toArray();
    console.log(`\nLegacy BOM orders found: ${orders.length}`);

    const operations = [];
    const review = [];
    const samples = [];
    const multi = [];
    const all = [];
    const issueCounts = {};

    for (const order of orders) {
      const { nextSubmissions, notes } = buildSubmissions(order);
      const { line, issue } = describe(order, nextSubmissions);
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
      all.push({ line, notes });

      if (notes.length) review.push({ line, notes });
      else if (nextSubmissions.length > 1) multi.push(line);
      else if (samples.length < SAMPLE_SIZE) samples.push(line);

      operations.push({
        updateOne: {
          filter: {
            _id: order._id,
            updatedAt: order.updatedAt,
            'submissionHistory.rawMaterialsConsumed.batches.0': { $exists: false },
          },
          update: { $set: { submissionHistory: nextSubmissions } },
        },
      });
    }

    if (onlyCompanyId) {
      // One company: every order, each with what the cost breakdown shows today and after.
      printSection(`All orders (${all.length})`);
      all.forEach(({ line, notes }) => {
        console.log(`  ${line}${notes.length ? ' | REVIEW' : ''}`);
        notes.forEach(note => console.log(`      - ${note}`));
      });
    } else {
      printSection(`Sample single-submission orders (${Math.min(SAMPLE_SIZE, samples.length)} shown)`);
      samples.forEach(line => console.log(`  ${line}`));

      printSection(`Multi-submission orders (${multi.length})`);
      multi.forEach(line => console.log(`  ${line}`));

      printSection(`Needs review (${review.length})`);
      review.forEach(({ line, notes }) => {
        console.log(`  ${line}`);
        notes.forEach(note => console.log(`      - ${note}`));
      });
    }

    let migrated = 0;
    if (shouldApply) {
      for (let index = 0; index < operations.length; index += WRITE_CHUNK) {
        const result = await ProductionOrders.bulkWrite(operations.slice(index, index + WRITE_CHUNK), { ordered: false });
        migrated += result.modifiedCount;
      }
    }

    const singleCount = orders.filter(order => order.submissionHistory.length === 1).length;
    printSection('SUMMARY', '═');
    console.log(`  Orders found:           ${orders.length}`);
    console.log(`  Single submission:      ${singleCount}`);
    console.log(`  Multi-submission:       ${orders.length - singleCount} (${multi.length} clean, the rest under review)`);
    console.log(`  Needs review:           ${review.length}`);
    Object.values(ISSUE).forEach(issue => console.log(`  ${`${issue}:`.padEnd(32)}${issueCounts[issue] || 0}`));
    if (shouldApply) {
      console.log(`  Orders migrated:        ${migrated}`);
      console.log(`  Orders skipped:         ${operations.length - migrated} (changed since they were read)`);
    } else {
      console.log('\n  Dry run only - re-run with --apply to write.');
    }
  } catch (error) {
    console.error('\nMigration failed:', error);
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
  }
};

migrate();
