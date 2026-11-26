/**
 * Backfill currency, exchangeRate, and decimalPlaces on all transaction collections.
 * - Missing currency → company.baseCurrency, exchangeRate = 1, decimalPlaces from currency master
 * - Has currency but missing decimalPlaces → decimalPlaces from that currency master
 *
 *   node scripts/migrate-transaction-currency-default.js          (dry-run)
 *   node scripts/migrate-transaction-currency-default.js --apply  (write)
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

const COLLECTIONS = [
  { db: 'booksCrm', name: 'quotes' },
  { db: 'booksCrm', name: 'salesorders' },
  { db: 'books', name: 'invoices' },
  { db: 'books', name: 'deliverychallans' },
  { db: 'books', name: 'creditnotes' },
  { db: 'books', name: 'recurringinvoices' },
  { db: 'books', name: 'purchaseorders' },
  { db: 'books', name: 'grpoorders' },
  { db: 'books', name: 'bills' },
  { db: 'books', name: 'debitnotes' },
  { db: 'books', name: 'recurringbills' },
  { db: 'books', name: 'expenses' },
  { db: 'books', name: 'recurringexpenses' },
];

const DEFAULT_DECIMAL_PLACES = 2;

function isMissing(value) {
  return value === null || value === undefined;
}

function decimalPlacesFor(currencyById, currencyId) {
  const row = currencyById.get(String(currencyId));
  return row?.decimalPlaces ?? DEFAULT_DECIMAL_PLACES;
}

function currencyCode(currencyById, currencyId) {
  return currencyById.get(String(currencyId))?.code || String(currencyId);
}

async function migrateCollection(db, target, baseByCompany, currencyById, apply) {
  const coll = db[target.db].collection(target.name);

  const docs = await coll
    .find({
      $or: [{ currency: { $exists: false } }, { currency: null }, { decimalPlaces: { $exists: false } }, { decimalPlaces: null }],
    })
    .project({ _id: 1, companyId: 1, currency: 1, exchangeRate: 1, decimalPlaces: 1 })
    .toArray();

  const toUpdate = [];
  let skipped = 0;

  for (const doc of docs) {
    const baseCurrency = baseByCompany.get(String(doc.companyId));
    const currencyId = doc.currency || baseCurrency;

    if (!currencyId) {
      skipped += 1;
      continue;
    }

    const $set = {};

    if (isMissing(doc.currency)) {
      $set.currency = currencyId;
      $set.exchangeRate = 1;
    }

    if (isMissing(doc.decimalPlaces)) {
      $set.decimalPlaces = decimalPlacesFor(currencyById, currencyId);
    }

    if (Object.keys($set).length === 0) continue;

    toUpdate.push({ doc, $set, currencyId });
  }

  console.log(`\n--- ${target.db}.${target.name} ---`);
  console.log(`  To update: ${toUpdate.length}`);
  if (skipped > 0) {
    console.log(`  Skipped (no company baseCurrency): ${skipped}`);
  }

  toUpdate.forEach(({ doc, $set, currencyId }, i) => {
    const parts = [];
    if ($set.currency) parts.push(`currency → ${currencyCode(currencyById, currencyId)}`);
    if ($set.exchangeRate != null) parts.push(`exchangeRate → ${$set.exchangeRate}`);
    if ($set.decimalPlaces != null) parts.push(`decimalPlaces → ${$set.decimalPlaces}`);
    console.log(`  ${i + 1}. _id=${doc._id} companyId=${doc.companyId} | ${parts.join(', ')}`);
  });

  if (!apply || toUpdate.length === 0) {
    return 0;
  }

  const res = await coll.bulkWrite(
    toUpdate.map(({ doc, $set }) => ({
      updateOne: { filter: { _id: doc._id }, update: { $set } },
    })),
    { ordered: false },
  );

  const updated = res.modifiedCount ?? 0;
  console.log(`  Updated: ${updated}`);
  return updated;
}

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();

    const [companies, currencyRows] = await Promise.all([
      db.common
        .collection('companies')
        .find({ baseCurrency: { $ne: null } }, { projection: { _id: 1, baseCurrency: 1 } })
        .toArray(),
      db.common
        .collection('currencies')
        .find({}, { projection: { _id: 1, code: 1, decimalPlaces: 1 } })
        .toArray(),
    ]);

    const baseByCompany = new Map(companies.map(c => [String(c._id), c.baseCurrency]));
    const currencyById = new Map(currencyRows.map(c => [String(c._id), c]));

    console.log(`[Transaction currency] ${COLLECTIONS.length} collections${apply ? '' : ' (dry-run)'}`);

    let totalUpdated = 0;

    for (const target of COLLECTIONS) {
      totalUpdated += await migrateCollection(db, target, baseByCompany, currencyById, apply);
    }

    if (!apply) {
      console.log('\nDry-run only. Re-run with --apply to write.');
      return;
    }

    console.log(`\nTotal updated across all collections: ${totalUpdated}`);
  } finally {
    if (db?.client) await db.client.close();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
