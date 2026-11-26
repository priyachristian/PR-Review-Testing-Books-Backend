/**
 * Backfill currency on booksCrm banks where currency is missing/null.
 * Sets currency = company.baseCurrency.
 *
 *   node scripts/migrate-bank-currency-id.js
 *   node scripts/migrate-bank-currency-id.js --apply
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();
    const banks = db.booksCrm.collection('banks');

    const companies = await db.common
      .collection('companies')
      .find({ baseCurrency: { $ne: null } }, { projection: { _id: 1, baseCurrency: 1 } })
      .toArray();
    const baseByCompany = new Map(companies.map(c => [String(c._id), c.baseCurrency]));

    const docs = await banks
      .find({ $or: [{ currency: { $exists: false } }, { currency: null }] })
      .project({ _id: 1, companyId: 1, accountName: 1, accountCode: 1, bankName: 1, currency: 1 })
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

    console.log(`Banks to update: ${toUpdate.length}`);
    console.log(`Skipped: ${skipped.length}\n`);

    toUpdate.forEach(({ doc, baseCurrency }, i) => {
      console.log(
        `${i + 1}. _id=${doc._id} accountName=${doc.accountName ?? '-'} accountCode=${doc.accountCode ?? '-'} bankName=${doc.bankName ?? '-'} companyId=${doc.companyId} currency=${JSON.stringify(doc.currency)} → ${baseCurrency}`,
      );
    });

    if (skipped.length > 0) {
      console.log('\nSkipped (no company baseCurrency):');
      skipped.forEach((doc, i) => {
        console.log(`${i + 1}. _id=${doc._id} accountName=${doc.accountName ?? '-'} companyId=${doc.companyId}`);
      });
    }

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }

    if (toUpdate.length === 0) return;

    const res = await banks.bulkWrite(
      toUpdate.map(({ doc, baseCurrency }) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { currency: baseCurrency } },
        },
      })),
      { ordered: false },
    );

    console.log(`\nUpdated: ${res.modifiedCount ?? 0}`);
  } finally {
    if (db?.client) await db.client.close();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
