/**
 * Removes the bank feature entry from the `limits` array (entries look like
 * { featureName, limit, ... }) on any document in abss-admin.plans.
 *
 * Plans are a global catalog collection (not per-company), so there is no --companyId scope.
 *
 * Reports by default; writes only with --apply.
 *
 * Run: node migrations/removeBankPlanLimit-remove.js          (report only)
 *      node migrations/removeBankPlanLimit-remove.js --apply  (removes the values)
 */
const { getConnection } = require('../config/db');

// Feature name as stored in abss-admin.plans limits.
const FEATURE_NAMES = ['BANK'];

const parseArgs = () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  return { apply };
};

const findPlanIds = async db => {
  const filter = { 'limits.featureName': { $in: FEATURE_NAMES } };

  const plans = await db.admin.collection('plans').find(filter).project({ _id: 1, name: 1 }).toArray();

  console.log(`Plans matched: ${plans.length}`);
  plans.forEach(p => console.log(` - ${p._id}${p.name ? ` (${p.name})` : ''}`));

  return plans.map(p => p._id);
};

const removeBankFromPlans = async (db, planIds, apply) => {
  if (!planIds.length || !apply) return { modifiedCount: 0 };

  const result = await db.admin
    .collection('plans')
    .updateMany({ _id: { $in: planIds } }, { $pull: { limits: { featureName: { $in: FEATURE_NAMES } } } });

  console.log(`Plans updated: ${result.modifiedCount}`);

  return result;
};

const run = async () => {
  const { apply } = parseArgs();
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

    const planIds = await findPlanIds(db);
    await removeBankFromPlans(db, planIds, apply);
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = {
  run,
  findPlanIds,
  removeBankFromPlans,
  FEATURE_NAMES,
};
