/**
 * [Run 3 of 3] Scrubs Account Payment Made / Account Payment Received from plan feature lists:
 *   Removes the matching entries from the `limits` array (entries look like
 *   { featureName, limit, ... }) on any document in abss-admin.plans.
 *
 * Plans are a global catalog collection (not per-company), so there is no
 * --companyId scope here — unlike the sibling removeAccountPayment* migrations.
 *
 * Reports by default; writes only with --apply.
 *
 * Run: node migrations/removeAccountPaymentPlanFeatures-remove.js          (report only)
 *      node migrations/removeAccountPaymentPlanFeatures-remove.js --apply  (removes the values)
 */
const { getConnection } = require('../config/db');

// Different environments store the feature in different casing (camelCase accountPaymentMade in
// abss-admin.plans, SCREAMING_SNAKE in some data), so match both to stay robust.
const FEATURE_NAMES = ['accountPaymentMade', 'accountPaymentReceived', 'ACCOUNT_PAYMENT_MADE', 'ACCOUNT_PAYMENT_RECEIVED'];

const parseArgs = () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  return { apply };
};

const findPlanIds = async db => {
  const filter = { 'limits.featureName': { $in: FEATURE_NAMES } };

  const plans = await db.admin.collection('plans').find(filter).project({ _id: 1 }).toArray();

  console.log(`Plans matched: ${plans.length}`);

  return plans.map(p => p._id);
};

const removeFeaturesFromPlans = async (db, planIds, apply) => {
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
    await removeFeaturesFromPlans(db, planIds, apply);
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
  removeFeaturesFromPlans,
  FEATURE_NAMES,
};
