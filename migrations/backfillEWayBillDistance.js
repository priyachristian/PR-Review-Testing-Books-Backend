/**
 * Backfills invoices.eWayBill.distance on standalone e-way bill records where distance was
 * stored as 0 due to a bug in persistStandaloneEWayBillResult.
 *
 * Root cause: the standalone path only read distance from the user-submitted ewbDtlsValues.Distance
 * and ignored the actual distance returned by Masters India in responseBody.results.message.alert
 * (e.g. "Distance between these two pincodes is 26, "). The e-invoice and by-IRN paths already
 * used distanceFromProviderInfo() to extract the distance from the API response; the standalone
 * path did not.
 *
 * Strategy: for every invoice with eWayBill.distance === 0 (missing), look up the matching
 * UserThirdPartyApiLog by referenceId (the invoice _id) where the endpoint is the standalone
 * e-way bill generate endpoint, and extract the actual distance from
 * responseBody.results.message.alert. If found and > 0, patch eWayBill.distance on the invoice.
 *
 * Run:
 *   node migrations/backfillEWayBillDistance.js                    (dry run, all companies)
 *   node migrations/backfillEWayBillDistance.js <companyId>         (dry run, one company)
 *   node migrations/backfillEWayBillDistance.js --apply             (write, all companies)
 *   node migrations/backfillEWayBillDistance.js <companyId> --apply (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

// Masters India standalone e-way bill generate endpoint (partial match).
const STANDALONE_EWAYBILL_ENDPOINT = 'ewayBillsGenerate';

/**
 * Extracts the distance integer from a Masters India standalone e-way bill alert string.
 * Handles both formats:
 *   - "Distance between these two pincodes is 26, "  (standalone alert)
 *   - "26 KM"                                        (e-invoice / by-IRN remarks)
 */
const extractDistance = alert => {
  if (typeof alert !== 'string' || !alert.trim()) return null;
  const match = alert.match(/(\d+)\s*KM/i) || alert.match(/distance\b.*?\bis\s+(\d+)/i);
  return match ? Number(match[1]) : null;
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

    console.log('='.repeat(70));
    console.log('Backfill: eWayBill.distance from Masters India API logs');
    console.log('='.repeat(70));
    console.log(`Scope : ${targetCompanyId ? targetCompanyId.toString() : 'ALL companies'}`);
    console.log(`Mode  : ${apply ? 'APPLY (writes enabled)' : 'DRY RUN — pass --apply to write'}`);
    console.log('');

    const invoices = db.books.collection('invoices');
    const apiLogs = db.books.collection('userthirdpartyapilogs');

    // Invoices that have an active standalone e-way bill with distance = 0.
    // eWayBill.linkedIrn being null/absent distinguishes standalone from by-IRN bills.
    const invoiceFilter = {
      ...(targetCompanyId ? { companyId: targetCompanyId } : {}),
      'eWayBill.eWayBillNo': { $exists: true, $ne: null },
      $or: [{ 'eWayBill.linkedIrn': { $exists: false } }, { 'eWayBill.linkedIrn': null }],
      $and: [{ $or: [{ 'eWayBill.distance': 0 }, { 'eWayBill.distance': { $exists: false } }, { 'eWayBill.distance': null }] }],
    };

    const candidateInvoices = await invoices
      .find(invoiceFilter)
      .project({ _id: 1, invoiceId: 1, companyId: 1, 'eWayBill.eWayBillNo': 1, 'eWayBill.distance': 1 })
      .toArray();

    console.log(`Candidate invoices (eWayBill present, linkedIrn absent, distance = 0): ${candidateInvoices.length}`);

    if (!candidateInvoices.length) {
      console.log('\nNothing to do.');
      return;
    }

    // Build a map of invoiceId -> API log for fast lookup.
    const invoiceIds = candidateInvoices.map(inv => inv._id);

    const logs = await apiLogs
      .find({
        referenceId: { $in: invoiceIds },
        referenceType: 'Invoice',
        isSuccess: true,
        endpoint: { $regex: STANDALONE_EWAYBILL_ENDPOINT, $options: 'i' },
      })
      .project({ referenceId: 1, responseBody: 1, endpoint: 1 })
      .toArray();

    // Last successful log per invoice (most recent generation).
    const logByInvoiceId = new Map();
    for (const log of logs) {
      const key = log.referenceId.toString();
      if (!logByInvoiceId.has(key)) {
        logByInvoiceId.set(key, log);
      }
    }

    console.log(`Matching API logs found: ${logByInvoiceId.size} of ${candidateInvoices.length}\n`);

    const rows = [];
    const toUpdate = [];

    for (const inv of candidateInvoices) {
      const log = logByInvoiceId.get(inv._id.toString());

      if (!log) {
        rows.push({
          invoiceId: inv.invoiceId || String(inv._id),
          companyId: String(inv.companyId),
          eWayBillNo: inv.eWayBill?.eWayBillNo ?? '-',
          storedDistance: inv.eWayBill?.distance ?? 0,
          resolvedDistance: '-',
          action: 'NO LOG FOUND',
        });
        continue;
      }

      const alert = log.responseBody?.results?.message?.alert;
      const resolved = extractDistance(alert);

      if (!resolved || resolved <= 0) {
        rows.push({
          invoiceId: inv.invoiceId || String(inv._id),
          companyId: String(inv.companyId),
          eWayBillNo: inv.eWayBill?.eWayBillNo ?? '-',
          storedDistance: inv.eWayBill?.distance ?? 0,
          resolvedDistance: resolved ?? 0,
          action: 'SKIP — distance not in alert',
        });
        continue;
      }

      rows.push({
        invoiceId: inv.invoiceId || String(inv._id),
        companyId: String(inv.companyId),
        eWayBillNo: inv.eWayBill?.eWayBillNo ?? '-',
        storedDistance: inv.eWayBill?.distance ?? 0,
        resolvedDistance: resolved,
        action: apply ? 'UPDATED' : 'WILL UPDATE',
      });

      toUpdate.push({ _id: inv._id, distance: resolved });
    }

    console.table(rows);

    if (!toUpdate.length) {
      console.log('\nNo invoices with a resolvable distance. Nothing to write.');
      return;
    }

    console.log(`\nInvoices with resolvable distance: ${toUpdate.length}`);

    if (!apply) {
      console.log('\nDry run — no changes written. Re-run with --apply to patch.');
      return;
    }

    let updated = 0;
    for (const { _id, distance } of toUpdate) {
      const result = await invoices.updateOne({ _id }, { $set: { 'eWayBill.distance': distance } });
      updated += result.modifiedCount;
    }

    console.log(`\nPatched eWayBill.distance on ${updated} invoice(s).`);
    console.log('Backfill completed successfully.');
  } catch (error) {
    console.error('Backfill failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
