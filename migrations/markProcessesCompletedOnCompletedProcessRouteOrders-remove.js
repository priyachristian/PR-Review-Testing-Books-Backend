/**
 * Brings every process of COMPLETED PROCESS_ROUTE production orders in line with the order
 * having been completed. For each process that needs it:
 *   - processIN is set to processOUT + processRejection, so the process has no input left unaccounted;
 *   - status is set to COMPLETED (also when the field is missing);
 *   - one submissionHistory entry is added when the process has none, shaped like the entry
 *     submitProcess() records (processIN/OUT/Rejection, status COMPLETED, empty cost/material lists).
 *
 * Completed orders created before per-process status and submission history existed can carry
 * processes at PENDING / IN_PROGRESS / PARTIALLY_COMPLETED, which contradicts the order's status.
 *
 * Nothing else is written: dates, stock, ledger entries and the order itself are left as they are.
 * Idempotent: a process that already has status COMPLETED, processIN = OUT + Rejection and a
 * submission history is skipped, so it can be re-run safely.
 *
 * Reports by default and writes only with --apply.
 *
 * Run: node migrations/markProcessesCompletedOnCompletedProcessRouteOrders-remove.js                      (report, all companies)
 *      node migrations/markProcessesCompletedOnCompletedProcessRouteOrders-remove.js <companyId>           (report, one company)
 *      node migrations/markProcessesCompletedOnCompletedProcessRouteOrders-remove.js <companyId> --apply   (write)
 *      node migrations/markProcessesCompletedOnCompletedProcessRouteOrders-remove.js --apply               (write, all companies)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PRODUCTION_ORDER_STATUS_COMPLETED = 'COMPLETED';
const PROCESS_STATUS_COMPLETED = 'COMPLETED';
const PROCESS_ROUTE = 'PROCESS_ROUTE';
const MIGRATION_REMARKS = 'Added by migration for a completed process route order';

const round3 = value => Math.round((value || 0) * 1000) / 1000;

const toSubmissionLines = (lines = []) =>
  lines.map(line => ({ item: line.item, value: line.value || 0, batches: line.batches || [] }));

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
        status: PRODUCTION_ORDER_STATUS_COMPLETED,
      })
      .project({
        productionOrderCode: 1,
        companyId: 1,
        createdBy: 1,
        updatedAt: 1,
        'processBased.processes._id': 1,
        'processBased.processes.processNo': 1,
        'processBased.processes.status': 1,
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

    console.log(`Completed PROCESS_ROUTE orders in scope: ${orders.length}`);

    const changes = [];
    let noProcesses = 0;
    let upToDate = 0;
    const counts = { status: 0, processIN: 0, submission: 0 };

    for (const order of orders) {
      const processes = order.processBased?.processes || [];
      if (!processes.length) {
        noProcesses += 1;
        continue;
      }

      let orderHasChange = false;
      for (const proc of processes) {
        const expectedIN = round3((proc.processOUT || 0) + (proc.processRejection || 0));
        const needsStatus = proc.status !== PROCESS_STATUS_COMPLETED;
        const needsProcessIN = round3(proc.processIN) !== expectedIN;
        const needsSubmission = !proc.submissionHistory?.length;

        if (!needsStatus && !needsProcessIN && !needsSubmission) continue;

        orderHasChange = true;
        if (needsStatus) counts.status += 1;
        if (needsProcessIN) counts.processIN += 1;
        if (needsSubmission) counts.submission += 1;

        changes.push({
          order,
          proc,
          expectedIN,
          needsStatus,
          needsProcessIN,
          needsSubmission,
        });
      }

      if (!orderHasChange) upToDate += 1;
    }

    console.log(`   no processes                 : ${noProcesses}`);
    console.log(`   orders already up to date    : ${upToDate}`);
    console.log(`   ${apply ? 'processes updating' : 'processes to update'}        : ${changes.length}`);
    console.log(`      status -> COMPLETED       : ${counts.status}`);
    console.log(`      processIN = OUT + Rej     : ${counts.processIN}`);
    console.log(`      submission history added  : ${counts.submission}`);

    if (changes.length) {
      console.log('\nProcesses affected:');
      changes.forEach(({ order, proc, expectedIN, needsStatus, needsProcessIN, needsSubmission }) => {
        const parts = [];
        if (needsStatus) parts.push(`status ${proc.status || 'unset'} -> COMPLETED`);
        if (needsProcessIN) parts.push(`processIN ${proc.processIN ?? 'unset'} -> ${expectedIN}`);
        if (needsSubmission) parts.push('add submission history');
        console.log(
          `   ${order._id} (${order.productionOrderCode || 'no code'}) ${proc.processNo || proc._id}: ${parts.join('; ')}`,
        );
      });
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to update.\n');
      return;
    }

    let processesUpdated = 0;
    for (const { order, proc, expectedIN, needsSubmission } of changes) {
      const update = {
        $set: {
          'processBased.processes.$[p].status': PROCESS_STATUS_COMPLETED,
          'processBased.processes.$[p].processIN': expectedIN,
        },
      };

      if (needsSubmission) {
        update.$push = {
          'processBased.processes.$[p].submissionHistory': {
            _id: new ObjectId(),
            submissionDate: proc.endDatetime || order.updatedAt || new Date(),
            submittedBy: proc.startedBy || order.createdBy,
            status: PROCESS_STATUS_COMPLETED,
            isManuallyCompleted: false,
            processIN: expectedIN,
            processOUT: round3(proc.processOUT),
            processRejection: round3(proc.processRejection),
            totalUsedUnit: 0,
            batches: [],
            // The process's recorded raw material use and scrap (with their batches) are carried
            // into the entry, since this single entry stands in for all past submissions.
            processRawMaterialInput: toSubmissionLines(proc.processRawMaterialInput),
            manPower: [],
            scrapOutProcess: toSubmissionLines(proc.scrapOutProcess),
            additionalCost: [],
            remarks: MIGRATION_REMARKS,
          },
        };
      }

      const result = await productionOrders.updateOne(
        { _id: order._id, status: PRODUCTION_ORDER_STATUS_COMPLETED, productionManageMethod: PROCESS_ROUTE },
        update,
        { arrayFilters: [{ 'p._id': proc._id }] },
      );
      processesUpdated += result.modifiedCount;
    }

    console.log(`\nWRITTEN\n   processes updated: ${processesUpdated}`);
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
