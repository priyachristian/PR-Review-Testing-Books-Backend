/**
 * Migration: Backfill otherSettings.incentive permission on existing roles,
 * scoped to companies that actually have the Incentive feature.
 *
 * The Incentive permission under Settings > Other Settings is a full CRUD
 * permission ({ view, add, update, delete }) — existing Role documents predate
 * it (or predate the CRUD shape, if they only ever had { view, edit }), so any
 * missing field reads as false via schema defaults. That hides the whole
 * Incentive Schemes settings tab and blocks every incentive-scheme write
 * (even for admins) until backfilled.
 *
 * Incentive is a hard-hidden, custom-plan-only feature (see
 * HARD_HIDDEN_PLAN_FEATURES in utils/enum.js), so this only touches roles
 * belonging to companies whose active/due Books subscription is on a plan
 * where `isCustomPlan === true` AND the plan's `limits` include an INCENTIVE
 * entry that's actually enabled (isUnlimited, or limit > 0) — mirroring the
 * exact plan-resolution logic in modules/commonModule/module/module.service.js
 * (getModuleTree). Roles at every other company are left untouched.
 *
 * Defaults to a dry run (reports what would change, writes nothing).
 * Pass --apply to actually write to the database.
 *
 * Usage:
 *   node migrations/addOtherSettingsIncentivePermission.js            (dry run)
 *   node migrations/addOtherSettingsIncentivePermission.js --apply    (writes to DB)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const CRUD_FIELDS = ['view', 'add', 'update', 'delete'];
const ADMIN_VALUE = { view: true, add: true, update: true, delete: true };
const DEFAULT_VALUE = { view: false, add: false, update: false, delete: false };

const SUBSCRIPTION_ACTIVE_STATUSES = ['active', 'due'];
const APP_NAME_BOOKS = 'BOOKS';
const PLAN_FEATURE_INCENTIVE = 'INCENTIVE';

function isAdminRole(role) {
  return /^admin$/i.test(role || '');
}

function isComplete(value) {
  return Boolean(value) && CRUD_FIELDS.every(field => typeof value[field] === 'boolean');
}

function planHasIncentive(plan) {
  const feature = (plan?.limits || []).find(f => f.featureName === PLAN_FEATURE_INCENTIVE);
  return Boolean(feature && (feature.isUnlimited || feature.limit > 0));
}

async function getQualifyingCompanyIds({ common, admin }) {
  const subscriptions = await common
    .collection('companysubscriptions')
    .find({ status: { $in: SUBSCRIPTION_ACTIVE_STATUSES } }, { projection: { companyId: 1, planId: 1 } })
    .toArray();

  const planIdById = new Map(subscriptions.filter(s => s.planId).map(s => [s.planId.toString(), s.planId]));

  const plans = await admin
    .collection('plans')
    .find({ _id: { $in: [...planIdById.values()] }, appName: APP_NAME_BOOKS }, { projection: { isCustomPlan: 1, limits: 1 } })
    .toArray();

  const qualifyingPlanIds = new Set(
    plans.filter(plan => plan.isCustomPlan && planHasIncentive(plan)).map(plan => plan._id.toString()),
  );

  const qualifyingCompanyIds = new Set(
    subscriptions.filter(s => qualifyingPlanIds.has(s.planId?.toString())).map(s => s.companyId?.toString()),
  );

  return qualifyingCompanyIds;
}

async function run({ apply = false } = {}) {
  const { client, books, common, admin } = await getConnection();

  try {
    const qualifyingCompanyIds = await getQualifyingCompanyIds({ common, admin });

    console.log(`--- Backfill otherSettings.incentive Permission [${apply ? 'APPLY' : 'DRY RUN'}] ---`);
    console.log(`Companies on a custom plan with INCENTIVE enabled: ${qualifyingCompanyIds.size}`);

    if (qualifyingCompanyIds.size === 0) {
      console.log('\nNo qualifying companies — nothing to update.');
      return;
    }

    const roles = books.collection('roles');
    const qualifyingCompanyObjectIds = [...qualifyingCompanyIds].map(id => new ObjectId(id));

    const inScope = await roles
      .find(
        { company: { $in: qualifyingCompanyObjectIds } },
        {
          projection: {
            _id: 1,
            role: 1,
            company: 1,
            'otherSettings.incentive': 1,
          },
        },
      )
      .toArray();

    const toUpdate = inScope.filter(r => !isComplete((r.otherSettings || {}).incentive));

    console.log(`Roles scanned at those companies : ${inScope.length}`);
    console.log(`Roles needing update             : ${toUpdate.length}`);

    if (toUpdate.length === 0) {
      console.log('\nNothing to update.');
      return;
    }

    const adminCount = toUpdate.filter(r => isAdminRole(r.role)).length;
    console.log(`  -> admin roles     : ${adminCount} (will get ${JSON.stringify(ADMIN_VALUE)})`);
    console.log(`  -> non-admin roles : ${toUpdate.length - adminCount} (will get ${JSON.stringify(DEFAULT_VALUE)})`);

    if (!apply) {
      console.log('\nDry run only — no changes written. Re-run with --apply to write to the database.');
      return;
    }

    const ops = toUpdate.map(r => ({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: { 'otherSettings.incentive': isAdminRole(r.role) ? ADMIN_VALUE : DEFAULT_VALUE },
        },
      },
    }));

    const result = await roles.bulkWrite(ops);
    console.log(`\nUpdated ${result.modifiedCount} role(s).`);
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = {
  up: opts => run(opts),
  down: async () => {
    console.log('This migration adds new fields; reverting would require unsetting them manually.');
  },
};

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  run({ apply })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
