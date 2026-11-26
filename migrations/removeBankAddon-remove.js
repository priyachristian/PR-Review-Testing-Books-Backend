/**
 * Retires the bank addon (abss-admin.addons where featureName = 'BANK') and strips every
 * linked entry from common.billingcycles `addons` arrays.
 *
 * Two-stage cleanup, run in this order:
 *   1. Pulls { addonId: <bank addon id> } entries from `addons` on every matching billing cycle,
 *      scoped by --companyId when given.
 *   2. Disables the bank addon document(s) in the global catalog (abss-admin.addons) by setting
 *      isActive: false. The document is kept (not deleted) so historical references still resolve.
 *      Addons are NOT per-company, so this step only runs when --companyId is omitted.
 *
 * Order matters for safe re-runs: billing cycles are cleaned before the addon is disabled. The
 * addon is found by featureName regardless of isActive, so a re-run still cleans billing cycles.
 *
 * Not touched (intentional):
 *   - billingCycle.addonEvents: kept as historical audit trail.
 *   - billingCycle.amount / gst / serviceCharge: these are the billed/paid snapshot for that
 *     cycle and are not recalculated. Review the dry-run table for non-zero totals before applying.
 *
 * Idempotent / safe to re-run. Reports by default; writes only with --apply.
 *
 * Usage:
 *   node migrations/removeBankAddon-remove.js                            (dry run, all companies)
 *   node migrations/removeBankAddon-remove.js --companyId=<id>           (dry run, one company - billing cycles only)
 *   node migrations/removeBankAddon-remove.js --apply
 *   node migrations/removeBankAddon-remove.js --apply --companyId=<id>
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

// Feature name as stored in abss-admin.addons.featureName (PLAN_FEATURES.BANK in abss-models-core).
const FEATURE_NAME = 'BANK';

function parseArgs(argv) {
  const shouldApply = argv.includes('--apply');
  const hit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { shouldApply, companyId: companyArg ? new ObjectId(companyArg) : null };
}

function printSection(title, char = '-') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

const findBankAddons = async db => {
  const addons = await db.admin
    .collection('addons')
    .find({ featureName: FEATURE_NAME })
    .project({ featureName: 1, appName: 1, isActive: 1, sequence: 1 })
    .toArray();

  printSection(`Bank addon documents (${addons.length})`);
  if (!addons.length) {
    console.log(`\n✅ No addon with featureName "${FEATURE_NAME}" found - nothing to remove.\n`);
    return addons;
  }

  console.table(
    addons.map(a => ({
      addonId: a._id.toString(),
      featureName: a.featureName,
      appName: a.appName,
      isActive: a.isActive,
    })),
  );
  return addons;
};

const stripBillingCycleAddons = async (db, addonIds, apply, onlyCompanyId) => {
  const billingCycles = db.common.collection('billingcycles');

  const scope = {
    'addons.addonId': { $in: addonIds },
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
  };

  const matched = await billingCycles
    .find(scope)
    .project({ companyId: 1, subscriptionId: 1, cycleNo: 1, status: 1, isCurrent: 1, addons: 1 })
    .toArray();

  printSection(`Billing cycles with a linked bank addon (${matched.length})`);
  if (!matched.length) {
    console.log('\n  None.\n');
    return matched.length;
  }

  const idSet = new Set(addonIds.map(id => id.toString()));
  console.table(
    matched.flatMap(bc =>
      bc.addons
        .filter(a => a.addonId && idSet.has(a.addonId.toString()))
        .map(a => ({
          billingCycleId: bc._id.toString(),
          companyId: bc.companyId ? bc.companyId.toString() : '(missing)',
          cycleNo: bc.cycleNo,
          status: bc.status,
          isCurrent: bc.isCurrent,
          addonStatus: a.addonStatus,
          quantity: a.quantity,
          total: a.total,
        })),
    ),
  );

  if (!apply) {
    console.log('\nDry run only - re-run with --apply to strip these addon entries.');
    return matched.length;
  }

  const result = await billingCycles.updateMany(scope, { $pull: { addons: { addonId: { $in: addonIds } } } });
  console.log(`\n✅ Stripped bank addon from ${result.modifiedCount} billing cycle(s).`);
  return matched.length;
};

const disableBankAddons = async (db, addonIds, apply) => {
  printSection(`Disable bank addon document(s) (${addonIds.length})`);

  if (!apply) {
    console.log('\nDry run only - re-run with --apply to disable the addon document(s) (isActive: false).');
    return;
  }

  // Guard: never disable the addon while any billing cycle still references it.
  const stillLinked = await db.common.collection('billingcycles').countDocuments({ 'addons.addonId': { $in: addonIds } });
  if (stillLinked) {
    throw new Error(`${stillLinked} billing cycle(s) still reference the bank addon - aborting disable.`);
  }

  const result = await db.admin
    .collection('addons')
    .updateMany(
      { _id: { $in: addonIds }, featureName: FEATURE_NAME, isActive: { $ne: false } },
      { $set: { isActive: false, updatedAt: new Date() } },
    );
  const alreadyDisabled = addonIds.length - result.matchedCount;
  console.log(`\n✅ Disabled ${result.modifiedCount} addon document(s). Already disabled: ${alreadyDisabled}.`);
};

const run = async () => {
  let client;
  try {
    const { shouldApply, companyId: onlyCompanyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;

    printSection('removeBankAddon', '=');
    console.log(`\nMode: ${shouldApply ? 'APPLY (will write changes)' : 'DRY RUN (no changes written)'}`);
    console.log(`Scope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}`);

    const addons = await findBankAddons(db);
    if (!addons.length) return;

    const addonIds = addons.map(a => a._id);
    await stripBillingCycleAddons(db, addonIds, shouldApply, onlyCompanyId);

    if (onlyCompanyId) {
      console.log(
        '\nℹ️  Addons are a global catalog, not per-company - skipping addon disable because --companyId is set. ' +
          'Re-run without --companyId to disable the addon.\n',
      );
      return;
    }

    await disableBankAddons(db, addonIds, shouldApply);
  } catch (error) {
    console.error('Removal failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('\nMongoDB connection closed');
    }
  }
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { run, findBankAddons, stripBillingCycleAddons, disableBankAddons, FEATURE_NAME };
