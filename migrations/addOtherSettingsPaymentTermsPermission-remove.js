/**
 * Migration: Backfill otherSettings.paymentTerms permission on existing roles.
 *
 * The Payment Terms permission under Settings > Other Settings is a full CRUD
 * permission ({ view, add, update, delete }) — existing Role documents predate
 * it, so any missing field reads as false via schema defaults. That hides the
 * Payment Terms settings tab and blocks every payment-term write (even for
 * admins) until backfilled.
 *
 * Admin roles (role matches /^admin$/i, any casing) get full CRUD access;
 * every other role gets all-false.
 *
 * Defaults to a dry run (reports what would change, writes nothing).
 * Pass --apply to actually write to the database.
 *
 * Usage:
 *   node migrations/addOtherSettingsPaymentTermsPermission-remove.js                        (dry run, all companies)
 *   node migrations/addOtherSettingsPaymentTermsPermission-remove.js <companyId>            (dry run, one company)
 *   node migrations/addOtherSettingsPaymentTermsPermission-remove.js <companyId> --apply    (writes to DB)
 *   node migrations/addOtherSettingsPaymentTermsPermission-remove.js --apply                (writes to DB, all companies)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const FIELD = 'paymentTerms';
const CRUD_FIELDS = ['view', 'add', 'update', 'delete'];
const ADMIN_VALUE = { view: true, add: true, update: true, delete: true };
const DEFAULT_VALUE = { view: false, add: false, update: false, delete: false };

function isAdminRole(role) {
  return /^admin$/i.test(role || '');
}

function isComplete(value) {
  return Boolean(value) && CRUD_FIELDS.every(field => typeof value[field] === 'boolean');
}

async function run() {
  const { client, books } = await getConnection();

  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    const scope = targetCompanyId ? { company: targetCompanyId } : {};

    console.log('--- Backfill otherSettings.paymentTerms Permission ---');
    console.log(`Scope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode: APPLYING CHANGES\n' : 'Mode: dry run — pass --apply to write\n');

    const roles = books.collection('roles');

    const scopedRoles = await roles
      .find(scope, {
        projection: {
          _id: 1,
          role: 1,
          company: 1,
          [`otherSettings.${FIELD}`]: 1,
        },
      })
      .toArray();

    const toUpdate = scopedRoles.filter(r => !isComplete((r.otherSettings || {})[FIELD]));

    console.log(`Roles scanned       : ${scopedRoles.length}`);
    console.log(`Roles needing update: ${toUpdate.length}`);

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
          $set: { [`otherSettings.${FIELD}`]: isAdminRole(r.role) ? ADMIN_VALUE : DEFAULT_VALUE },
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
  run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
