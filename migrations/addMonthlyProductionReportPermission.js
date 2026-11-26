const { getConnection } = require('../config/db');

const FIELD = 'monthlyProductionReport';
const ADMIN_VALUE = { view: true, export: true };
const DEFAULT_VALUE = { view: false, export: false };

function isAdmin(role) {
  return /^admin$/i.test(role || '');
}

async function run({ dryRun = false } = {}) {
  const { client, books } = await getConnection();

  try {
    const roles = books.collection('roles');

    const allRoles = await roles
      .find(
        {},
        {
          projection: {
            _id: 1,
            role: 1,
            company: 1,
            [`analyticsPermissions.${FIELD}`]: 1,
          },
        },
      )
      .toArray();

    const toUpdate = allRoles.filter(r => {
      const value = (r.analyticsPermissions || {})[FIELD];
      return value === undefined || value === null;
    });

    console.log('--- Add Monthly Production Report Permission ---');
    if (dryRun) console.log('DRY RUN — no changes will be written\n');
    console.log(`Total roles scanned : ${allRoles.length}`);
    console.log(`Roles needing update: ${toUpdate.length}`);

    if (toUpdate.length === 0) {
      console.log('\nNothing to update.');
      return;
    }

    if (dryRun) {
      toUpdate.forEach(r => {
        const value = isAdmin(r.role) ? ADMIN_VALUE : DEFAULT_VALUE;
        console.log(`  [DRY RUN] Would set role "${r.role}" (${r._id}) → ${JSON.stringify(value)}`);
      });
      console.log('\nDry run complete. Re-run without --dry-run to apply.');
      return;
    }

    const ops = toUpdate.map(r => ({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: { [`analyticsPermissions.${FIELD}`]: isAdmin(r.role) ? ADMIN_VALUE : DEFAULT_VALUE },
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
  up: run,
  down: async () => {
    console.log('This migration adds new fields; reverting would require unsetting them manually.');
  },
};

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
