/**
 * Backfill currencyId on manual journals.
 * currency code → Currency doc, else company.baseCurrency. exchangeRate = null.
 * Does not remove legacy currency string.
 *
 *   NODE_ENV=development node scripts/migrate-manual-journal-currency-id.js
 *   NODE_ENV=development node scripts/migrate-manual-journal-currency-id.js --dry-run
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

const dryRun = process.argv.includes('--dry-run');

const missingCurrencyFilter = {
  $or: [{ currencyId: { $exists: false } }, { currencyId: null }],
};

async function getBaseCurrencyId(db, companyId, cache) {
  const key = String(companyId);
  if (cache.has(key)) return cache.get(key);

  const company = await db.common.collection('companies').findOne({ _id: companyId }, { projection: { baseCurrency: 1 } });
  const id = company?.baseCurrency || null;
  cache.set(key, id);
  return id;
}

async function getCurrencyIdByCode(db, companyId, code) {
  if (!code) return null;
  const normalized = String(code).trim().toUpperCase() === 'RMB' ? 'CNY' : String(code).trim().toUpperCase();
  const row = await db.common.collection('currencies').findOne({ companyId, code: normalized }, { projection: { _id: 1 } });
  return row?._id || null;
}

async function run() {
  const db = await getConnection();
  const journals = db.books.collection('manualjournals');
  const baseCache = new Map();
  let updated = 0;
  let skipped = 0;

  try {
    const rows = await journals.find(missingCurrencyFilter).project({ _id: 1, companyId: 1, currency: 1 }).toArray();

    for (const row of rows) {
      if (!row.companyId) {
        skipped += 1;
        continue;
      }

      let currencyId = await getCurrencyIdByCode(db, row.companyId, row.currency);
      if (!currencyId) {
        currencyId = await getBaseCurrencyId(db, row.companyId, baseCache);
      }
      if (!currencyId) {
        skipped += 1;
        continue;
      }

      if (!dryRun) {
        await journals.updateOne({ _id: row._id }, { $set: { currencyId, exchangeRate: null } });
      }
      updated += 1;
    }

    console.log(dryRun ? 'Dry run complete.' : 'Migration complete.');
    console.log(`Updated: ${updated}, Skipped: ${skipped}`);
  } finally {
    await db.client.close();
  }
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
