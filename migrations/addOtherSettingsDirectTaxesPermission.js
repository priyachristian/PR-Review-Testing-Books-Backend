/**
 * Migration: Backfill otherSettings.directTaxes permission on existing roles (all companies).
 *
 * Settings > Taxes & Compliance > Direct Taxes is guarded by otherSettings.directTaxes. Existing
 * roles predate it, so admin roles get full CRUD and every other role gets all-false until an
 * admin grants it from the Roles screen.
 *
 * Usage:
 *   node migrations/addOtherSettingsDirectTaxesPermission.js            (dry run)
 *   node migrations/addOtherSettingsDirectTaxesPermission.js --apply    (writes to DB)
 */
const { getConnection } = require('../config/db');

const CRUD_FIELDS = ['view', 'add', 'update', 'delete'];
const ADMIN_VALUE = { view: true, add: true, update: true, delete: true };
const DEFAULT_VALUE = { view: false, add: false, update: false, delete: false };

const isAdminRole = role => /^admin$/i.test(role || '');
const isComplete = value => Boolean(value) && CRUD_FIELDS.every(field => typeof value[field] === 'boolean');

async function run({ apply = false } = {}) {
  const { client, books } = await getConnection();

  try {
    console.log(`--- Backfill otherSettings.directTaxes Permission [${apply ? 'APPLY' : 'DRY RUN'}] ---`);
    const roles = books.collection('roles');
    const allRoles = await roles.find({}, { projection: { _id: 1, role: 1, 'otherSettings.directTaxes': 1 } }).toArray();
    const toUpdate = allRoles.filter(r => !isComplete((r.otherSettings || {}).directTaxes));
    const adminCount = toUpdate.filter(r => isAdminRole(r.role)).length;

    console.log(`Roles scanned      : ${allRoles.length}`);
    console.log(`Roles needing update: ${toUpdate.length} (admin ${adminCount}, others ${toUpdate.length - adminCount})`);

    if (!toUpdate.length) return;
    if (!apply) {
      console.log('Dry run only — no changes written. Re-run with --apply to write to the database.');
      return;
    }

    const result = await roles.bulkWrite(
      toUpdate.map(r => ({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { 'otherSettings.directTaxes': isAdminRole(r.role) ? ADMIN_VALUE : DEFAULT_VALUE } },
        },
      })),
    );
    console.log(`Updated ${result.modifiedCount} role(s).`);
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
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
