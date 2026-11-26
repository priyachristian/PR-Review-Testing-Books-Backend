/**
 * [Run 1 of 3] Clears the Account Payment Made / Account Payment Received module rights from roles.
 *
 * Rights are stored as entries in books.roles `permissions[]`, each referencing a books.modules
 * `_id`. checkRoleRight resolves a right by `Module.findOne({ key })`, so the module catalog keys
 * are camelCase (e.g. accountPaymentMade), NOT the SCREAMING_SNAKE MODULE_NAMES values.
 *
 * Two passes:
 *   A) Catalog deletion — if a module doc exists for the account-payment keys, pull it from every
 *      role's permissions and delete the module doc.
 *   B) Orphan cleanup — pull any role permission whose `module` id no longer exists in the module
 *      catalog. Such permissions are already dead (the module id resolves to nothing, so they grant
 *      no access); removing them tidies the roles. This is what actually clears the account-payment
 *      rights on environments where the module doc was already gone from the catalog.
 *
 * Reports by default; writes only with --apply. Scope to one company with --companyId=<id>.
 *
 * Run: node migrations/removeAccountPaymentModuleRights-remove.js                          (report only, all companies)
 *      node migrations/removeAccountPaymentModuleRights-remove.js --companyId=<id>         (report only, single company)
 *      node migrations/removeAccountPaymentModuleRights-remove.js --apply                  (removes the records, all companies)
 *      node migrations/removeAccountPaymentModuleRights-remove.js --apply --companyId=<id> (removes the records, single company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

// Module catalog keys are camelCase, but match SCREAMING_SNAKE too in case an environment stored
// them differently. (Pass B's orphan sweep also catches account-payment rights regardless of casing.)
const MODULE_KEYS = ['accountPaymentMade', 'accountPaymentReceived', 'ACCOUNT_PAYMENT_MADE', 'ACCOUNT_PAYMENT_RECEIVED'];

const parseArgs = () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const companyArg = args.find(arg => arg.startsWith('--companyId='));
  const companyId = companyArg ? companyArg.split('=')[1].trim() : null;

  if (companyId && !ObjectId.isValid(companyId)) {
    throw new Error(`Invalid --companyId value: ${companyId}`);
  }

  return { apply, companyId };
};

// Roles carry the company on either `company` or `companyId` depending on age; match either.
const roleCompanyFilter = companyId =>
  companyId ? { $or: [{ company: new ObjectId(companyId) }, { companyId: new ObjectId(companyId) }] } : {};

const findAccountPaymentModuleIds = async db => {
  const modules = await db.books
    .collection('modules')
    .find({ key: { $in: MODULE_KEYS } })
    .project({ _id: 1, key: 1 })
    .toArray();
  console.log(`A) Account-payment module docs in catalog (by key): ${modules.length}`);
  modules.forEach(m => console.log(`     ${m.key}  ${m._id}`));
  return modules.map(mod => mod._id);
};

const clearModulePermissions = async (db, moduleIds, companyId, apply) => {
  if (!moduleIds.length) return;

  const filter = { ...roleCompanyFilter(companyId), 'permissions.module': { $in: moduleIds } };
  const count = await db.books.collection('roles').countDocuments(filter);
  console.log(`   Roles referencing these modules: ${count}`);

  if (apply && count) {
    const result = await db.books
      .collection('roles')
      .updateMany(filter, { $pull: { permissions: { module: { $in: moduleIds } } } });
    console.log(`   Roles updated: ${result.modifiedCount}`);
    const deleted = await db.books.collection('modules').deleteMany({ _id: { $in: moduleIds } });
    console.log(`   Module docs deleted: ${deleted.deletedCount}`);
  }
};

const cleanupOrphanPermissions = async (db, companyId, apply) => {
  const catalogIds = new Set(
    (await db.books.collection('modules').find({}).project({ _id: 1 }).toArray()).map(m => String(m._id)),
  );

  const roles = await db.books
    .collection('roles')
    .find({ ...roleCompanyFilter(companyId), 'permissions.0': { $exists: true } })
    .project({ permissions: 1 })
    .toArray();

  const orphanCounts = new Map();
  for (const role of roles) {
    for (const permission of role.permissions || []) {
      const moduleId = permission.module && String(permission.module);
      if (moduleId && !catalogIds.has(moduleId)) orphanCounts.set(moduleId, (orphanCounts.get(moduleId) || 0) + 1);
    }
  }

  const orphanIds = [...orphanCounts.keys()];
  console.log(`\nB) Orphan module ids in roles.permissions (not in the module catalog): ${orphanIds.length}`);
  orphanIds.forEach(id =>
    console.log(`     ${id}  → ${orphanCounts.get(id)} permission entr${orphanCounts.get(id) === 1 ? 'y' : 'ies'}`),
  );

  if (apply && orphanIds.length) {
    const objectIds = orphanIds.map(id => new ObjectId(id));
    const result = await db.books
      .collection('roles')
      .updateMany(
        { ...roleCompanyFilter(companyId), 'permissions.module': { $in: objectIds } },
        { $pull: { permissions: { module: { $in: objectIds } } } },
      );
    console.log(`   Roles updated: ${result.modifiedCount}`);
  }
};

const run = async () => {
  const { apply, companyId } = parseArgs();
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    console.log(`Scope: ${companyId || 'all companies'}  Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

    const moduleIds = await findAccountPaymentModuleIds(db);
    await clearModulePermissions(db, moduleIds, companyId, apply);
    await cleanupOrphanPermissions(db, companyId, apply);

    if (!apply) console.log('\nReport only — rerun with --apply to write.');
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
  findAccountPaymentModuleIds,
  clearModulePermissions,
  cleanupOrphanPermissions,
  MODULE_KEYS,
};
