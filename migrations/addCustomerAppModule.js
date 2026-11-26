/**
 * Seeds the Customer App parent module and its Dashboard submodule, then moves
 * Customer Orders and Customer Payments under it.
 *
 * What this migration does (in order):
 *   1. Creates a top-level "Customer App" module placed directly after the Sales module.
 *   2. Creates "Customer App Dashboard" as sequence-0 child of Customer App.
 *   3. Moves the existing "customerOrders" module under Customer App (sequence 1).
 *   4. Moves the existing "customerPayment" module under Customer App (sequence 2).
 *   5. Adds role permissions for customerAppDashboard to all roles:
 *        Admin roles  -> view/create/edit/delete = true
 *        Other roles  -> view/create/edit/delete = false
 *
 * Customer Orders and Customer Payments keep their keys, paths, and existing role
 * permissions unchanged — only their parentModule and sequence change.
 *
 * Idempotent: re-running skips already-correct documents, syncs drifted fields,
 * and only adds missing role permissions.
 *
 * Run:
 *   node migrations/addCustomerAppModule.js              (dry run, all companies)
 *   node migrations/addCustomerAppModule.js --apply      (write, all companies)
 *   node migrations/addCustomerAppModule.js <companyId>           (dry run, one company)
 *   node migrations/addCustomerAppModule.js <companyId> --apply   (write, one company)
 */

const { ObjectId } = require('mongodb');
const { getConnection, closeConnection } = require('../config/db');
const { RIGHT_LIST } = require('../utils/enum');

// ─── Module definitions ────────────────────────────────────────────────────

const CUSTOMER_APP_MODULE = {
  name: 'Customer App',
  description: 'Customer App',
  path: '/customer-app',
  icon: 'MobileOutlined',
  isActive: true,
  key: RIGHT_LIST.CUSTOMER_APP,
  featureName: 'CUSTOMER_ORDER',
};

const CUSTOMER_APP_DASHBOARD_MODULE = {
  name: 'Customer App Dashboard',
  description: 'Customer App Dashboard',
  path: '/customer-app-dashboard',
  icon: 'DashboardOutlined',
  isActive: true,
  key: RIGHT_LIST.CUSTOMER_APP_DASHBOARD,
  featureName: 'CUSTOMER_ORDER',
};

const SYNC_FIELDS_PARENT = ['name', 'description', 'path', 'icon', 'isActive', 'featureName'];
const SYNC_FIELDS_DASHBOARD = ['name', 'description', 'path', 'icon', 'isActive', 'featureName'];

const ADMIN_PERMISSION = { view: true, create: true, edit: true, delete: true };
const DEFAULT_PERMISSION = { view: false, create: false, edit: false, delete: false };
const isAdminRole = roleName => /^admin$/i.test(roleName || '');

// ─── Arg parsing ───────────────────────────────────────────────────────────

const parseArgs = () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const companyArg = args.find(a => !a.startsWith('--'));
  if (companyArg && !ObjectId.isValid(companyArg)) {
    throw new Error(`Invalid companyId: ${companyArg}`);
  }
  return { apply, targetCompanyId: companyArg ? new ObjectId(companyArg) : null };
};

// ─── Step 1 — Create / update the Customer App parent module ──────────────

const ensureCustomerAppParent = async (modules, apply, now) => {
  // Anchor: place Customer App directly after Sales
  const salesModule = await modules.findOne({ key: 'sales' });
  if (!salesModule) {
    throw new Error("Anchor module 'sales' not found. Cannot decide where to place 'customerApp'.");
  }
  const targetSequence = (salesModule.sequence || 0) + 1;
  console.log(`\n[1] Customer App parent — anchor: sales (sequence ${salesModule.sequence}) → target sequence ${targetSequence}`);

  const existing = await modules.findOne({ key: RIGHT_LIST.CUSTOMER_APP });

  if (existing) {
    const patch = {};
    SYNC_FIELDS_PARENT.forEach(f => {
      if (existing[f] !== CUSTOMER_APP_MODULE[f]) patch[f] = CUSTOMER_APP_MODULE[f];
    });
    const alreadyCorrect = existing.parentModule == null && existing.sequence === targetSequence;
    if (!alreadyCorrect) {
      // Shift top-level siblings to free the slot
      const siblingFilter = { parentModule: null, sequence: { $gte: targetSequence }, _id: { $ne: existing._id } };
      const siblings = await modules.find(siblingFilter).project({ key: 1, sequence: 1 }).sort({ sequence: 1 }).toArray();
      console.log(
        `   Shifting ${siblings.length} top-level sibling(s) down by 1: ${siblings.map(s => `${s.key}(${s.sequence})`).join(', ') || '-'}`,
      );
      if (apply && siblings.length) {
        await modules.updateMany(siblingFilter, { $inc: { sequence: 1 }, $set: { updatedAt: now } });
      }
      patch.parentModule = null;
      patch.sequence = targetSequence;
    }
    if (!Object.keys(patch).length) {
      console.log(`   Already correct (id: ${existing._id}). Nothing to update.`);
      return existing._id;
    }
    console.log(`   Would update: ${JSON.stringify(patch)}`);
    if (apply) {
      await modules.updateOne({ _id: existing._id }, { $set: { ...patch, updatedAt: now } });
    }
    return existing._id;
  }

  // Insert new
  const moduleId = new ObjectId();
  const siblingFilter = { parentModule: null, sequence: { $gte: targetSequence } };
  const siblings = await modules.find(siblingFilter).project({ key: 1, sequence: 1 }).sort({ sequence: 1 }).toArray();
  console.log(
    `   Shifting ${siblings.length} top-level sibling(s) down by 1: ${siblings.map(s => `${s.key}(${s.sequence})`).join(', ') || '-'}`,
  );
  if (apply && siblings.length) {
    await modules.updateMany(siblingFilter, { $inc: { sequence: 1 }, $set: { updatedAt: now } });
  }
  console.log(`   Would insert: ${CUSTOMER_APP_MODULE.name} (${CUSTOMER_APP_MODULE.key}) sequence=${targetSequence}`);
  if (apply) {
    await modules.insertOne({
      _id: moduleId,
      ...CUSTOMER_APP_MODULE,
      parentModule: null,
      sequence: targetSequence,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
  }
  return moduleId;
};

// ─── Step 2 — Create / update Customer App Dashboard child ─────────────────

const ensureDashboard = async (modules, customerAppId, apply, now) => {
  const SEQUENCE = 0;
  console.log(`\n[2] Customer App Dashboard — parent: ${customerAppId} sequence=${SEQUENCE}`);

  const existing = await modules.findOne({ key: RIGHT_LIST.CUSTOMER_APP_DASHBOARD });

  if (existing) {
    const patch = {};
    SYNC_FIELDS_DASHBOARD.forEach(f => {
      if (existing[f] !== CUSTOMER_APP_DASHBOARD_MODULE[f]) patch[f] = CUSTOMER_APP_DASHBOARD_MODULE[f];
    });
    if (String(existing.parentModule) !== String(customerAppId) || existing.sequence !== SEQUENCE) {
      patch.parentModule = customerAppId;
      patch.sequence = SEQUENCE;
    }
    if (!Object.keys(patch).length) {
      console.log(`   Already correct (id: ${existing._id}). Nothing to update.`);
      return existing._id;
    }
    console.log(`   Would update: ${JSON.stringify(patch)}`);
    if (apply) {
      await modules.updateOne({ _id: existing._id }, { $set: { ...patch, updatedAt: now } });
    }
    return existing._id;
  }

  const moduleId = new ObjectId();
  console.log(`   Would insert: ${CUSTOMER_APP_DASHBOARD_MODULE.name} (${CUSTOMER_APP_DASHBOARD_MODULE.key})`);
  if (apply) {
    await modules.insertOne({
      _id: moduleId,
      ...CUSTOMER_APP_DASHBOARD_MODULE,
      parentModule: customerAppId,
      sequence: SEQUENCE,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
  }
  return moduleId;
};

// ─── Steps 3 & 4 — Move existing modules under Customer App ────────────────

const moveModule = async (modules, key, customerAppId, sequence, apply, now) => {
  const mod = await modules.findOne({ key });
  if (!mod) {
    console.log(`\n[move] Module '${key}' not found — skipping.`);
    return;
  }
  const alreadyCorrect = String(mod.parentModule) === String(customerAppId) && mod.sequence === sequence;
  if (alreadyCorrect) {
    console.log(`\n[move] '${key}' already under Customer App at sequence ${sequence}. Nothing to do.`);
    return;
  }
  console.log(`\n[move] '${key}': parentModule ${mod.parentModule} → ${customerAppId}, sequence ${mod.sequence} → ${sequence}`);
  if (apply) {
    await modules.updateOne({ _id: mod._id }, { $set: { parentModule: customerAppId, sequence, updatedAt: now } });
  }
};

// ─── Step 5 — Seed role permissions for Customer App Dashboard ─────────────

const seedRolePermissions = async (roles, dashboardId, targetCompanyId, apply) => {
  const roleFilter = {
    'permissions.module': { $ne: dashboardId },
    ...(targetCompanyId ? { company: targetCompanyId } : {}),
  };
  const rolesToUpdate = await roles.find(roleFilter).project({ _id: 1, role: 1, company: 1 }).toArray();
  const adminRoles = rolesToUpdate.filter(r => isAdminRole(r.role));

  console.log(`\n[5] Role permissions for customerAppDashboard:`);
  console.log(`   Roles missing permission : ${rolesToUpdate.length}`);
  console.log(`   Admin (full access)      : ${adminRoles.length}`);
  console.log(`   Others (no access)       : ${rolesToUpdate.length - adminRoles.length}`);

  const operations = rolesToUpdate.map(role => ({
    updateOne: {
      filter: { _id: role._id, 'permissions.module': { $ne: dashboardId } },
      update: {
        $push: {
          permissions: {
            module: dashboardId,
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
  return { rolesToUpdate: operations.length, rolesUpdated };
};

// ─── Main ──────────────────────────────────────────────────────────────────

const migrate = async () => {
  let client;
  try {
    const { apply, targetCompanyId } = parseArgs();
    const db = await getConnection();
    client = db.client;

    console.log(`\nScope : ${targetCompanyId ? `company ${targetCompanyId}` : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode  : APPLYING CHANGES\n' : 'Mode  : DRY RUN — pass --apply to write\n');

    const modules = db.books.collection('modules');
    const roles = db.books.collection('roles');
    const now = new Date();

    // 1. Ensure Customer App parent
    const customerAppId = await ensureCustomerAppParent(modules, apply, now);

    // 2. Ensure Customer App Dashboard child
    const dashboardId = await ensureDashboard(modules, customerAppId, apply, now);

    // 3. Move Customer Orders under Customer App
    await moveModule(modules, RIGHT_LIST.CUSTOMER_ORDER, customerAppId, 1, apply, now);

    // 4. Move Customer Payments under Customer App
    await moveModule(modules, RIGHT_LIST.CUSTOMER_PAYMENT, customerAppId, 2, apply, now);

    // 5. Seed role permissions for dashboard
    const { rolesToUpdate, rolesUpdated } = await seedRolePermissions(roles, dashboardId, targetCompanyId, apply);

    console.log('\n─── SUMMARY ─────────────────────────────────');
    console.log(`   customerApp      id : ${customerAppId}`);
    console.log(`   customerAppDashboard id : ${dashboardId}`);
    console.log(`   roles to update  : ${rolesToUpdate}`);
    console.log(`   roles updated    : ${rolesUpdated}`);

    if (!apply) {
      console.log('\nNothing written. Re-run with --apply to commit.\n');
    } else {
      console.log('\nCustomer App module seeded successfully.\n');
    }
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await closeConnection(client);
  }
};

migrate();
