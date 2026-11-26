/**
 * Migration: Add "Masters India" to the thirdpartyproviders collection.
 *
 * Masters India is the primary e-invoice / e-way bill provider (Fynamics is the backup).
 * The provider document is what chargeable API-usage logging looks up by name
 * (see logApiCall in modules/sales/invoice/eInvoice.service.js), and it is the record
 * ThirdPartyApiPackage documents reference for per-call pricing.
 *
 * Idempotent: does nothing if a provider named "Masters India" already exists.
 * Defaults to a dry run. Pass --apply to actually write to the database.
 *
 * Usage:
 *   node migrations/addMastersIndiaThirdPartyProvider-remove.js            (dry run)
 *   node migrations/addMastersIndiaThirdPartyProvider-remove.js --apply    (writes to DB)
 */
const { getConnection } = require('../config/db');
const { THIRD_PARTY_PROVIDERS } = require('../utils/enum');

const PROVIDER = {
  name: THIRD_PARTY_PROVIDERS.MASTERS_INDIA,
  description: 'Masters India Private Limited - GSP for NIC e-invoice and e-way bill APIs',
  website: 'https://mastersindia.co',
  isActive: true,
};

async function run() {
  const { client, books } = await getConnection();

  try {
    const apply = process.argv.slice(2).includes('--apply');
    const collection = books.collection('thirdpartyproviders');

    const existing = await collection.findOne({ name: PROVIDER.name });
    if (existing) {
      console.log(
        `Provider "${PROVIDER.name}" already exists (_id=${existing._id}, isActive=${existing.isActive}). Nothing to do.`,
      );
      return;
    }

    if (!apply) {
      console.log(`[dry run] Would insert provider: ${JSON.stringify(PROVIDER)}`);
      console.log('Re-run with --apply to write.');
      return;
    }

    const now = new Date();
    const result = await collection.insertOne({ ...PROVIDER, createdAt: now, updatedAt: now });
    console.log(`Inserted provider "${PROVIDER.name}" (_id=${result.insertedId}).`);
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

run()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
