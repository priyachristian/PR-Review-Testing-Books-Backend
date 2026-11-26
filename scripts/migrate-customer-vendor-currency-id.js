/**
 * Backfill otherDetails.currency on booksCrm customers/vendors.
 * Legacy string otherDetails.currency / top-level currency → Currency ObjectId.
 *
 *   NODE_ENV=development node scripts/migrate-customer-vendor-currency-id.js
 *   NODE_ENV=development node scripts/migrate-customer-vendor-currency-id.js --dry-run
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');
const { ObjectId } = require('mongodb');

const dryRun = process.argv.includes('--dry-run');

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

function isObjectId(value) {
  if (!value) return false;
  return ObjectId.isValid(String(value)) && String(new ObjectId(String(value))) === String(value);
}

async function run() {
  const db = await getConnection();
  const customers = db.booksCrm.collection('customers');
  const baseCache = new Map();
  const summary = { updated: 0, skipped: 0 };

  try {
    const rows = await customers
      .find({
        $or: [{ 'Role.isCustomer': true }, { 'Role.isVendor': true }],
      })
      .project({ _id: 1, companyId: 1, otherDetails: 1, currency: 1, currencyId: 1 })
      .toArray();

    for (const row of rows) {
      if (!row.companyId) {
        summary.skipped += 1;
        continue;
      }

      if (isObjectId(row.otherDetails?.currency)) {
        if (!dryRun && (row.currency || row.currencyId)) {
          await customers.updateOne({ _id: row._id }, { $unset: { currency: '', currencyId: '' } });
        }
        summary.updated += 1;
        continue;
      }

      let currency = row.currency || row.currencyId || null;
      if (!currency) {
        currency = await getCurrencyIdByCode(db, row.companyId, row.otherDetails?.currency);
      }
      if (!currency) {
        currency = await getBaseCurrencyId(db, row.companyId, baseCache);
      }
      if (!currency) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        await customers.updateOne(
          { _id: row._id },
          {
            $set: { 'otherDetails.currency': currency },
            $unset: { currency: '', currencyId: '' },
          },
        );
      }
      summary.updated += 1;
    }

    console.log(dryRun ? 'Dry run complete.' : 'Migration complete.');
    console.log(`Updated: ${summary.updated}, Skipped: ${summary.skipped}`);
  } finally {
    await db.client.close();
  }
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
