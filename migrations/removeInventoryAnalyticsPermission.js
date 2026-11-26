/**
 * Remove the retired `inventoryAnalytics` analytics permission from existing roles.
 *
 * The Inventory Analytics report was removed end-to-end (frontend, backend routes,
 * role schema, and the account default-role seed). Existing role documents in the
 * `books` DB still carry an orphaned `analyticsPermissions.inventoryAnalytics` value;
 * this migration $unsets it. The field is already ignored everywhere, so this is a
 * cleanup, not a functional fix.
 *
 * SAFETY:
 *   - Dry-run by default — prints how many roles would change, writes nothing.
 *   - Idempotent — roles without the field are skipped; safe to re-run.
 *
 * Usage:
 *   node migrations/removeInventoryAnalyticsPermission.js            (dry-run)
 *   node migrations/removeInventoryAnalyticsPermission.js --apply    (write)
 */

const { getConnection } = require('../config/db');

const FIELD = 'inventoryAnalytics';
const FIELD_PATH = `analyticsPermissions.${FIELD}`;

async function run() {
  const apply = process.argv.slice(2).includes('--apply');
  const { client, books } = await getConnection();

  try {
    const roles = books.collection('roles');

    const matchCount = await roles.countDocuments({ [FIELD_PATH]: { $exists: true } });

    console.log('--- Remove Inventory Analytics Permission ---');
    console.log(`Mode                     : ${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`Roles carrying the field : ${matchCount}`);

    if (matchCount === 0) {
      console.log('\nNothing to remove.');
      return;
    }

    if (!apply) {
      console.log('\nDry-run only — nothing was written. Re-run with --apply to remove the field.');
      return;
    }

    const result = await roles.updateMany({ [FIELD_PATH]: { $exists: true } }, { $unset: { [FIELD_PATH]: '' } });
    console.log(`\nRemoved the field from ${result.modifiedCount} role(s).`);
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
    console.log('This migration removes a retired field; there is nothing to restore.');
  },
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
