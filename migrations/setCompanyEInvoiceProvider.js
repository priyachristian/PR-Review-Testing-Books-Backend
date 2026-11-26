/**
 * Migration: switch a company's e-invoice/e-way bill provider (Company.eInvoiceProvider).
 *
 * Every company defaults to Fynamics. Run this to move a company onto Masters India as primary
 * (Fynamics becomes its automatic backup, only if that company already has Fynamics credentials saved),
 * once ops has confirmed that company's GSTIN is NIC-registered with Masters India as its GSP.
 * getOrderedProviders (modules/sales/invoice/providers/providerConfig.service.js) reads this field.
 *
 * Idempotent: does nothing if the company is already on the requested provider.
 * Defaults to a dry run. Pass --apply to actually write to the database.
 *
 * Usage:
 *   node migrations/setCompanyEInvoiceProvider.js --companyId=<id> --provider=MASTERS_INDIA            (dry run)
 *   node migrations/setCompanyEInvoiceProvider.js --companyId=<id> --provider=MASTERS_INDIA --apply    (writes)
 *   node migrations/setCompanyEInvoiceProvider.js --companyId=<id> --provider=FYNAMICS --apply         (revert to default)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { EINVOICE_PROVIDERS } = require('../utils/enum');

const parseArgs = argv => {
  const get = name => argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1];
  const companyId = get('companyId');
  const provider = get('provider');
  const apply = argv.includes('--apply');

  if (!companyId || !ObjectId.isValid(companyId)) {
    throw new Error('--companyId=<valid ObjectId> is required');
  }
  if (!Object.values(EINVOICE_PROVIDERS).includes(provider)) {
    throw new Error(`--provider must be one of: ${Object.values(EINVOICE_PROVIDERS).join(', ')}`);
  }
  return { companyId, provider, apply };
};

async function run() {
  const { client, common } = await getConnection();

  try {
    const { companyId, provider, apply } = parseArgs(process.argv.slice(2));
    const companies = common.collection('companies');

    const company = await companies.findOne(
      { _id: new ObjectId(companyId) },
      { projection: { name: 1, gstNumber: 1, eInvoiceProvider: 1 } },
    );
    if (!company) throw new Error(`Company ${companyId} not found`);

    const current = company.eInvoiceProvider || EINVOICE_PROVIDERS.FYNAMICS;
    console.log(`Company: ${company.name} (${companyId}), GSTIN: ${company.gstNumber || '(none)'}, current provider: ${current}`);

    if (current === provider) {
      console.log(`Already on ${provider}. Nothing to do.`);
      return;
    }
    if (provider === EINVOICE_PROVIDERS.MASTERS_INDIA && !company.gstNumber) {
      console.log(
        'WARNING: this company has no GSTIN set. Masters India calls need company.gstNumber and will fail until it is set.',
      );
    }

    if (!apply) {
      console.log(`[dry run] Would set eInvoiceProvider: ${current} -> ${provider}`);
      console.log('Re-run with --apply to write.');
      return;
    }

    await companies.updateOne({ _id: new ObjectId(companyId) }, { $set: { eInvoiceProvider: provider } });
    console.log(`Updated. eInvoiceProvider: ${current} -> ${provider}`);
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
