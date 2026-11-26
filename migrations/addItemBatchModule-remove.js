/**
 * Seeds the Item Batches module into books.modules as a child of the
 * existing Inventory parent ('viewInventory'), and grants permissions to all roles.
 *
 * Module:
 *   key        : 'itemBatch'
 *   name       : 'Item Batches'
 *   path       : '/item-batches'
 *   icon       : 'DatabaseOutlined'
 *   Placed as a child under the 'viewInventory' parent module.
 *   sequence   : one after the last existing Inventory child (idempotent).
 *
 * Role permissions (only roles that do not already have an entry for this module):
 *   Admin roles  -> view/create/edit/delete = true
 *   Other roles  -> view/create/edit/delete = false (deny by default, enable from Roles screen)
 *
 * Idempotent: re-running skips the insert, syncs drifted module fields, and only adds
 * missing role permissions. Modules are global; <companyId> only scopes the role updates.
 *
 * Run: node migrations/addItemBatchModule-remove.js                       (dry run, all companies)
 *      node migrations/addItemBatchModule-remove.js --apply               (write, all companies)
 *      node migrations/addItemBatchModule-remove.js <companyId>           (dry run, one company)
 *      node migrations/addItemBatchModule-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection, closeConnection } = require('../config/db');
const { RIGHT_LIST } = require('../utils/enum');

// The new module is placed as a child under this existing Inventory parent.
const INVENTORY_PARENT_KEY = RIGHT_LIST.VIEW_INVENTORY;

const MODULE = {
  name: 'Item Batches',
  description: 'Item Batches',
  path: '/item-batches',
  icon: 'DatabaseOutlined',
  isActive: true,
  key: RIGHT_LIST.ITEM_BATCH,
  featureName: null,
  isCustomPlanModule: false,
};

const SYNC_FIELDS = ['name', 'description', 'path', 'icon', 'isActive', 'featureName', 'isCustomPlanModule'];

const ADMIN_PERMISSION = { view: true, create: true, edit: true, delete: true };
const DEFAULT_PERMISSION = { view: false, create: false, edit: false, delete: false };

const isAdminRole = roleName => /^admin$/i.test(roleName || '');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const companyArg = args.find(arg => !arg.startsWith('--'));
  if (companyArg && !ObjectId.isValid(companyArg)) {
    throw new Error(`Invalid companyId: ${companyArg}`);
  }
  return { apply, targetCompanyId: companyArg ? new ObjectId(companyArg) : null };
};

const getSyncPatch = (desired, current) => {
  const patch = {};
  for (const field of SYNC_FIELDS) {
    if (desired[field] === undefined) continue;
    if (current[field] !== desired[field]) {
      patch[field] = desired[field];
    }
  }
  return patch;
};

const ensureModule = async (modules, apply, now) => {
  // Find the Inventory parent module.
  const parent = await modules.findOne({ key: INVENTORY_PARENT_KEY });
  if (!parent) {
    throw new Error(`Inventory parent module '${INVENTORY_PARENT_KEY}' not found. Cannot place '${MODULE.key}' without it.`);
  }
  console.log(`Inventory parent: ${parent.key} → _id=${parent._id}`);

  // Check if this module already exists.
  const existing = await modules.findOne({ key: MODULE.key });

  if (existing) {
    const patch = getSyncPatch(MODULE, existing);

    // Ensure it is under the correct parent.
    if (String(existing.parentModule) !== String(parent._id)) {
      patch.parentModule = parent._id;
    }

    if (!Object.keys(patch).length) {
      console.log(`Module already exists and is correct: ${MODULE.key} → ${existing._id}`);
      return { moduleId: existing._id, inserted: false, updated: false };
    }

    console.log(`Would update module ${MODULE.key}: ${JSON.stringify(patch)}`);
    if (apply) {
      await modules.updateOne({ _id: existing._id }, { $set: { ...patch, updatedAt: now } });
    }
    return { moduleId: existing._id, inserted: false, updated: apply };
  }

  // Determine next sequence under the parent.
  const lastChild = await modules.find({ parentModule: parent._id }).sort({ sequence: -1 }).limit(1).toArray();
  const nextSequence = lastChild.length ? (lastChild[0].sequence || 0) + 1 : 1;

  const moduleId = new ObjectId();
  console.log(`Would insert module: ${MODULE.name} (${MODULE.key}) parentModule=${parent._id} sequence=${nextSequence}`);

  if (apply) {
    await modules.insertOne({
      _id: moduleId,
      ...MODULE,
      parentModule: parent._id,
      sequence: nextSequence,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
  }

  return { moduleId, isNew: true, inserted: apply, updated: false };
};

const migrate = async () => {
  let client;
  try {
    const { apply, targetCompanyId } = parseArgs();
    const db = await getConnection();
    client = db.client;

    console.log(`\nScope : ${targetCompanyId ? `company ${targetCompanyId}` : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode  : APPLYING CHANGES\n' : 'Mode  : DRY RUN, pass --apply to write\n');

    const modules = db.books.collection('modules');
    const roles = db.books.collection('roles');
    const now = new Date();

    const { moduleId, isNew, inserted, updated } = await ensureModule(modules, apply, now);

    // Find roles that do not yet have a permission entry for this module.
    const roleFilter = {
      'permissions.module': { $ne: moduleId },
      ...(targetCompanyId ? { company: targetCompanyId } : {}),
    };
    const rolesToUpdate = await roles.find(roleFilter).project({ _id: 1, role: 1, company: 1 }).toArray();

    if (targetCompanyId && !(await roles.countDocuments({ company: targetCompanyId }))) {
      console.log(`\nNo roles found for company ${targetCompanyId}`);
    }

    const adminRoles = rolesToUpdate.filter(r => isAdminRole(r.role));
    const otherRoles = rolesToUpdate.filter(r => !isAdminRole(r.role));

    console.log(`\nRoles missing '${MODULE.key}' permission: ${rolesToUpdate.length}`);
    console.log(`   admin (full access) : ${adminRoles.length}`);
    console.log(`   others (no access)  : ${otherRoles.length}`);

    const operations = rolesToUpdate.map(role => ({
      updateOne: {
        filter: { _id: role._id, 'permissions.module': { $ne: moduleId } },
        update: {
          $push: {
            permissions: {
              module: moduleId,
              ...(isAdminRole(role.role) ? ADMIN_PERMISSION : DEFAULT_PERMISSION),
            },
          },
        },
      },
    }));

    let rolesUpdated = 0;
    if (apply && operations.length) {
      const result = await roles.bulkWrite(operations, { ordered: false });
      rolesUpdated = result.modifiedCount;
    }

    console.log('\nSUMMARY');
    console.log(`   module id           : ${moduleId}${isNew && !apply ? ' (preview id, not saved)' : ''}`);
    console.log(`   module inserted     : ${inserted}`);
    console.log(`   module updated      : ${updated}`);
    console.log(`   roles to update     : ${operations.length}`);
    console.log(`   roles updated       : ${rolesUpdated}`);

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to seed.\n');
      return;
    }
    console.log('\nItem Batches module seeded.\n');
  } catch (error) {
    console.error('Item Batches module seed failed:', error);
    process.exitCode = 1;
  } finally {
    await closeConnection(client);
  }
};

migrate();
