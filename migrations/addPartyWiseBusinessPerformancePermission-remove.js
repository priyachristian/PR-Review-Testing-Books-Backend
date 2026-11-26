/**
 * Grant analyticsPermissions.partyWiseBusinessPerformance on Role documents.
 *
 * One-time migration (safe to delete after running).
 *
 * Usage:
 *   node migrations/addPartyWiseBusinessPerformancePermission-remove.js
 *   node migrations/addPartyWiseBusinessPerformancePermission-remove.js --all
 *   node migrations/addPartyWiseBusinessPerformancePermission-remove.js --companyId=<ObjectId>
 *   node migrations/addPartyWiseBusinessPerformancePermission-remove.js --apply
 *   node migrations/addPartyWiseBusinessPerformancePermission-remove.js --all --apply
 *   node migrations/addPartyWiseBusinessPerformancePermission-remove.js --companyId=<ObjectId> --apply
 *
 * Notes:
 * - Without --apply: report only (no writes)
 * - With --apply: writes missing permissions only
 * - Admin roles get { view: true, export: true }
 * - Non-admin roles get { view: false, export: false } (enable later from Role settings)
 * - After applying: restart backend, then logout/login on frontend
 */

const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const FIELD = 'partyWiseBusinessPerformance';
const ADMIN_VALUE = { view: true, export: true };
const DEFAULT_VALUE = { view: false, export: false };

function isAdmin(role) {
  return /^admin$/i.test(String(role || '').trim());
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    apply: false,
    all: false,
    companyId: null,
  };

  argv.forEach(arg => {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--all') args.all = true;
    else if (arg.startsWith('--companyId=')) args.companyId = arg.slice('--companyId='.length).trim();
    else if (arg === '--companyId') {
      const idx = argv.indexOf(arg);
      args.companyId = (argv[idx + 1] || '').trim();
    }
  });

  if (args.companyId && args.all) {
    throw new Error('Use either --companyId=<id> OR --all, not both.');
  }

  if (args.companyId && !ObjectId.isValid(args.companyId)) {
    throw new Error(`Invalid --companyId: "${args.companyId}"`);
  }

  if (!args.companyId) args.all = true;

  return args;
}

function needsUpdate(roleDoc) {
  const value = (roleDoc.analyticsPermissions || {})[FIELD];
  return value === undefined || value === null;
}

function targetValue(roleDoc) {
  return isAdmin(roleDoc.role) ? ADMIN_VALUE : DEFAULT_VALUE;
}

async function run(options = {}) {
  const args = {
    apply: false,
    all: true,
    companyId: null,
    ...options,
  };

  const { client, books } = await getConnection();

  try {
    const roles = books.collection('roles');
    const filter = args.companyId ? { company: new ObjectId(args.companyId) } : {};

    const matchedRoles = await roles
      .find(filter, {
        projection: {
          _id: 1,
          role: 1,
          company: 1,
          [`analyticsPermissions.${FIELD}`]: 1,
        },
      })
      .toArray();

    const toUpdate = matchedRoles.filter(needsUpdate);

    console.log('=== Customer-wise Business Performance Permission ===');
    console.log(`Scope           : ${args.companyId ? `companyId=${args.companyId}` : 'ALL companies'}`);
    console.log(`Mode            : ${args.apply ? 'APPLY (missing only)' : 'REPORT (no writes)'}`);
    console.log(`Roles matched   : ${matchedRoles.length}`);
    console.log(`Roles to update : ${toUpdate.length}`);
    console.log(`Admin value     : ${JSON.stringify(ADMIN_VALUE)}`);
    console.log(`Non-admin value : ${JSON.stringify(DEFAULT_VALUE)}`);
    console.log('');

    if (matchedRoles.length === 0) {
      console.log(args.companyId ? 'No roles found for this companyId.' : 'No roles found.');
      return { matched: 0, updated: 0 };
    }

    if (toUpdate.length === 0) {
      console.log('Nothing to update. Permission already present on matched roles.');
      return { matched: matchedRoles.length, updated: 0 };
    }

    const adminCount = toUpdate.filter(r => isAdmin(r.role)).length;
    console.log(`Will set Admin     : ${adminCount}`);
    console.log(`Will set Non-admin : ${toUpdate.length - adminCount}`);
    console.log('');

    toUpdate.forEach(r => {
      const value = targetValue(r);
      console.log(
        `  ${args.apply ? '' : '[REPORT] '}role="${r.role}" company=${r.company} _id=${r._id} → ${JSON.stringify(value)}`,
      );
    });

    if (!args.apply) {
      console.log('\nReport complete. Re-run with --apply to write changes.');
      return { matched: matchedRoles.length, updated: 0, apply: false };
    }

    const ops = toUpdate.map(r => ({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: { [`analyticsPermissions.${FIELD}`]: targetValue(r) },
        },
      },
    }));

    const result = await roles.bulkWrite(ops, { ordered: false });
    console.log(`\nUpdated ${result.modifiedCount} role(s).`);
    console.log('Next steps:');
    console.log('  1) Restart the backend server.');
    console.log('  2) Logout and login again on the frontend.');
    console.log('  3) Open Analytics → Sales → Customer-wise Business Performance.');

    return { matched: matchedRoles.length, updated: result.modifiedCount, apply: true };
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
    console.log('This migration adds fields; revert with a manual $unset if needed.');
  },
  FIELD,
  ADMIN_VALUE,
  DEFAULT_VALUE,
};

if (require.main === module) {
  let args;
  try {
    args = parseArgs();
  } catch (err) {
    console.error(err.message);
    console.error('\nExamples:');
    console.error('  node migrations/addPartyWiseBusinessPerformancePermission-remove.js');
    console.error('  node migrations/addPartyWiseBusinessPerformancePermission-remove.js --companyId=<ObjectId>');
    console.error('  node migrations/addPartyWiseBusinessPerformancePermission-remove.js --apply');
    console.error('  node migrations/addPartyWiseBusinessPerformancePermission-remove.js --companyId=<ObjectId> --apply');
    process.exit(1);
  }

  run(args)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
