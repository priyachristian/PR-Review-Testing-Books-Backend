/**
 * Fixes PARTIAL PROCESS_ROUTE production orders where a process was started before it had any input.
 *
 * A process is wrongly started when:
 *   - the previous process is IN_PROGRESS (so it has not passed anything on yet), and
 *   - this process has 0 (or no) processIN, and
 *   - this process has a startDatetime, and
 *   - nothing is recorded on it (no output, rejection or submission history), so resetting loses no work.
 *
 * Such a process is put back to untouched, the way removing a submission does it:
 *   - status -> PENDING
 *   - startDatetime and startedBy removed
 *
 * The order status is not changed: the previous process is IN_PROGRESS with its own startDatetime,
 * so the order stays PARTIAL.
 *
 * Idempotent: a reset process no longer has a startDatetime, so a re-run skips it.
 *
 * Reports by default and writes only with --apply.
 *
 * Run: node migrations/resetWronglyStartedNextProcessOnPartialProcessRouteOrders-remove.js                      (report, all companies)
 *      node migrations/resetWronglyStartedNextProcessOnPartialProcessRouteOrders-remove.js <companyId>           (report, one company)
 *      node migrations/resetWronglyStartedNextProcessOnPartialProcessRouteOrders-remove.js <companyId> --apply   (write)
 *      node migrations/resetWronglyStartedNextProcessOnPartialProcessRouteOrders-remove.js --apply               (write, all companies)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const ORDER_STATUS_PARTIAL = 'PARTIAL';
const PROCESS_STATUS_PENDING = 'PENDING';
const PROCESS_STATUS_IN_PROGRESS = 'IN_PROGRESS';
const PROCESS_ROUTE = 'PROCESS_ROUTE';

const hasNothingRecorded = proc => !(proc.processOUT || 0) && !(proc.processRejection || 0) && !proc.submissionHistory?.length;

// Returns the processes (by index) that are started although the previous one is still IN_PROGRESS
// and they have no input and nothing recorded.
const findWronglyStarted = processes => {
  const wrong = [];
  processes.forEach((proc, index) => {
    if (index === 0) return;
    const previous = processes[index - 1];
    if (previous.status !== PROCESS_STATUS_IN_PROGRESS) return;
    if ((proc.processIN || 0) !== 0) return;
    if (!proc.startDatetime) return;
    if (!hasNothingRecorded(proc)) return;
    wrong.push({ proc, index, previous });
  });
  return wrong;
};

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};

    console.log(`\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode: APPLYING CHANGES\n' : 'Mode: report only — pass --apply to write\n');

    const productionOrders = db.books.collection('productionorders');

    const orders = await productionOrders
      .find({
        ...scope,
        productionManageMethod: PROCESS_ROUTE,
        status: ORDER_STATUS_PARTIAL,
      })
      .project({
        productionOrderCode: 1,
        'processBased.processes._id': 1,
        'processBased.processes.processNo': 1,
        'processBased.processes.status': 1,
        'processBased.processes.startDatetime': 1,
        'processBased.processes.processIN': 1,
        'processBased.processes.processOUT': 1,
        'processBased.processes.processRejection': 1,
        'processBased.processes.submissionHistory._id': 1,
      })
      .toArray();

    console.log(`PARTIAL PROCESS_ROUTE orders in scope: ${orders.length}`);

    const plans = [];
    let processesToReset = 0;

    for (const order of orders) {
      const wrong = findWronglyStarted(order.processBased?.processes || []);
      if (!wrong.length) continue;
      processesToReset += wrong.length;
      plans.push({ order, wrong });
    }

    console.log(`   orders affected                : ${plans.length}`);
    console.log(`   ${apply ? 'processes resetting' : 'processes to reset'}       : ${processesToReset}`);

    if (plans.length) {
      console.log('\nOrders affected:');
      plans.forEach(({ order, wrong }) => {
        const detail = wrong
          .map(
            ({ proc, previous }) =>
              `${proc.processNo || proc._id}(${proc.status || 'unset'} -> ${PROCESS_STATUS_PENDING}, IN ${proc.processIN ?? 'unset'}, started ${proc.startDatetime.toISOString?.() || proc.startDatetime}, after ${previous.processNo || previous._id} IN_PROGRESS)`,
          )
          .join(', ');
        console.log(`   ${order._id} (${order.productionOrderCode || 'no code'}): ${detail}`);
      });
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to update.\n');
      return;
    }

    let ordersUpdated = 0;
    for (const { order, wrong } of plans) {
      const set = {};
      const unset = {};
      // Guard on status and on the process ids / state so a concurrent change makes this a no-op.
      const filter = { _id: order._id, status: ORDER_STATUS_PARTIAL, productionManageMethod: PROCESS_ROUTE };

      wrong.forEach(({ proc, index, previous }) => {
        const base = `processBased.processes.${index}`;
        set[`${base}.status`] = PROCESS_STATUS_PENDING;
        unset[`${base}.startDatetime`] = '';
        unset[`${base}.startedBy`] = '';
        filter[`${base}._id`] = proc._id;
        filter[`${base}.startDatetime`] = { $exists: true, $ne: null };
        filter[`processBased.processes.${index - 1}.status`] = previous.status;
      });

      const result = await productionOrders.updateOne(filter, { $set: set, $unset: unset });
      ordersUpdated += result.modifiedCount;
    }

    console.log(`\nWRITTEN\n   orders updated: ${ordersUpdated}`);
    console.log('\nMigration completed.\n');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
