/**
 * Backfill currency on booksCrm price lists where currency is missing/null.
 * Sets currency = company.baseCurrency.
 *
 *   node scripts/migrate-price-list-currency-id.js
 *   node scripts/migrate-price-list-currency-id.js --apply
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();
    const priceLists = db.booksCrm.collection('pricelists');

    const companies = await db.common
      .collection('companies')
      .find({ baseCurrency: { $ne: null } }, { projection: { _id: 1, baseCurrency: 1 } })
      .toArray();
    const baseByCompany = new Map(companies.map(c => [String(c._id), c.baseCurrency]));

    const docs = await priceLists
      .find({ $or: [{ currency: { $exists: false } }, { currency: null }] })
      .project({ _id: 1, companyId: 1, priceListName: 1, priceListCode: 1, currency: 1 })
      .toArray();

    const toUpdate = [];

    for (const doc of docs) {
      const baseCurrency = baseByCompany.get(String(doc.companyId));
      if (!baseCurrency) continue;
      toUpdate.push({ doc, baseCurrency });
    }

    console.log(`Price lists to update: ${toUpdate.length}`);

    toUpdate.forEach(({ doc, baseCurrency }, i) => {
      console.log(
        `${i + 1}. _id=${doc._id} name=${doc.priceListName ?? '-'} code=${doc.priceListCode ?? '-'} companyId=${doc.companyId} currency=${JSON.stringify(doc.currency)} → ${baseCurrency}`,
      );
    });

    if (docs.length > toUpdate.length) {
      console.log(`Skipped (no company baseCurrency): ${docs.length - toUpdate.length}`);
    }

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }

    if (toUpdate.length === 0) return;

    const res = await priceLists.bulkWrite(
      toUpdate.map(({ doc, baseCurrency }) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { currency: baseCurrency } },
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
