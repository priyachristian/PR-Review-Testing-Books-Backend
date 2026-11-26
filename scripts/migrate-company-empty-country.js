/**
 * Sets empty company.address.country to India. Run before migrate-company-default-currencies.js.
 *
 *   node scripts/migrate-company-empty-country.js
 *   node scripts/migrate-company-empty-country.js --apply
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const { getConnection } = require('../config/db');

const INDIA = 'India';

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();
    const companiesColl = db.common.collection('companies');

    const companies = await companiesColl
      .find({
        $or: [{ 'address.country': { $exists: false } }, { 'address.country': null }, { 'address.country': '' }],
      })
      .project({ _id: 1, name: 1, companyName: 1, 'address.country': 1 })
      .toArray();

    console.log(`Companies to update: ${companies.length}`);
    companies.forEach((doc, i) => {
      console.log(
        `${i + 1}. _id=${doc._id} name=${doc.name ?? doc.companyName ?? '-'} country=${JSON.stringify(doc.address?.country)}`,
      );
    });

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }

    if (companies.length === 0) return;

    const res = await companiesColl.bulkWrite(
      companies.map(doc => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { 'address.country': INDIA } },
        },
      })),
      { ordered: false },
    );

    console.log(`Updated: ${res.modifiedCount ?? 0}`);
  } finally {
    if (db?.client) await db.client.close();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
