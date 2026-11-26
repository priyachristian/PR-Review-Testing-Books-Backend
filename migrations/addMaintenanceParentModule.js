/**
 * Migration: Add the parent "Maintenance" module and its child modules, then grant role permissions for them —
 * full CRUD for admin roles (admin / ADMIN / Admin), all-false for everyone else.
 *
 * Children: machine, maintenanceRequest, partRequest, maintenancePurchase, sparePart, spareStockLedger.
 *
 * Anything that already exists is skipped: a module whose key is already in the database is not created again and
 * gets no new role permissions; existing child modules only get featureName and icon synced. Roles that already hold
 * a permission entry for a module are never given a second one, so re-running is safe.
 *
 * By default every company is in scope. Pass --companyId=<companyId> to scope the role permissions to a single
 * company — the `roles` collection scopes by a `company` field. The modules themselves are shared by every
 * company.
 *
 * Defaults to a dry run (reports what would change, writes nothing).
 * Pass --apply to actually write to the database.
 *
 * Usage:
 *   node migrations/addMaintenanceParentModule.js                          (dry run, all companies)
 *   node migrations/addMaintenanceParentModule.js --apply                  (writes to DB, all companies)
 *   node migrations/addMaintenanceParentModule.js --companyId=<id> --apply (writes to DB, one company's roles)
 *
 * Reverting (also a dry run unless --apply is passed):
 *   node migrations/addMaintenanceParentModule.js --down --apply
 *     (removes the role permissions for the modules this migration created, then deletes those modules)
 *   node migrations/addMaintenanceParentModule.js --down --companyId=<id> --apply
 *     (removes only that company's role permissions; the shared modules are left as they are)
 *     (modules that were skipped because they already existed under another parent are not touched)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PARENT_DEFINITION = {
  key: 'maintenance',
  name: 'Maintenance',
  description: 'Maintenance',
  path: '/maintenance',
  icon: 'ToolOutlined',
};

const CHILD_DEFINITIONS = [
  {
    key: 'machine',
    name: 'Machine',
    description: 'Module for managing machines',
    path: '/machine',
    icon: 'SettingOutlined',
    sequence: 1,
    featureName: 'MACHINE_MAINTENANCE',
  },
  {
    key: 'sparePart',
    name: 'Spare Part',
    description: 'Module for managing spare parts',
    path: '/spare-part',
    icon: 'AppstoreOutlined',
    sequence: 2,
    featureName: 'MACHINE_MAINTENANCE',
  },
  {
    key: 'maintenanceRequest',
    name: 'Maintenance Request',
    description: 'Module for managing machine maintenance requests',
    path: '/maintenance-request',
    icon: 'FileExclamationOutlined',
    sequence: 3,
    featureName: 'MACHINE_MAINTENANCE',
  },
  {
    key: 'partRequest',
    name: 'Part Request',
    description: 'Module for managing spare part requests raised against maintenance requests',
    path: '/part-request',
    icon: 'FileAddOutlined',
    sequence: 4,
    featureName: 'MACHINE_MAINTENANCE',
  },
  {
    key: 'maintenancePurchase',
    name: 'Maintenance Purchase',
    description: 'Module for managing spare part purchase requests and orders',
    path: '/maintenance-purchase',
    icon: 'ShoppingCartOutlined',
    sequence: 5,
    featureName: 'MACHINE_MAINTENANCE',
  },
  {
    key: 'spareStockLedger',
    name: 'Spare Part Ledger',
    description: 'Module for viewing spare part stock transactions',
    path: '/spare-stock-ledger',
    icon: 'DatabaseOutlined',
    sequence: 6,
    featureName: 'MACHINE_MAINTENANCE',
  },
];

const ALL_KEYS = [PARENT_DEFINITION.key, ...CHILD_DEFINITIONS.map(d => d.key)];

function isAdminRole(role) {
  return /^admin$/i.test(role || '');
}

function parseArgs() {
  const out = { apply: false, companyId: null, down: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') out.apply = true;
    else if (arg === '--down') out.down = true;
    else if (arg.startsWith('--companyId=')) out.companyId = arg.split('=')[1].trim();
  }
  return out;
}

async function run({ apply = false, companyId = null } = {}) {
  const { client, books } = await getConnection();

  try {
    console.log(
      `--- Add Maintenance Parent Module [${apply ? 'APPLY' : 'DRY RUN'}]${companyId ? ` [company=${companyId}]` : ''} ---`,
    );

    const modules = books.collection('modules');
    const roles = books.collection('roles');

    // Modules this run creates; only these get role permissions.
    const created = [];

    // 1. Parent module.
    let parent = await modules.findOne({ key: PARENT_DEFINITION.key });
    if (parent) {
      console.log(`Skipped ${PARENT_DEFINITION.key}: module already exists (${parent._id}).`);
    } else {
      console.log(`${PARENT_DEFINITION.key}: module does not exist yet, will be created.`);
      if (apply) {
        // Sits after the last top-level module in the menu.
        const [last] = await modules
          .find({ $or: [{ parentModule: null }, { parentModule: { $exists: false } }] })
          .sort({ sequence: -1 })
          .limit(1)
          .toArray();
        const result = await modules.insertOne({
          name: PARENT_DEFINITION.name,
          description: PARENT_DEFINITION.description,
          path: PARENT_DEFINITION.path,
          icon: PARENT_DEFINITION.icon,
          sequence: (last?.sequence || 0) + 1,
          isActive: true,
          key: PARENT_DEFINITION.key,
          isCustomPlanModule: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        parent = { _id: result.insertedId };
        console.log(`Inserted ${PARENT_DEFINITION.key} module: ${parent._id}`);
      }
      created.push({ definition: PARENT_DEFINITION, module: parent });
    }

    // 2. Child modules.
    for (const definition of CHILD_DEFINITIONS) {
      const existing = await modules.findOne({ key: definition.key });
      if (existing) {
        // Backfill plan gating and icon on modules created by an earlier run.
        const needsSync = existing.featureName !== definition.featureName || existing.icon !== definition.icon;
        if (!needsSync) {
          console.log(`Skipped ${definition.key}: module already exists (${existing._id}).`);
          continue;
        }
        console.log(`${definition.key}: will set featureName=${definition.featureName}, icon=${definition.icon}.`);
        if (apply) {
          await modules.updateOne(
            { _id: existing._id },
            { $set: { featureName: definition.featureName, icon: definition.icon, updatedAt: new Date() } },
          );
        }
        continue;
      }

      console.log(`${definition.key}: module does not exist yet, will be created.`);
      let module = null;
      if (apply) {
        const result = await modules.insertOne({
          name: definition.name,
          description: definition.description,
          path: definition.path,
          icon: definition.icon,
          parentModule: parent._id,
          sequence: definition.sequence,
          isActive: true,
          key: definition.key,
          featureName: definition.featureName,
          isCustomPlanModule: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        module = { _id: result.insertedId };
        console.log(`Inserted ${definition.key} module: ${module._id}`);
      }
      created.push({ definition, module });
    }

    if (created.length === 0) {
      console.log('\nNothing to add — every module already exists.');
      return;
    }

    // 3. Role permissions for the modules created above.
    const roleFilter = companyId ? { company: new ObjectId(companyId) } : {};
    const allRoles = await roles.find(roleFilter, { projection: { _id: 1, role: 1, company: 1, permissions: 1 } }).toArray();
    const adminCount = allRoles.filter(r => isAdminRole(r.role)).length;
    console.log(`\nTotal roles scanned: ${allRoles.length} (admin: ${adminCount}, other: ${allRoles.length - adminCount})`);
    created.forEach(({ definition }) => {
      console.log(`  ${definition.key}: ${allRoles.length} role(s) will get a permission entry`);
    });

    if (!apply) {
      console.log('\nDry run only — no changes written. Re-run with --apply to write to the database.');
      return;
    }

    for (const { definition, module } of created) {
      // A role that already has an entry for this module (for example from an earlier partial run) is skipped.
      const needing = allRoles.filter(r => !(r.permissions || []).some(p => p.module?.toString() === module._id.toString()));
      if (needing.length === 0) continue;
      const ops = needing.map(r => {
        const isAdmin = isAdminRole(r.role);
        return {
          updateOne: {
            filter: { _id: r._id },
            update: {
              $push: { permissions: { module: module._id, create: isAdmin, view: isAdmin, edit: isAdmin, delete: isAdmin } },
            },
          },
        };
      });
      const result = await roles.bulkWrite(ops);
      console.log(`${definition.key}: updated ${result.modifiedCount} role(s).`);
    }

    console.log('\nDone.');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

async function revert({ apply = false, companyId = null } = {}) {
  const { client, books } = await getConnection();

  try {
    console.log(
      `--- Revert Maintenance Parent Module [${apply ? 'APPLY' : 'DRY RUN'}]${companyId ? ` [company=${companyId}]` : ''} ---`,
    );

    const modules = books.collection('modules');
    const roles = books.collection('roles');

    // Only the Maintenance parent and the modules sitting under it. Modules that already existed under another
    // parent (and so were skipped by the migration) are left alone.
    const parent = await modules.findOne({ key: PARENT_DEFINITION.key });
    const existing = parent
      ? await modules.find({ $or: [{ _id: parent._id }, { key: { $in: ALL_KEYS }, parentModule: parent._id }] }).toArray()
      : [];
    const moduleIds = existing.map(m => m._id);

    const roleFilter = {
      ...(companyId ? { company: new ObjectId(companyId) } : {}),
      'permissions.module': { $in: moduleIds },
    };
    const rolesWithPermission = moduleIds.length ? await roles.countDocuments(roleFilter) : 0;

    // The modules are shared by every company, so only drop them on a full (all-company) revert.
    const removeModules = existing.length > 0 && !companyId;

    console.log(`Roles with a maintenance module permission : ${rolesWithPermission}`);
    console.log(`Modules                                    : ${removeModules ? `${existing.length} will be deleted` : 'kept'}`);

    if (rolesWithPermission === 0 && !removeModules) {
      console.log('\nNothing to revert.');
      return;
    }

    if (!apply) {
      console.log('\nDry run only — no changes written. Re-run with --apply to write to the database.');
      return;
    }

    if (rolesWithPermission > 0) {
      const result = await roles.updateMany(roleFilter, { $pull: { permissions: { module: { $in: moduleIds } } } });
      console.log(`\nRemoved permissions from ${result.modifiedCount} role(s).`);
    }

    if (removeModules) {
      const leftover = await roles.countDocuments({ 'permissions.module': { $in: moduleIds } });
      if (leftover > 0) {
        throw new Error(`Refusing to delete the modules: ${leftover} role(s) still reference them.`);
      }
      const result = await modules.deleteMany({ _id: { $in: moduleIds } });
      console.log(`Deleted ${result.deletedCount} module(s).`);
    }
  } catch (err) {
    console.error('Revert failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = {
  up: opts => run(opts),
  down: opts => revert(opts),
};

if (require.main === module) {
  const args = parseArgs();
  (args.down ? revert(args) : run(args)).then(() => process.exit(0)).catch(() => process.exit(1));
}
