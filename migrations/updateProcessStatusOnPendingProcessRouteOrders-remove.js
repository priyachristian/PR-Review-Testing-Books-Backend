/**
 * Sets the status of each process on PENDING PROCESS_ROUTE production orders from the quantities
 * already recorded on it, the way submitProcess() does, then derives the order's status:
 *   - processIN is worked out like submitProcess() does (first process = order quantity, later
 *     ones = previous process output); the stored processIN is not relied on
 *   - OUT + Rejection above 0 and OUT >= order quantity, or previous process done and
 *     OUT + Rejection >= processIN                                  -> process COMPLETED
 *   - OUT + Rejection above 0 otherwise                             -> process PARTIALLY_COMPLETED
 *   - nothing recorded, but startDatetime set and no endDatetime    -> process IN_PROGRESS (no history)
 *   - nothing recorded and not started                              -> process left as is
 *   - every process COMPLETED                                       -> order COMPLETED
 *   - otherwise, at least one process updated                       -> order PARTIAL
 *   - no process updated                                            -> order left untouched
 *
 * For each updated process:
 *   - startDatetime is set when missing (a process is only submitted after it starts), and
 *     endDatetime too for a COMPLETED one, because order progress is read from those dates
 *     elsewhere (syncProcessRouteOrderStatus, endProcess);
 *   - one submissionHistory entry is added when the process has none, shaped like the entry
 *     submitProcess() records (with the process's status), carrying the process's raw material
 *     use and scrap with their batches.
 * For the order, totalFgSubmittedQty (last process OUT) and totalFgRejectedQty (sum of process
 * rejections) are set the same way submitProcess() does.
 *
 * NOT done here: the stock / ledger posting that applyProcessRouteCompletionEffects() performs when
 * a process completes, and the sales order production status sync. This script only fixes the
 * recorded statuses, so run it only for orders whose stock effects were already booked. Run
 * migrations/syncSalesOrderProductionStatus.js afterwards for orders that became COMPLETED.
 *
 * Idempotent: updated orders are no longer PENDING, so a re-run skips them.
 *
 * Reports by default and writes only with --apply.
 *
 * Run: node migrations/updateProcessStatusOnPendingProcessRouteOrders-remove.js                      (report, all companies)
 *      node migrations/updateProcessStatusOnPendingProcessRouteOrders-remove.js <companyId>           (report, one company)
 *      node migrations/updateProcessStatusOnPendingProcessRouteOrders-remove.js <companyId> --apply   (write)
 *      node migrations/updateProcessStatusOnPendingProcessRouteOrders-remove.js --apply               (write, all companies)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const ORDER_STATUS_PENDING = 'PENDING';
const ORDER_STATUS_PARTIAL = 'PARTIAL';
const ORDER_STATUS_COMPLETED = 'COMPLETED';
const PROCESS_STATUS_COMPLETED = 'COMPLETED';
const PROCESS_STATUS_PARTIALLY_COMPLETED = 'PARTIALLY_COMPLETED';
const PROCESS_STATUS_IN_PROGRESS = 'IN_PROGRESS';
const PROCESS_ROUTE = 'PROCESS_ROUTE';
const MIGRATION_REMARKS = 'Added by migration for a fully submitted process';

const round3 = value => Math.round((value || 0) * 1000) / 1000;

const toSubmissionLines = (lines = []) =>
  lines.map(line => ({ item: line.item, value: line.value || 0, batches: line.batches || [] }));

// Walks the processes in order and decides each one's status the way submitProcess() does.
// The stored processIN is not trusted: submitProcess() recomputes it on every submit (first
// process = order quantity, later ones = previous process output), so legacy rows with a
// missing or stale processIN would otherwise never match. A process with any output or
// rejection recorded is COMPLETED when it produced the whole order quantity, or when the
// previous process is done and its input is fully accounted for; otherwise PARTIALLY_COMPLETED.
// A process with nothing recorded gets targetStatus null and is left as is.
const planProcesses = order => {
  const processes = order.processBased?.processes || [];
  const orderQuantity = round3(order.quantity);
  const plan = [];
  let previousDone = true;

  processes.forEach((proc, index) => {
    const effectiveIN = index === 0 ? orderQuantity : round3(processes[index - 1].processOUT);
    const totalOut = round3(proc.processOUT);
    const accountedFor = round3(totalOut + (proc.processRejection || 0));

    let targetStatus = null;
    if (accountedFor > 0) {
      const willComplete = totalOut >= orderQuantity || (previousDone && accountedFor >= effectiveIN);
      targetStatus = willComplete ? PROCESS_STATUS_COMPLETED : PROCESS_STATUS_PARTIALLY_COMPLETED;
    } else if (proc.startDatetime && !proc.endDatetime) {
      // Started (startProcess sets IN_PROGRESS) but nothing submitted yet.
      targetStatus = PROCESS_STATUS_IN_PROGRESS;
    }

    plan.push({ proc, index, effectiveIN, targetStatus });
    previousDone = (targetStatus || proc.status) === PROCESS_STATUS_COMPLETED || Boolean(proc.endDatetime);
  });

  return plan;
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
        status: ORDER_STATUS_PENDING,
      })
      .project({
        productionOrderCode: 1,
        companyId: 1,
        quantity: 1,
        createdBy: 1,
        updatedAt: 1,
        'processBased.processes._id': 1,
        'processBased.processes.processNo': 1,
        'processBased.processes.status': 1,
        'processBased.processes.startDatetime': 1,
        'processBased.processes.startedBy': 1,
        'processBased.processes.endDatetime': 1,
        'processBased.processes.processIN': 1,
        'processBased.processes.processOUT': 1,
        'processBased.processes.processRejection': 1,
        'processBased.processes.processRawMaterialInput': 1,
        'processBased.processes.scrapOutProcess': 1,
        'processBased.processes.submissionHistory._id': 1,
      })
      .toArray();

    console.log(`Pending PROCESS_ROUTE orders in scope: ${orders.length}`);

    const plans = [];
    let noProcesses = 0;
    let noMatch = 0;
    let toCompleted = 0;
    let toPartial = 0;
    let processesToUpdate = 0;
    let processesToComplete = 0;
    let processesToPartial = 0;
    let processesToInProgress = 0;

    for (const order of orders) {
      const processes = order.processBased?.processes || [];
      if (!processes.length) {
        noProcesses += 1;
        continue;
      }

      const plan = planProcesses(order);
      const matching = plan.filter(({ targetStatus }) => targetStatus);
      if (!matching.length) {
        noMatch += 1;
        continue;
      }

      const allCompleted = plan.every(({ proc, targetStatus }) => (targetStatus || proc.status) === PROCESS_STATUS_COMPLETED);
      // Any submitted quantity means the order is in progress, so it is at least PARTIAL.
      const newStatus = allCompleted ? ORDER_STATUS_COMPLETED : ORDER_STATUS_PARTIAL;

      if (allCompleted) toCompleted += 1;
      else toPartial += 1;
      processesToUpdate += matching.length;
      matching.forEach(({ targetStatus }) => {
        if (targetStatus === PROCESS_STATUS_COMPLETED) processesToComplete += 1;
        else if (targetStatus === PROCESS_STATUS_PARTIALLY_COMPLETED) processesToPartial += 1;
        else processesToInProgress += 1;
      });

      plans.push({ order, processes, plan, matching, newStatus });
    }

    console.log(`   no processes                   : ${noProcesses}`);
    console.log(`   nothing submitted on any process: ${noMatch}`);
    console.log(`   ${apply ? 'orders -> COMPLETED' : 'orders to COMPLETED'}           : ${toCompleted}`);
    console.log(`   ${apply ? 'orders -> PARTIAL' : 'orders to PARTIAL'}             : ${toPartial}`);
    console.log(`   ${apply ? 'processes updating' : 'processes to update'}        : ${processesToUpdate}`);
    console.log(`      -> COMPLETED               : ${processesToComplete}`);
    console.log(`      -> PARTIALLY_COMPLETED     : ${processesToPartial}`);
    console.log(`      -> IN_PROGRESS             : ${processesToInProgress}`);

    if (plans.length) {
      console.log('\nOrders affected:');
      plans.forEach(({ order, matching, newStatus }) => {
        const detail = matching
          .map(
            ({ proc, targetStatus, effectiveIN }) =>
              `${proc.processNo || proc._id}(${proc.status || 'unset'} -> ${targetStatus}, IN ${proc.processIN ?? 'unset'} -> ${effectiveIN}, OUT ${proc.processOUT || 0}, rej ${proc.processRejection || 0}${proc.submissionHistory?.length ? '' : ', +history'})`,
          )
          .join(', ');
        console.log(`   ${order._id} (${order.productionOrderCode || 'no code'}) PENDING -> ${newStatus}: ${detail}`);
      });
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to update.\n');
      return;
    }

    let ordersUpdated = 0;
    for (const { order, processes, plan, matching, newStatus } of plans) {
      const fallbackDate = order.updatedAt || new Date();
      const set = {
        status: newStatus,
        totalFgSubmittedQty: round3(processes[processes.length - 1]?.processOUT),
        totalFgRejectedQty: round3(processes.reduce((sum, p) => sum + (p.processRejection || 0), 0)),
      };
      const push = {};

      // submitProcess() also sets the next process's input to this process's output.
      const matchedIndexes = new Set(matching.map(({ index }) => index));
      plan.forEach(({ proc, index, effectiveIN }) => {
        if (matchedIndexes.has(index) || matchedIndexes.has(index - 1)) {
          set[`processBased.processes.${index}.processIN`] = effectiveIN;
        }
      });

      for (const { proc, index, targetStatus, effectiveIN } of matching) {
        const base = `processBased.processes.${index}`;
        const isCompleted = targetStatus === PROCESS_STATUS_COMPLETED;
        const submissionDate = proc.endDatetime || fallbackDate;

        set[`${base}.status`] = targetStatus;
        // A process can only be submitted after it was started; only a completed one has ended.
        if (!proc.startDatetime) set[`${base}.startDatetime`] = submissionDate;
        if (isCompleted && !proc.endDatetime) set[`${base}.endDatetime`] = submissionDate;

        // An IN_PROGRESS process has nothing submitted yet, so there is no submission to record.
        if (targetStatus !== PROCESS_STATUS_IN_PROGRESS && !proc.submissionHistory?.length) {
          push[`${base}.submissionHistory`] = {
            _id: new ObjectId(),
            submissionDate,
            submittedBy: proc.startedBy || order.createdBy,
            status: targetStatus,
            isManuallyCompleted: false,
            processIN: effectiveIN,
            processOUT: round3(proc.processOUT),
            processRejection: round3(proc.processRejection),
            totalUsedUnit: 0,
            batches: [],
            processRawMaterialInput: toSubmissionLines(proc.processRawMaterialInput),
            manPower: [],
            scrapOutProcess: toSubmissionLines(proc.scrapOutProcess),
            additionalCost: [],
            remarks: MIGRATION_REMARKS,
          };
        }
      }

      const update = { $set: set };
      if (Object.keys(push).length) update.$push = push;

      // Guard on status and on the process ids so a concurrent change makes this a no-op.
      const filter = { _id: order._id, status: ORDER_STATUS_PENDING, productionManageMethod: PROCESS_ROUTE };
      matching.forEach(({ proc, index }) => {
        filter[`processBased.processes.${index}._id`] = proc._id;
      });

      const result = await productionOrders.updateOne(filter, update);
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
