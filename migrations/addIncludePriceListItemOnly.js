/**
 * Migration: Add `otherDetails.includePriceListItemOnly` field to all customers/vendors.
 *
 * Backfills `otherDetails.includePriceListItemOnly: false` on every customer document
 * (booksCrm.customers) that does not already have this field set.
 *
 * Usage:
 *   node migrations/addIncludePriceListItemOnly.js
 */
const { getConnection } = require('../config/db');

const FIELD = 'otherDetails.includePriceListItemOnly';
const DEFAULT_VALUE = false;

async function run() {
  const { client, booksCrm } = await getConnection();

  try {
    const customers = booksCrm.collection('customers');

    const filter = { [FIELD]: { $exists: false } };
    const totalCustomers = await customers.countDocuments({});
    const toUpdate = await customers.countDocuments(filter);

    console.log('--- Add Include Price List Item Only (Customers) ---');
    console.log(`Total customers scanned : ${totalCustomers}`);
    console.log(`Customers needing update: ${toUpdate}`);

    if (toUpdate === 0) {
      console.log('\nNothing to update.');
      return;
    }

    const result = await customers.updateMany(filter, { $set: { [FIELD]: DEFAULT_VALUE } });
    console.log(`\nUpdated ${result.modifiedCount} customer(s).`);
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = {
  up: run,
  down: async () => {
    console.log('This migration adds a new field; reverting would require unsetting it manually.');
  },
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
