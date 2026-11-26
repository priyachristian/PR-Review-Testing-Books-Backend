/**
 * Backfills invoices.eWayBill.linkedIrn on historical e-way bills.
 *
 * `linkedIrn` was introduced to let the e-invoice cancel guard (BOOKS-1297 fallback)
 * tell "e-way bill generated from this IRN" apart from "no e-way bill at all", without
 * relying on eWayBill.status alone. It is only ever written going forward, at generation
 * time, by fynamicsEInvoice.service.js. Invoices whose e-way bill was created before that
 * change have eWayBill.linkedIrn missing even though the e-way bill was in fact generated
 * together with / from that invoice's IRN (a company is on either the combined
 * E_INVOICE_AND_E_WAY_BILL flow or the standalone ONLY_E_WAY_BILL flow, never both, so any
 * invoice carrying both an eInvoice.irn and an eWayBill was necessarily on the combined flow).
 *
 * This sets eWayBill.linkedIrn = eInvoice.irn wherever both exist and linkedIrn is missing,
 * regardless of current eInvoice/eWayBill status, so the field is correct for history too
 * (cancelled e-way bills included), not just the currently-active guard path.
 *
 * One-time script, delete this file once the backfill has been applied in every environment.
 *
 * Run: node migrations/backfillEWayBillLinkedIrn-remove.js                    (dry run, all companies)
 *      node migrations/backfillEWayBillLinkedIrn-remove.js <companyId>         (dry run, one company)
 *      node migrations/backfillEWayBillLinkedIrn-remove.js <companyId> --apply (write)
 *      node migrations/backfillEWayBillLinkedIrn-remove.js --apply             (write, all companies)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const buildFilter = companyId => ({
  ...(companyId ? { companyId } : {}),
  'eInvoice.irn': { $exists: true, $ne: null },
  eWayBill: { $exists: true, $ne: null },
  $or: [{ 'eWayBill.linkedIrn': { $exists: false } }, { 'eWayBill.linkedIrn': null }],
});

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`Scope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode: APPLY' : 'Mode: dry run, pass --apply to write');

    const invoices = db.books.collection('invoices');
    const filter = buildFilter(targetCompanyId);

    const total = await invoices.countDocuments(filter);
    console.log(`\nInvoices needing eWayBill.linkedIrn backfill: ${total}`);

    if (!total) {
      console.log('Nothing to do.');
      return;
    }

    const preview = await invoices
      .find(filter)
      .project({ invoiceId: 1, companyId: 1, 'eInvoice.irn': 1, 'eWayBill.status': 1 })
      .toArray();
    preview.forEach(inv => {
      console.log(
        `   ${String(inv._id).padEnd(26)} invoice ${(inv.invoiceId || '?').toString().padEnd(14)} eWayBill.status=${inv.eWayBill?.status || '?'} -> linkedIrn=${inv.eInvoice?.irn}`,
      );
    });

    if (!apply) {
      console.log('\nNothing written. Re-run with --apply to backfill.');
      return;
    }

    // linkedIrn is set per-document from that same document's eInvoice.irn, so this needs
    // a per-invoice update rather than one updateMany with a static $set value.
    const cursor = invoices.find(filter).project({ 'eInvoice.irn': 1 });
    let written = 0;
    while (await cursor.hasNext()) {
      const inv = await cursor.next();
      const result = await invoices.updateOne({ _id: inv._id }, { $set: { 'eWayBill.linkedIrn': inv.eInvoice.irn } });
      written += result.modifiedCount;
    }

    console.log(`\nlinkedIrn backfilled on ${written} invoice(s).`);
  } catch (error) {
    console.error('linkedIrn backfill failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
