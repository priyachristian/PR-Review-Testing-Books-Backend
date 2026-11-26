/**
 * Renames the "Add Production" module to "Production Orders".
 *
 * Modules are a global catalog (books.modules), not per-company.
 *
 * Reports by default; writes only with --apply.
 *
 * Run: node migrations/renameProductionOrderModule-remove.js            (report only)
 *      node migrations/renameProductionOrderModule-remove.js --apply     (renames the module)
 */
const { getConnection } = require('../config/db');

const MODULE_NAMES = ['Add Production'];
const RENAME_MAP = { 'Add Production': 'Production Orders' };
const PATH_MAP = { 'Add Production': '/production-orders' };

const findModules = async db => {
  const modules = await db.books
    .collection('modules')
    .find({ name: { $in: MODULE_NAMES } })
    .toArray();

  const foundNames = new Set(modules.map(module => module.name));
  const missingNames = MODULE_NAMES.filter(name => !foundNames.has(name));

  console.log('Matched modules:');
  modules.forEach(module => {
    console.log(`  ${module._id}  ${module.name}  key=${module.key}  path=${module.path}  parentModule=${module.parentModule}`);
  });

  if (missingNames.length) {
    console.log('\nNames not found:');
    missingNames.forEach(name => console.log(`  ${name}`));
  }

  console.log(`\nTotal matched: ${modules.length} / ${MODULE_NAMES.length}`);

  return modules;
};

const renameModules = async (db, modules, apply) => {
  const collection = db.books.collection('modules');
  const toRename = modules.filter(module => RENAME_MAP[module.name]);

  console.log('\nRenames:');
  if (!toRename.length) {
    console.log('  None.');
    return;
  }

  for (const module of toRename) {
    const newName = RENAME_MAP[module.name];
    const newPath = PATH_MAP[module.name];
    const pathSuffix = newPath ? `  path "${module.path}" -> "${newPath}"` : '';
    console.log(`  ${module._id}  "${module.name}" -> "${newName}"${pathSuffix}`);

    if (apply) {
      const update = { name: newName };
      if (newPath) update.path = newPath;
      await collection.updateOne({ _id: module._id }, { $set: update });
    }
  }

  console.log(apply ? '\nRename applied.' : '\nDry run only - re-run with --apply to write the rename.');
};

const run = async () => {
  const apply = process.argv.includes('--apply');
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const modules = await findModules(db);
    await renameModules(db, modules, apply);
  } catch (error) {
    console.error('Script failed:', error);
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

module.exports = { run, findModules, renameModules, MODULE_NAMES, RENAME_MAP };
