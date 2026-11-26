/**
 * Seeds the Customer Payments module into books.modules and adds its permission entry to roles.
 *
 * Module:
 *   key 'customerPayment', featureName 'CUSTOMER_ORDER' (plan gated like the customer portal).
 *   Placed under the same parent as the 'paymentReceived' module, directly above it: it takes
 *   Payment Received's sequence and Payment Received plus every sibling after it shift down by one.
 *   If the module already exists in a different position, it is moved to that slot.
 *
 * Role permissions (only roles that do not already have an entry for this module):
 *   Admin roles  -> view/create/edit/delete = true
 *   Other roles  -> view/create/edit/delete = false (deny by default, enable from Roles screen)
 *
 * Idempotent: re-running skips the insert, syncs drifted module fields, and only adds
 * missing role permissions. Modules are global; <companyId> only scopes the role updates.
 *
 * Run: node migrations/addCustomerPaymentModule-remove.js                       (dry run, all companies)
 *      node migrations/addCustomerPaymentModule-remove.js --apply               (write, all companies)
 *      node migrations/addCustomerPaymentModule-remove.js <companyId>           (dry run, one company)
 *      node migrations/addCustomerPaymentModule-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection, closeConnection } = require('../config/db');
const { RIGHT_LIST } = require('../utils/enum');

// The new module is placed directly above this one in the sidebar.
const ANCHOR_MODULE_KEY = RIGHT_LIST.PAYMENT_RECEIVED;

const MODULE = {
  name: 'Customer Payments',
  description: 'Customer Payments',
  path: '/customer-payments',
  icon: 'CreditCardOutlined',
  isActive: true,
  key: RIGHT_LIST.CUSTOMER_PAYMENT,
  featureName: 'CUSTOMER_ORDER',
};

const SYNC_FIELDS = ['name', 'description', 'path', 'icon', 'isActive', 'featureName'];

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

const sameId = (a, b) => String(a ?? '') === String(b ?? '');

// True when the module already sits directly above the anchor under the same parent.
const isPlacedAboveAnchor = (moduleDoc, anchor) =>
  sameId(moduleDoc.parentModule, anchor.parentModule) && moduleDoc.sequence === anchor.sequence - 1;

/**
 * Frees the anchor's slot by shifting the anchor and every later sibling down by one, so the
 * module can take the anchor's old sequence. `excludeId` keeps the module itself out of the shift.
 */
const shiftSiblingsFromAnchor = async (modules, anchor, excludeId, apply, now) => {
  const siblingFilter = {
    parentModule: anchor.parentModule ?? null,
    sequence: { $gte: anchor.sequence },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  };
  const siblings = await modules.find(siblingFilter).project({ key: 1, sequence: 1 }).sort({ sequence: 1 }).toArray();
  console.log(
    `Would shift ${siblings.length} sibling(s) down by 1: ${siblings.map(s => `${s.key}(${s.sequence})`).join(', ') || '-'}`,
  );
  if (apply && siblings.length) {
    await modules.updateMany(siblingFilter, { $inc: { sequence: 1 }, $set: { updatedAt: now } });
  }
};

const ensureModule = async (modules, apply, now) => {
  const anchor = await modules.findOne({ key: ANCHOR_MODULE_KEY });
  if (!anchor) {
    throw new Error(`Anchor module '${ANCHOR_MODULE_KEY}' not found. Cannot decide where to place '${MODULE.key}'.`);
  }
  const targetSequence = anchor.sequence || 0;
  console.log(`Anchor: ${anchor.key} parent=${anchor.parentModule} sequence=${targetSequence}`);

  const existing = await modules.findOne({ key: MODULE.key });

  if (existing) {
    const patch = {};
    SYNC_FIELDS.forEach(field => {
      if (existing[field] !== MODULE[field]) patch[field] = MODULE[field];
    });

    if (!isPlacedAboveAnchor(existing, anchor)) {
      console.log(
        `Would move ${MODULE.key} from sequence=${existing.sequence} to sequence=${targetSequence} (above ${anchor.key})`,
      );
      await shiftSiblingsFromAnchor(modules, anchor, existing._id, apply, now);
      patch.parentModule = anchor.parentModule ?? null;
      patch.sequence = targetSequence;
    }

    if (!Object.keys(patch).length) {
      console.log(`Module already exists and is placed correctly: ${MODULE.key} -> ${existing._id}`);
      return { moduleId: existing._id, inserted: false, updated: false };
    }
    console.log(`Would update module ${MODULE.key}: ${JSON.stringify(patch)}`);
    if (apply) {
      await modules.updateOne({ _id: existing._id }, { $set: { ...patch, updatedAt: now } });
    }
    return { moduleId: existing._id, inserted: false, updated: apply };
  }

  const moduleId = new ObjectId();
  console.log(`Would insert module: ${MODULE.name} (${MODULE.key}) parent=${anchor.parentModule} sequence=${targetSequence}`);
  await shiftSiblingsFromAnchor(modules, anchor, null, apply, now);

  if (apply) {
    await modules.insertOne({
      _id: moduleId,
      ...MODULE,
      parentModule: anchor.parentModule ?? null,
      sequence: targetSequence,
      isCustomPlanModule: Boolean(anchor.isCustomPlanModule),
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

    // Roles that do not yet have a permission entry for this module.
    const roleFilter = {
      'permissions.module': { $ne: moduleId },
      ...(targetCompanyId ? { company: targetCompanyId } : {}),
    };
    const rolesToUpdate = await roles.find(roleFilter).project({ _id: 1, role: 1, company: 1 }).toArray();

    if (targetCompanyId && !(await roles.countDocuments({ company: targetCompanyId }))) {
      console.log(`\nNo roles found for company ${targetCompanyId}`);
    }

    const adminRoles = rolesToUpdate.filter(role => isAdminRole(role.role));
    console.log(`\nRoles missing '${MODULE.key}' permission: ${rolesToUpdate.length}`);
    console.log(`   admin (full access) : ${adminRoles.length}`);
    console.log(`   others (no access)  : ${rolesToUpdate.length - adminRoles.length}`);

    const operations = rolesToUpdate.map(role => ({
      updateOne: {
        // Re-check inside the filter so a concurrent run cannot push a duplicate entry.
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
    console.log('\nCustomer Payments module seeded.\n');
  } catch (error) {
    console.error('Customer Payments module seed failed:', error);
    process.exitCode = 1;
  } finally {
    await closeConnection(client);
  }
};

migrate();
