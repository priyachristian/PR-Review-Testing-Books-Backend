/**
 * Migration: Add "Masters India" API packages (billing) to the thirdpartyapipackages collection.
 *
 * Usage logging (logApiCall in modules/sales/invoice/eInvoice.service.js) looks up the package by
 * provider + packageName and stamps chargeAmount (salesCost) and costAmount (purchaseCost) on each log.
 * Without a Masters India package, its calls are logged with no charge.
 *
 * For every active Fynamics package this creates the same packageName for Masters India:
 *   - salesCost  = Fynamics salesCost, so the customer price does not depend on which provider served the call
 *   - purchaseCost = MASTERS_INDIA_PURCHASE_COST (what ABSS pays Masters India per call)
 *
 * Requires the "Masters India" provider record (run addMastersIndiaThirdPartyProvider-remove.js first).
 * Idempotent: a package that already exists for Masters India is left untouched.
 * Defaults to a dry run. Pass --apply to write.
 *
 * Usage:
 *   node migrations/addMastersIndiaApiPackages-remove.js          (dry run)
 *   node migrations/addMastersIndiaApiPackages-remove.js --apply  (writes to DB)
 */
const { getConnection } = require('../config/db');
const { THIRD_PARTY_PROVIDERS } = require('../utils/enum');

const MASTERS_INDIA_PURCHASE_COST = 0.24;

const parseArgs = argv => ({ apply: argv.includes('--apply') });

async function run() {
  const { client, books } = await getConnection();

  try {
    const { apply } = parseArgs(process.argv.slice(2));
    const providers = books.collection('thirdpartyproviders');
    const packages = books.collection('thirdpartyapipackages');

    const mastersIndia = await providers.findOne({ name: THIRD_PARTY_PROVIDERS.MASTERS_INDIA });
    const fynamics = await providers.findOne({ name: THIRD_PARTY_PROVIDERS.FYNAMICS });
    if (!mastersIndia)
      throw new Error('Provider "Masters India" not found. Run addMastersIndiaThirdPartyProvider-remove.js first.');
    if (!fynamics) throw new Error('Provider "Fynamics" not found. Nothing to copy packages from.');

    const source = await packages.find({ providerId: fynamics._id, isActive: true }).toArray();
    const existing = await packages.find({ providerId: mastersIndia._id }).toArray();
    const existingNames = new Set(existing.map(item => item.packageName));

    const now = new Date();
    const toInsert = source
      .filter(item => !existingNames.has(item.packageName))
      .map(item => ({
        providerId: mastersIndia._id,
        packageName: item.packageName,
        salesCost: item.salesCost,
        purchaseCost: MASTERS_INDIA_PURCHASE_COST,
        currency: item.currency || 'INR',
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }));

    source.forEach(item => {
      const state = existingNames.has(item.packageName) ? 'exists, skipped' : 'to create';
      console.log(`${item.packageName}: salesCost=${item.salesCost} (${state})`);
    });
    if (toInsert.length === 0) {
      console.log('Nothing to do.');
      return;
    }
    if (!apply) {
      console.log(
        `[dry run] Would insert ${toInsert.length} package(s): ${JSON.stringify(toInsert.map(({ packageName, salesCost, purchaseCost: cost }) => ({ packageName, salesCost, purchaseCost: cost })))}`,
      );
      console.log('Re-run with --apply to write.');
      return;
    }

    const result = await packages.insertMany(toInsert);
    console.log(`Inserted ${result.insertedCount} package(s) for "${THIRD_PARTY_PROVIDERS.MASTERS_INDIA}".`);
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
