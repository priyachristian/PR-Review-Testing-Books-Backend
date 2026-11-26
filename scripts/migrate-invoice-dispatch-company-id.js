/**
 * Backfills InvoiceDispatch.companyId from its linked Invoice, for rows created
 * before companyId existed on the model. New dispatches already persist it.
 *
 *   node scripts/migrate-invoice-dispatch-company-id.js          (dry-run)
 *   node scripts/migrate-invoice-dispatch-company-id.js --apply
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const { getConnection } = require('../config/db');

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();
    const dispatchColl = db.books.collection('invoicedispatches');
    const invoiceColl = db.books.collection('invoices');

    const dispatches = await dispatchColl
      .find({ $or: [{ companyId: { $exists: false } }, { companyId: null }] })
      .project({ _id: 1, invoiceId: 1 })
      .toArray();

    console.log(`Dispatches missing companyId: ${dispatches.length}`);
    if (dispatches.length === 0) return;

    const uniqueInvoiceIds = [];
    const seen = new Set();
    for (const d of dispatches) {
      const key = String(d.invoiceId);
      if (d.invoiceId && !seen.has(key)) {
        seen.add(key);
        uniqueInvoiceIds.push(d.invoiceId);
      }
    }

    const invoices = await invoiceColl
      .find({ _id: { $in: uniqueInvoiceIds } })
      .project({ _id: 1, companyId: 1 })
      .toArray();
    const companyByInvoice = new Map(invoices.map(inv => [String(inv._id), inv.companyId]));

    const updates = [];
    const orphans = [];
    for (const d of dispatches) {
      const companyId = companyByInvoice.get(String(d.invoiceId));
      if (!companyId) {
        orphans.push(d._id);
        continue;
      }
      updates.push({ updateOne: { filter: { _id: d._id }, update: { $set: { companyId } } } });
    }

    console.log(`Resolvable: ${updates.length}, Orphaned (invoice/companyId missing): ${orphans.length}`);
    if (orphans.length) console.log('Orphan dispatch _ids:', orphans.map(String).join(', '));

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }
    if (updates.length === 0) return;

    const res = await dispatchColl.bulkWrite(updates, { ordered: false });
    console.log(`Updated: ${res.modifiedCount ?? 0}`);
  } finally {
    if (db?.client) await db.client.close();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
