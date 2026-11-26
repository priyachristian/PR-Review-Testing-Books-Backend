/**
 * Removes the given Account modules end to end:
 *   1. Finds the Module documents by name.
 *   2. Removes any role.permissions entries referencing those module ids.
 *   3. Deletes the matching ModuleSettings records (booksCrm).
 *   4. Deletes the Module documents themselves (books).
 *
 * Reports by default; writes only with --apply.
 *
 * Run: node migrations/removeAccountModules.js            (report only)
 *      node migrations/removeAccountModules.js --apply     (removes the records)
 */
const { getConnection } = require('../config/db');

const MODULE_NAMES = [
  'Account Expenses',
  'Account Recurring Expenses',
  'Account Bill',
  'Account Item Master',
  'Account Invoice',
  'Account Reports',
];

const MODULE_SETTING_NAMES = ['ACCOUNT_BILL', 'ACCOUNT_EXPENSE', 'ACCOUNT_ITEM', 'ACCOUNT_INVOICE', 'RECURRING_ACCOUNT_EXPENSE'];

const findModuleIds = async db => {
  const modules = await db.books
    .collection('modules')
    .find({ name: { $in: MODULE_NAMES } })
    .project({ name: 1, key: 1, parentModule: 1 })
    .toArray();

  const foundNames = new Set(modules.map(module => module.name));
  const missingNames = MODULE_NAMES.filter(name => !foundNames.has(name));

  console.log('Matched modules:');
  modules.forEach(module => {
    console.log(`  ${module._id}  ${module.name}`);
  });

  if (missingNames.length) {
    console.log('\nNames not found:');
    missingNames.forEach(name => console.log(`  ${name}`));
  }

  console.log(`\nTotal matched: ${modules.length} / ${MODULE_NAMES.length}`);

  return modules.map(module => module._id);
};

const findRolesReferencingModules = async (db, moduleIds) => {
  const roles = await db.books
    .collection('roles')
    .find({ 'permissions.module': { $in: moduleIds } })
    .project({ role: 1, company: 1, permissions: 1 })
    .toArray();

  const moduleIdStrings = new Set(moduleIds.map(id => id.toString()));

  console.log(`\nRoles referencing these modules: ${roles.length}`);
  roles.forEach(role => {
    const matchedPermissions = role.permissions.filter(permission => moduleIdStrings.has(permission.module?.toString()));
    console.log(`\n  ${role._id}  ${role.role}  (company: ${role.company})`);
    matchedPermissions.forEach(permission => {
      console.log(
        `    module: ${permission.module}  view=${permission.view} create=${permission.create} edit=${permission.edit} delete=${permission.delete}`,
      );
    });
  });

  return roles;
};

const removeModulePermissionsFromRoles = async (db, moduleIds) => {
  const result = await db.books
    .collection('roles')
    .updateMany({ 'permissions.module': { $in: moduleIds } }, { $pull: { permissions: { module: { $in: moduleIds } } } });

  console.log(`\nRoles updated: ${result.modifiedCount}`);

  return result;
};

const deleteModules = async (db, moduleIds, apply) => {
  if (!moduleIds.length) return { deletedCount: 0 };

  const filter = { _id: { $in: moduleIds } };
  const collection = db.books.collection('modules');

  console.log(`\nModules to delete: ${moduleIds.length}`);

  if (!apply) return { deletedCount: 0 };

  const result = await collection.deleteMany(filter);
  console.log(`Modules deleted: ${result.deletedCount}`);

  return result;
};

const deleteModuleSettings = async (db, apply) => {
  const filter = { moduleName: { $in: MODULE_SETTING_NAMES } };
  const collection = db.booksCrm.collection('modulesettings');

  const count = await collection.countDocuments(filter);
  console.log(`\nModuleSettings matching ${JSON.stringify(MODULE_SETTING_NAMES)}: ${count}`);

  if (!apply || !count) return { deletedCount: 0 };

  const result = await collection.deleteMany(filter);
  console.log(`ModuleSettings deleted: ${result.deletedCount}`);

  return result;
};

const run = async () => {
  const apply = process.argv.includes('--apply');
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const moduleIds = await findModuleIds(db);
    if (moduleIds.length) {
      await findRolesReferencingModules(db, moduleIds);

      if (apply) {
        await removeModulePermissionsFromRoles(db, moduleIds);
      } else {
        console.log('\nDry run only — re-run with --apply to remove these permission entries.');
      }
    }

    await deleteModuleSettings(db, apply);
    await deleteModules(db, moduleIds, apply);
  } catch (error) {
    console.error('Migration failed:', error);
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

module.exports = {
  run,
  findModuleIds,
  findRolesReferencingModules,
  removeModulePermissionsFromRoles,
  deleteModuleSettings,
  deleteModules,
  MODULE_NAMES,
  MODULE_SETTING_NAMES,
};
