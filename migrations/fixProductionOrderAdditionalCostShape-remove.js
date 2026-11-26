/**
 * Fix: the ProductionOrder schema changed `additionalCost` from a single embedded object
 * ({ notes, amount }) to an array ([{ notes, amount, submissionId }]), in two places:
 *   - processBased.processes[].additionalCost
 *   - submissionHistory[].additionalCost
 *
 * Existing orders created before this change still store the old object shape. This script
 * rewrites those into single-element arrays so every order matches the new schema, except when
 * the object is empty ({ notes: '', amount: 0 }) - that carries no real cost data, so it becomes
 * an empty array [] instead of a placeholder entry. It does not touch orders that are already
 * arrays (already migrated) or have no additionalCost at all.
 *
 * Nothing else needs a migration:
 *   - isLocked, isManuallyCompleted, per-process status, scrapOut, activityLog,
 *     inventoryImpactLog, and per-process submissionHistory are all brand-new fields with safe
 *     Mongoose defaults - old orders simply read as empty/false/pending, which is correct.
 *
 * Idempotent / safe to re-run: the query only matches orders where additionalCost is still a
 * plain object, so an already-fixed order won't match or be touched again.
 *
 * DRY RUN BY DEFAULT - pass --apply to write.
 *
 * Usage:
 *   node migrations/fixProductionOrderAdditionalCostShape-remove.js                   (dry run, all companies)
 *   node migrations/fixProductionOrderAdditionalCostShape-remove.js --companyId=<id>  (dry run, one company)
 *   node migrations/fixProductionOrderAdditionalCostShape-remove.js --apply
 *   node migrations/fixProductionOrderAdditionalCostShape-remove.js --apply --companyId=<id>
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

function parseArgs(argv) {
  const shouldApply = argv.includes('--apply');
  const hit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { shouldApply, companyId: companyArg ? new ObjectId(companyArg) : null };
}

function isPlainObjectCost(value) {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyCost(value) {
  return !value.notes && !value.amount;
}

function toCostArray(value) {
  if (isEmptyCost(value)) return [];
  return [{ notes: value.notes || '', amount: value.amount || 0 }];
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function orderLabel(order) {
  return order.productionOrderCode || order._id.toString();
}

const fix = async () => {
  let client;
  try {
    const { shouldApply, companyId: onlyCompanyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;

    printSection('fixProductionOrderAdditionalCostShape', '═');
    console.log(`\nMode: ${shouldApply ? 'APPLY (will write changes)' : 'DRY RUN (no changes written)'}`);
    console.log(`Scope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}`);

    const ProductionOrders = db.books.collection('productionorders');

    const scope = {
      $or: [
        { 'submissionHistory.additionalCost': { $type: 'object' } },
        { 'processBased.processes.additionalCost': { $type: 'object' } },
      ],
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
    };

    const orders = await ProductionOrders.find(scope).toArray();

    if (!orders.length) {
      console.log('\n✅ No production orders with an object-shaped additionalCost found.\n');
      return;
    }
    console.log(`\nFound ${orders.length} matching production order(s).\n`);

    const candidates = [];

    for (const order of orders) {
      let submissionHistoryFixes = 0;
      let processFixes = 0;

      const submissionHistory = (order.submissionHistory || []).map(entry => {
        if (!isPlainObjectCost(entry.additionalCost)) return entry;
        submissionHistoryFixes++;
        return { ...entry, additionalCost: toCostArray(entry.additionalCost) };
      });

      let processes = null;
      if (order.processBased && Array.isArray(order.processBased.processes)) {
        processes = order.processBased.processes.map(proc => {
          if (!isPlainObjectCost(proc.additionalCost)) return proc;
          processFixes++;
          return { ...proc, additionalCost: toCostArray(proc.additionalCost) };
        });
      }

      if (submissionHistoryFixes || processFixes) {
        candidates.push({ order, submissionHistory, processes, submissionHistoryFixes, processFixes });
      }
    }

    printSection(`Will fix (${candidates.length})`);
    if (!candidates.length) console.log('\n  None.\n');
    else
      console.table(
        candidates.map(c => ({
          productionOrderCode: orderLabel(c.order),
          productionOrderId: c.order._id.toString(),
          companyId: c.order.companyId ? c.order.companyId.toString() : '(missing)',
          submissionHistoryEntriesFixed: c.submissionHistoryFixes,
          processEntriesFixed: c.processFixes,
        })),
      );

    if (!shouldApply) {
      console.log('\nℹ️  DRY RUN - no changes were written. Re-run with --apply to commit the fix.\n');
      return;
    }

    if (!candidates.length) {
      console.log('\nNothing to apply.\n');
      return;
    }

    console.log(`\nApplying fix to ${candidates.length} production order(s)...\n`);
    let appliedCount = 0;
    const failures = [];

    for (const c of candidates) {
      try {
        const setFields = { submissionHistory: c.submissionHistory };
        if (c.processes !== null) setFields['processBased.processes'] = c.processes;

        await ProductionOrders.updateOne({ _id: c.order._id }, { $set: setFields });
        appliedCount++;
        console.log(`  ✅ Fixed ${orderLabel(c.order)} (${c.order._id.toString()})`);
      } catch (err) {
        failures.push({ order: c.order, error: err.message });
        console.error(`  ❌ Failed to fix ${orderLabel(c.order)}: ${err.message}`);
      }
    }

    console.log(`\n✅ Applied to ${appliedCount}/${candidates.length} production orders.`);
    if (failures.length) {
      printSection(`Failures (${failures.length})`);
      console.table(failures.map(f => ({ productionOrderId: f.order._id.toString(), error: f.error })));
    }
    console.log('');
  } catch (error) {
    console.error('Fix failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

fix();
