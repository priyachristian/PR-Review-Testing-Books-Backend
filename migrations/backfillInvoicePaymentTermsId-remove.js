/**
 * Backfills Invoice.paymentTermsId from Invoice.terms.
 *
 * Invoice historically stored its payment terms as a plain enum string on `terms`
 * (e.g. 'Net 30'), separate from every other transactional model (Customer, SalesOrder,
 * PurchaseOrder, Bill, GrpoOrder, RecurringInvoice, RecurringBill), which already got a
 * `paymentTermsId` ref backfilled by migrations/backfillPaymentTermsId-remove.js. Invoice has since
 * gained the same `paymentTermsId` field, so this does the same resolution for it: for each
 * invoice, look up that company's PaymentTerm whose name matches `terms` and write its _id
 * into `paymentTermsId`.
 *
 * Matching is case-insensitive and trimmed: `terms` is constrained to the PAYMENT_TERMS enum
 * (e.g. 'Due On Receipt'), while PaymentTerm.name was seeded verbatim from the requested list
 * (e.g. 'Due on Receipt') — casing differs on that one term, so an exact match would silently
 * miss it.
 *
 * Only writes a paymentTermsId that is missing or doesn't already match the resolved term, so
 * re-running is safe. A `terms` value with no matching PaymentTerm for that company is reported
 * and left untouched rather than guessed at.
 *
 * Run: node migrations/backfillInvoicePaymentTermsId-remove.js                      (report, all companies)
 *      node migrations/backfillInvoicePaymentTermsId-remove.js <companyId>           (report, one company)
 *      node migrations/backfillInvoicePaymentTermsId-remove.js --apply               (write, all companies)
 *      node migrations/backfillInvoicePaymentTermsId-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const normalize = name => (name || '').trim().toLowerCase();

const buildTermsIndex = paymentTermDocs => {
  const index = new Map();
  paymentTermDocs.forEach(term => {
    index.set(`${term.companyId.toString()}::${normalize(term.name)}`, term._id);
  });
  return index;
};

const resolveTermId = (index, companyId, name) => {
  if (!companyId || !name) return null;
  return index.get(`${companyId.toString()}::${normalize(name)}`) || null;
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

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    const paymentTermDocs = await db.booksCrm.collection('paymentterms').find(scope).project({ companyId: 1, name: 1 }).toArray();
    const termsIndex = buildTermsIndex(paymentTermDocs);
    console.log(`Loaded ${paymentTermDocs.length} payment term(s) to match against.\n`);

    const collection = db.books.collection('invoices');
    const query = { ...scope, terms: { $nin: [null, ''] } };
    const docs = await collection.find(query).project({ companyId: 1, terms: 1, paymentTermsId: 1 }).toArray();

    let written = 0;
    const unmatched = new Map(); // "companyId::name" -> count

    const ops = [];
    docs.forEach(doc => {
      const termId = resolveTermId(termsIndex, doc.companyId, doc.terms);
      if (!termId) {
        const key = `${doc.companyId?.toString()}::${doc.terms}`;
        unmatched.set(key, (unmatched.get(key) || 0) + 1);
        return;
      }
      if (doc.paymentTermsId && doc.paymentTermsId.toString() === termId.toString()) return;
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { paymentTermsId: termId } } } });
    });
    const pending = ops.length;

    if (apply && ops.length) {
      const result = await collection.bulkWrite(ops, { ordered: false });
      written = result.modifiedCount;
    }

    console.log(
      `Invoice            scanned: ${String(docs.length).padStart(5)}   pending: ${String(pending).padStart(5)}` +
        (apply ? `   written: ${String(written).padStart(5)}` : ''),
    );

    if (unmatched.size) {
      console.log(`\nUNMATCHED terms VALUES (no PaymentTerm found for that company) — ${unmatched.size} distinct`);
      [...unmatched.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .forEach(([key, count]) => {
          const [companyId, name] = key.split('::');
          console.log(`   company ${companyId}  "${name}"  x${count}`);
        });
      if (unmatched.size > 30) console.log(`   ... and ${unmatched.size - 30} more`);
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    console.log('\nInvoice.paymentTermsId backfilled.\n');
  } catch (error) {
    console.error('Invoice paymentTermsId backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
