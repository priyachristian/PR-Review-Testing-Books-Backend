/**
 * Backfills paymentTermsId wherever a model stores paymentTerms as a plain/enum string next to
 * a separate paymentTermsId ref. Now that migrations/seedDefaultPaymentTerms.js has seeded
 * PaymentTerm per company, this resolves each document's existing paymentTerms value against
 * that company's PaymentTerm.name and writes the matching _id into paymentTermsId.
 *
 * Matching is case-insensitive and trimmed: the transactional models constrain paymentTerms to
 * the PAYMENT_TERMS enum (e.g. 'Due On Receipt'), while PaymentTerm.name was seeded verbatim
 * from the requested list (e.g. 'Due on Receipt') — casing differs on that one term, so an
 * exact match would silently miss it.
 *
 * Covers, per D:\Janvi\abss-models\src\models:
 *   Customer          (books-crm/customer.model.js)   -> paymentTerms, branch[].paymentTerms
 *   SalesOrder        (books-crm/salesOrder.model.js)  -> paymentTerms
 *   PurchaseOrder     (books/purchaseOrder.model.js)   -> paymentTerms
 *   Bill              (books/bill.model.js)            -> paymentTerms
 *   GrpoOrder         (books/grpoOrder.model.js)        -> paymentTerms
 *   RecurringInvoice  (books/recurringInvoice.model.js) -> paymentTerms
 *   RecurringBill     (books/recurringBill.model.js)    -> paymentTerms
 *   CompanySettings   (common/companySettings.model.js) -> salesCreditLimit.paymentTerms,
 *                                                          salesCreditLimit.branch[].paymentTerms,
 *                                                          purchaseCreditLimit.paymentTerms,
 *                                                          purchaseCreditLimit.branch[].paymentTerms
 *
 * Only writes a paymentTermsId that is missing or doesn't already match the resolved term, so
 * re-running is safe. A paymentTerms value with no matching PaymentTerm for that company is
 * reported and left untouched rather than guessed at.
 *
 * Run: node migrations/backfillPaymentTermsId-remove.js                      (report, all companies)
 *      node migrations/backfillPaymentTermsId-remove.js <companyId>           (report, one company)
 *      node migrations/backfillPaymentTermsId-remove.js --apply               (write, all companies)
 *      node migrations/backfillPaymentTermsId-remove.js <companyId> --apply   (write, one company)
 */
const _ = require('lodash');
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const SOURCES = [
  { db: 'booksCrm', collection: 'customers', label: 'Customer', scalarPaths: ['paymentTerms'], arrayPaths: ['branch'] },
  { db: 'booksCrm', collection: 'salesorders', label: 'SalesOrder', scalarPaths: ['paymentTerms'], arrayPaths: [] },
  { db: 'books', collection: 'purchaseorders', label: 'PurchaseOrder', scalarPaths: ['paymentTerms'], arrayPaths: [] },
  { db: 'books', collection: 'bills', label: 'Bill', scalarPaths: ['paymentTerms'], arrayPaths: [] },
  { db: 'books', collection: 'grpoorders', label: 'GrpoOrder', scalarPaths: ['paymentTerms'], arrayPaths: [] },
  { db: 'books', collection: 'recurringinvoices', label: 'RecurringInvoice', scalarPaths: ['paymentTerms'], arrayPaths: [] },
  { db: 'books', collection: 'recurringbills', label: 'RecurringBill', scalarPaths: ['paymentTerms'], arrayPaths: [] },
  {
    db: 'common',
    collection: 'companysettings',
    label: 'CompanySettings',
    scalarPaths: ['salesCreditLimit.paymentTerms', 'purchaseCreditLimit.paymentTerms'],
    arrayPaths: ['salesCreditLimit.branch', 'purchaseCreditLimit.branch'],
  },
];

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

    let totalScanned = 0;
    let totalPending = 0;
    let totalWritten = 0;
    const unmatched = new Map(); // "companyId::name" -> count

    for (const source of SOURCES) {
      const collection = db[source.db].collection(source.collection);
      const stats = { scanned: 0, pending: 0, written: 0 };

      for (const path of source.scalarPaths) {
        const idPath = path.replace(/paymentTerms$/, 'paymentTermsId');
        const query = { ...scope, [path]: { $nin: [null, ''] } };
        // eslint-disable-next-line no-await-in-loop
        const docs = await collection
          .find(query)
          .project({ companyId: 1, [path]: 1, [idPath]: 1 })
          .toArray();
        stats.scanned += docs.length;

        const ops = [];
        docs.forEach(doc => {
          const name = _.get(doc, path);
          const currentId = _.get(doc, idPath);
          const termId = resolveTermId(termsIndex, doc.companyId, name);
          if (!termId) {
            const key = `${doc.companyId?.toString()}::${name}`;
            unmatched.set(key, (unmatched.get(key) || 0) + 1);
            return;
          }
          if (currentId && currentId.toString() === termId.toString()) return;
          ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { [idPath]: termId } } } });
        });
        stats.pending += ops.length;

        if (apply && ops.length) {
          // eslint-disable-next-line no-await-in-loop
          const result = await collection.bulkWrite(ops, { ordered: false });
          stats.written += result.modifiedCount;
        }
      }

      for (const arrayPath of source.arrayPaths) {
        const query = { ...scope, [`${arrayPath}.paymentTerms`]: { $nin: [null, ''] } };
        // eslint-disable-next-line no-await-in-loop
        const docs = await collection
          .find(query)
          .project({ companyId: 1, [arrayPath]: 1 })
          .toArray();
        stats.scanned += docs.length;

        const ops = [];
        docs.forEach(doc => {
          const items = _.get(doc, arrayPath) || [];
          let changed = false;
          const updatedItems = items.map(item => {
            if (!item.paymentTerms) return item;
            const termId = resolveTermId(termsIndex, doc.companyId, item.paymentTerms);
            if (!termId) {
              const key = `${doc.companyId?.toString()}::${item.paymentTerms}`;
              unmatched.set(key, (unmatched.get(key) || 0) + 1);
              return item;
            }
            if (item.paymentTermsId && item.paymentTermsId.toString() === termId.toString()) return item;
            changed = true;
            return { ...item, paymentTermsId: termId };
          });
          if (!changed) return;
          ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { [arrayPath]: updatedItems } } } });
        });
        stats.pending += ops.length;

        if (apply && ops.length) {
          // eslint-disable-next-line no-await-in-loop
          const result = await collection.bulkWrite(ops, { ordered: false });
          stats.written += result.modifiedCount;
        }
      }

      totalScanned += stats.scanned;
      totalPending += stats.pending;
      totalWritten += stats.written;
      console.log(
        `${source.label.padEnd(18)} scanned: ${String(stats.scanned).padStart(5)}   pending: ${String(stats.pending).padStart(5)}` +
          (apply ? `   written: ${String(stats.written).padStart(5)}` : ''),
      );
    }

    if (unmatched.size) {
      console.log(`\nUNMATCHED paymentTerms VALUES (no PaymentTerm found for that company) — ${unmatched.size} distinct`);
      [...unmatched.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .forEach(([key, count]) => {
          const [companyId, name] = key.split('::');
          console.log(`   company ${companyId}  "${name}"  x${count}`);
        });
      if (unmatched.size > 30) console.log(`   ... and ${unmatched.size - 30} more`);
    }

    console.log(`\nTOTAL   scanned: ${totalScanned}   pending: ${totalPending}` + (apply ? `   written: ${totalWritten}` : ''));

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    console.log('\npaymentTermsId backfilled.\n');
  } catch (error) {
    console.error('paymentTermsId backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
