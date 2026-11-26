/**
 * Removes the retired "Submit Production" module now that its rights live on
 * "Production Orders" (renamed from "Add Production" by
 * migrations/renameProductionOrderModule-remove.js). The route-level right checks were switched
 * from RIGHT_LIST.SUBMIT_PRODUCTION to RIGHT_LIST.PRODUCTION in
 * modules/production/addProduction/productionOrder.route.js - no data migration needed for that
 * part.
 *
 * Two-stage cleanup, run in this order:
 *   1. Strips the "Submit Production" permission entry from every matching role's `permissions`
 *      array (books.roles), scoped by --companyId when given.
 *   2. Deletes the "Submit Production" module document from the global catalog (books.modules).
 *      Modules are NOT per-company, so this step only runs when --companyId is omitted - with a
 *      company scope, only step 1 runs, since the module document is shared by every company and
 *      shouldn't be dropped while other companies' roles may still reference it.
 *
 * Idempotent / safe to re-run: step 1 only matches roles that still have the permission entry,
 * and step 2 only runs if the module document still exists.
 *
 * Reports by default; writes only with --apply.
 *
 * Usage:
 *   node migrations/removeSubmitProductionModule-remove.js                            (dry run, all companies)
 *   node migrations/removeSubmitProductionModule-remove.js --companyId=<id>           (dry run, one company - permissions only)
 *   node migrations/removeSubmitProductionModule-remove.js --apply
 *   node migrations/removeSubmitProductionModule-remove.js --apply --companyId=<id>
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const MODULE_NAME = 'Submit Production';

function parseArgs(argv) {
  const shouldApply = argv.includes('--apply');
  const hit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { shouldApply, companyId: companyArg ? new ObjectId(companyArg) : null };
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

const findModule = async db => {
  const foundModule = await db.books.collection('modules').findOne({ name: MODULE_NAME });

  if (!foundModule) {
    console.log(`\n✅ No "${MODULE_NAME}" module found - nothing to remove.\n`);
    return null;
  }

  console.log(`\nModule: ${foundModule._id}  "${foundModule.name}"  key=${foundModule.key}  path=${foundModule.path}`);
  return foundModule;
};

const stripRolePermissions = async (db, moduleId, apply, onlyCompanyId) => {
  const roles = db.books.collection('roles');

  const scope = {
    'permissions.module': moduleId,
    ...(onlyCompanyId ? { company: onlyCompanyId } : {}),
  };

  const matchedRoles = await roles.find(scope).project({ role: 1, company: 1 }).toArray();

  printSection(`Roles with a "${MODULE_NAME}" permission entry (${matchedRoles.length})`);
  if (!matchedRoles.length) {
    console.log('\n  None.\n');
    return matchedRoles.length;
  }

  console.table(
    matchedRoles.map(r => ({
      roleId: r._id.toString(),
      role: r.role,
      company: r.company ? r.company.toString() : '(missing)',
    })),
  );

  if (!apply) {
    console.log('\nDry run only - re-run with --apply to strip these permission entries.');
    return matchedRoles.length;
  }

  const result = await roles.updateMany(scope, { $pull: { permissions: { module: moduleId } } });
  console.log(`\n✅ Stripped "${MODULE_NAME}" permission from ${result.modifiedCount} role(s).`);
  return matchedRoles.length;
};

const deleteModule = async (db, foundModule, apply) => {
  printSection(`Module document (${foundModule._id})`);
  console.log(
    `  "${foundModule.name}"  key=${foundModule.key}  path=${foundModule.path}  parentModule=${foundModule.parentModule}`,
  );

  if (!apply) {
    console.log('\nDry run only - re-run with --apply to delete the module document.');
    return;
  }

  await db.books.collection('modules').deleteOne({ _id: foundModule._id });
  console.log('\n✅ Module document deleted.');
};

const run = async () => {
  let client;
  try {
    const { shouldApply, companyId: onlyCompanyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;

    printSection('removeSubmitProductionModule', '═');
    console.log(`\nMode: ${shouldApply ? 'APPLY (will write changes)' : 'DRY RUN (no changes written)'}`);
    console.log(`Scope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}`);

    const foundModule = await findModule(db);
    console.log({ foundModule });
    if (!foundModule) return;

    await stripRolePermissions(db, foundModule._id, shouldApply, onlyCompanyId);

    if (onlyCompanyId) {
      console.log(
        `\nℹ️  Modules are a global catalog, not per-company - skipping module document deletion because ` +
          `--companyId is set. Re-run without --companyId once every company's roles are clean to delete the module.\n`,
      );
      return;
    }

    await deleteModule(db, foundModule, shouldApply);
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

module.exports = { run, findModule, stripRolePermissions, deleteModule, MODULE_NAME };
