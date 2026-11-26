/**
 * Backfill currency + exchangeRate on payment docs where currency is missing/null.
 * Sets currency = company.baseCurrency. Runs paymentreceiveds then paymentmades.
 *
 *   node scripts/migrate-payment-currency-default.js
 *   node scripts/migrate-payment-currency-default.js --apply
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

const COLLECTIONS = [
  { db: 'booksCrm', name: 'paymentreceiveds', docIdField: 'paymentReceivedId' },
  { db: 'books', name: 'paymentmades', docIdField: 'paymentMadeId' },
];

async function migrateCollection(db, target, baseByCompany, apply) {
  const coll = db[target.db].collection(target.name);

  const docs = await coll
    .find({ $or: [{ currency: { $exists: false } }, { currency: null }] })
    .project({ _id: 1, companyId: 1, currency: 1, [target.docIdField]: 1 })
    .toArray();

  const toUpdate = [];
  const skipped = [];

  for (const doc of docs) {
    const baseCurrency = baseByCompany.get(String(doc.companyId));
    if (!baseCurrency) {
      skipped.push(doc);
      continue;
    }
    toUpdate.push({ doc, baseCurrency });
  }

  console.log(`\n--- ${target.db}.${target.name} ---`);
  console.log(`To update: ${toUpdate.length}`);
  console.log(`Skipped: ${skipped.length}`);

  toUpdate.forEach(({ doc, baseCurrency }, i) => {
    console.log(
      `${i + 1}. _id=${doc._id} ${target.docIdField}=${doc[target.docIdField] ?? '-'} companyId=${doc.companyId} currency=${JSON.stringify(doc.currency)} → ${baseCurrency}`,
    );
  });

  if (skipped.length > 0) {
    console.log('\nSkipped (no company baseCurrency):');
    skipped.forEach((doc, i) => {
      console.log(`${i + 1}. _id=${doc._id} ${target.docIdField}=${doc[target.docIdField] ?? '-'} companyId=${doc.companyId}`);
    });
  }

  if (!apply || toUpdate.length === 0) {
    return 0;
  }

  const res = await coll.bulkWrite(
    toUpdate.map(({ doc, baseCurrency }) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { currency: baseCurrency, exchangeRate: 1 } },
      },
    })),
    { ordered: false },
  );

  console.log(`Updated: ${res.modifiedCount ?? 0}`);
  return res.modifiedCount ?? 0;
}

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();

    const companies = await db.common
      .collection('companies')
      .find({ baseCurrency: { $ne: null } }, { projection: { _id: 1, baseCurrency: 1 } })
      .toArray();
    const baseByCompany = new Map(companies.map(c => [String(c._id), c.baseCurrency]));

    let totalUpdated = 0;

    for (const target of COLLECTIONS) {
      totalUpdated += await migrateCollection(db, target, baseByCompany, apply);
    }

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }

    console.log(`\nTotal updated: ${totalUpdated}`);
  } finally {
    if (db?.client) await db.client.close();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
