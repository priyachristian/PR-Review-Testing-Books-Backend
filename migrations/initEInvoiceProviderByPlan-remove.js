/**
 * Migration: bulk-initialize Company.eInvoiceProvider = MASTERS_INDIA for every company whose plan
 * already grants e-invoicing (Company.applicableFeature is E_INVOICE_AND_E_WAY_BILL or ONLY_E_WAY_BILL).
 * Batch equivalent of running setCompanyEInvoiceProvider-remove.js one company at a time.
 *
 * Companies without either feature are left untouched -- eInvoiceProvider being unset already
 * behaves as Fynamics (see providerConfig.service.js), so nothing needs writing for them.
 * Already-MASTERS_INDIA companies are skipped (idempotent).
 *
 * Masters India also needs company.gstNumber; this only warns about companies missing it, it
 * does not block them, since GSTIN can be added later.
 *
 * Defaults to a dry run. Pass --apply to actually write to the database.
 *
 * Usage:
 *   node migrations/initEInvoiceProviderByPlan-remove.js                                   (dry run, both features)
 *   node migrations/initEInvoiceProviderByPlan-remove.js --apply                            (writes)
 *   node migrations/initEInvoiceProviderByPlan-remove.js --feature=ONLY_E_WAY_BILL --apply   (restrict to one feature)
 */
const { getConnection } = require('../config/db');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { EINVOICE_PROVIDERS } = require('../utils/enum');

const ELIGIBLE_FEATURES = [PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL, PLAN_FEATURES.ONLY_E_WAY_BILL];

const parseArgs = argv => {
  const featureArg = argv.find(arg => arg.startsWith('--feature='))?.split('=')[1];
  if (featureArg && !ELIGIBLE_FEATURES.includes(featureArg)) {
    throw new Error(`--feature must be one of: ${ELIGIBLE_FEATURES.join(', ')}`);
  }
  return { apply: argv.includes('--apply'), features: featureArg ? [featureArg] : ELIGIBLE_FEATURES };
};

async function run() {
  const { client, common } = await getConnection();

  try {
    const { apply, features } = parseArgs(process.argv.slice(2));
    const companies = common.collection('companies');

    const eligible = await companies
      .find(
        { applicableFeature: { $in: features }, eInvoiceProvider: { $ne: EINVOICE_PROVIDERS.MASTERS_INDIA } },
        { projection: { name: 1, gstNumber: 1, applicableFeature: 1 } },
      )
      .toArray();

    console.log(`Feature(s): ${features.join(', ')}`);
    console.log(`${eligible.length} company/companies eligible and not yet on Masters India.`);

    const missingGstin = eligible.filter(c => !c.gstNumber);
    if (missingGstin.length) {
      console.log(
        `WARNING: ${missingGstin.length} of them have no GSTIN set. Masters India calls will fail for those until it is set:`,
      );
      missingGstin.forEach(c => console.log(`  - ${c.name} (${c._id})`));
    }

    if (eligible.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    if (!apply) {
      console.log('[dry run] Would set eInvoiceProvider: MASTERS_INDIA for:');
      eligible.forEach(c =>
        console.log(`  - ${c.name} (${c._id}) applicableFeature=${c.applicableFeature} gstNumber=${c.gstNumber || '(none)'}`),
      );
      console.log('Re-run with --apply to write.');
      return;
    }

    const result = await companies.updateMany(
      { _id: { $in: eligible.map(c => c._id) } },
      { $set: { eInvoiceProvider: EINVOICE_PROVIDERS.FYNAMICS } },
    );
    console.log(`Updated ${result.modifiedCount} of ${eligible.length} companies to eInvoiceProvider: MASTERS_INDIA.`);
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
