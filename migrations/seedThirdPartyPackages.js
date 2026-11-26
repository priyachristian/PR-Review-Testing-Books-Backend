/**
 * Migration: Seed the Fynamics third-party provider + API packages used to meter/charge
 * every GSP call (e-invoice, e-way bill) logged in UserThirdPartyApiLogs.
 *
 * salesCost is what we bill the company per call; purchaseCost is Fynamics' per-call cost to us.
 *
 * Usage (dry run by default — no writes, just logs what would happen):
 *   node migrations/seedThirdPartyPackages.js up
 *   node migrations/seedThirdPartyPackages.js down
 *
 * Apply for real:
 *   node migrations/seedThirdPartyPackages.js up --apply
 *   node migrations/seedThirdPartyPackages.js down --apply
 */
const { getConnection } = require('../config/db');
const { THIRD_PARTY_PROVIDERS } = require('../utils/enum');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');

// packageName reuses PLAN_FEATURES values so a call is always billed against the package
// matching the company's applicableFeature.
const PROVIDERS = [
  {
    name: THIRD_PARTY_PROVIDERS.FYNAMICS,
    description: 'Fynamics Techno Solutions — GSP for NIC e-invoice and e-way bill APIs',
    website: 'https://fynamics.co.in',
    packages: [
      { packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL, salesCost: 1, purchaseCost: 0.1, currency: 'INR' },
      { packageName: PLAN_FEATURES.ONLY_E_WAY_BILL, salesCost: 1, purchaseCost: 0.1, currency: 'INR' },
    ],
  },
];

module.exports = {
  /**
   * Apply (or dry-run) the migration.
   */
  async up(apply = false) {
    const { client, books } = await getConnection();

    try {
      const providers = books.collection('thirdpartyproviders');
      const packages = books.collection('thirdpartyapipackages');
      const now = new Date();

      for (const { packages: providerPackages, ...providerData } of PROVIDERS) {
        let provider = await providers.findOne({ name: providerData.name });

        if (!apply) {
          console.log(`[dry-run] ${provider ? 'would update' : 'would insert'} provider "${providerData.name}"`);
          for (const pkg of providerPackages) {
            const existing = provider && (await packages.findOne({ providerId: provider._id, packageName: pkg.packageName }));
            console.log(`[dry-run] ${existing ? 'would update' : 'would insert'} package "${pkg.packageName}" ->`, {
              salesCost: pkg.salesCost,
              purchaseCost: pkg.purchaseCost,
              currency: pkg.currency,
            });
          }
          continue;
        }

        await providers.updateOne(
          { name: providerData.name },
          {
            $setOnInsert: { name: providerData.name, createdAt: now },
            $set: {
              description: providerData.description,
              website: providerData.website,
              isActive: true,
              updatedAt: now,
            },
          },
          { upsert: true },
        );
        provider = await providers.findOne({ name: providerData.name });
        console.log(`provider  ${provider.name} (${provider._id})`);

        for (const pkg of providerPackages) {
          await packages.updateOne(
            { providerId: provider._id, packageName: pkg.packageName },
            {
              $setOnInsert: { providerId: provider._id, packageName: pkg.packageName, createdAt: now },
              $set: {
                salesCost: pkg.salesCost,
                purchaseCost: pkg.purchaseCost,
                currency: pkg.currency,
                isActive: true,
                updatedAt: now,
              },
            },
            { upsert: true },
          );
          console.log(`  package ${pkg.packageName} — sales ${pkg.salesCost} / cost ${pkg.purchaseCost} ${pkg.currency}`);
        }
      }

      if (!apply) {
        console.log('[dry-run] no changes written. Re-run with --apply to persist.');
        return;
      }

      console.log('✅ Seeded third-party providers and packages');
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },

  /**
   * Revert (or dry-run) the migration.
   */
  async down(apply = false) {
    const { client, books } = await getConnection();

    try {
      const providers = books.collection('thirdpartyproviders');
      const packages = books.collection('thirdpartyapipackages');

      for (const { name } of PROVIDERS) {
        const provider = await providers.findOne({ name });

        if (!provider) {
          console.log(`${apply ? '' : '[dry-run] '}no provider "${name}" found, nothing to delete.`);
          continue;
        }

        if (!apply) {
          const packageCount = await packages.countDocuments({ providerId: provider._id });
          console.log(`[dry-run] would delete ${packageCount} package(s) and provider "${name}"`);
          continue;
        }

        await packages.deleteMany({ providerId: provider._id });
        await providers.deleteOne({ _id: provider._id });
        console.log(`deleted provider "${name}" and its packages`);
      }

      if (!apply) {
        console.log('[dry-run] no changes written. Re-run with --apply to persist.');
        return;
      }

      console.log('✅ Migration down completed');
    } catch (err) {
      console.error('❌ Migration down failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  const direction = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!['up', 'down'].includes(direction)) {
    console.error('Usage: node <file> [up|down] [--apply]');
    process.exit(1);
  }

  module.exports[direction](apply)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
