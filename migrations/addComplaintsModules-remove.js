/**
 * Seeds the Complaints sidebar module tree into books.modules and grants
 * Admin roles full CRUD on those modules.
 *
 * Parent (sequence 13):
 *   Complaints
 * Children (sequence 1..3):
 *   1. Problem List
 *   2. Complaints
 *   3. Complaints Reports
 *
 * Idempotent by module `key`. Re-running inserts missing keys, syncs
 * name/path/etc on existing modules, and adds missing Admin permissions.
 *
 * Modules are global. <companyId> only scopes Admin role permission updates.
 *
 * Run: node migrations/addComplaintsModules-remove.js
 *      node migrations/addComplaintsModules-remove.js --apply
 *      node migrations/addComplaintsModules-remove.js <companyId>
 *      node migrations/addComplaintsModules-remove.js <companyId> --apply
 */
const { ObjectId } = require('mongodb');
const { getConnection, closeConnection } = require('../config/db');

const PARENT = {
  name: 'Complaints',
  description: 'Complaints',
  path: '/complaints',
  icon: 'AlertOutlined',
  sequence: 13,
  isActive: true,
  key: 'complaints',
  isCustomPlanModule: false,
};

const CHILDREN = [
  {
    name: 'Problem List',
    description: 'Problem List',
    path: '/problem-list',
    icon: 'UnorderedListOutlined',
    sequence: 1,
    isActive: true,
    key: 'problemList',
    featureName: null,
    isCustomPlanModule: false,
  },
  {
    name: 'Complaints',
    description: 'Complaints',
    path: '/complaints',
    icon: 'FileTextOutlined',
    sequence: 2,
    isActive: true,
    key: 'complaintsList',
    featureName: null,
    isCustomPlanModule: false,
  },
  {
    name: 'Complaints Reports',
    description: 'Complaints Reports',
    path: '/complaints/reports',
    icon: 'BarChartOutlined',
    sequence: 3,
    isActive: true,
    key: 'complaintsReports',
    featureName: null,
    isCustomPlanModule: false,
  },
];

const FULL_PERMISSION = {
  view: true,
  create: true,
  edit: true,
  delete: true,
};

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`\nScope : ${targetCompanyId ? `company ${targetCompanyId}` : 'ALL ADMIN ROLES'}`);
    console.log(apply ? 'Mode  : APPLYING CHANGES\n' : 'Mode  : report only — pass --apply to write\n');

    const modules = db.books.collection('modules');
    const roles = db.books.collection('roles');
    const now = new Date();

    const allKeys = [PARENT.key, ...CHILDREN.map(child => child.key)];
    const existing = await modules
      .find({ key: { $in: allKeys } })
      .project({ _id: 1, key: 1, name: 1, description: 1, path: 1, icon: 1, sequence: 1, featureName: 1, isCustomPlanModule: 1 })
      .toArray();
    const existingByKey = new Map(existing.map(doc => [doc.key, doc]));

    let parentId = existingByKey.get(PARENT.key)?._id || null;
    let modulesInserted = 0;
    let modulesUpdated = 0;

    const syncFields = ['name', 'description', 'path', 'icon', 'sequence', 'featureName', 'isCustomPlanModule'];
    const getSyncPatch = (desired, current) => {
      const patch = {};
      for (const field of syncFields) {
        if (desired[field] === undefined) continue;
        if (current?.[field] !== desired[field]) {
          patch[field] = desired[field];
        }
      }
      return patch;
    };

    if (!parentId) {
      parentId = new ObjectId();
      console.log(`Would insert parent: ${PARENT.name} (${PARENT.key}) sequence=${PARENT.sequence}`);
      if (apply) {
        await modules.insertOne({
          _id: parentId,
          ...PARENT,
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
        modulesInserted += 1;
        existingByKey.set(PARENT.key, { _id: parentId, key: PARENT.key, name: PARENT.name });
      }
    } else {
      const parentPatch = getSyncPatch(PARENT, existingByKey.get(PARENT.key));
      if (Object.keys(parentPatch).length) {
        console.log(`Would update parent ${PARENT.key}: ${JSON.stringify(parentPatch)}`);
        if (apply) {
          await modules.updateOne({ _id: parentId }, { $set: { ...parentPatch, updatedAt: now } });
          modulesUpdated += 1;
        }
      } else {
        console.log(`Parent already exists: ${PARENT.name} (${PARENT.key}) → ${parentId}`);
      }
    }

    for (const child of CHILDREN) {
      const found = existingByKey.get(child.key);
      if (found) {
        const childPatch = getSyncPatch(child, found);
        if (Object.keys(childPatch).length) {
          console.log(`Would update child ${child.key}: ${JSON.stringify(childPatch)}`);
          if (apply) {
            // eslint-disable-next-line no-await-in-loop
            await modules.updateOne({ _id: found._id }, { $set: { ...childPatch, updatedAt: now } });
            modulesUpdated += 1;
          }
        } else {
          console.log(`Child already exists: ${child.name} (${child.key}) → ${found._id}`);
        }
        continue;
      }

      const childId = new ObjectId();
      console.log(`Would insert child: ${child.name} (${child.key}) sequence=${child.sequence} parent=${parentId}`);
      if (apply) {
        await modules.insertOne({
          _id: childId,
          ...child,
          parentModule: parentId,
          createdAt: now,
          updatedAt: now,
          __v: 0,
        });
        modulesInserted += 1;
        existingByKey.set(child.key, { _id: childId, key: child.key, name: child.name });
      }
    }

    // Permission grant preview/apply uses only modules that already exist in DB
    // (after inserts when --apply). New keys are created above first.
    const moduleIdsForPermissions = (
      await modules
        .find({ key: { $in: allKeys } })
        .project({ _id: 1, key: 1 })
        .toArray()
    ).map(doc => doc._id);

    if (!apply) {
      const missingKeys = allKeys.filter(key => !existingByKey.has(key));
      console.log(`\nModules missing (would insert): ${missingKeys.length}`);
      missingKeys.forEach(key => console.log(`  - ${key}`));
      console.log(`Modules already present for permission grant check: ${moduleIdsForPermissions.length}`);
    } else {
      console.log(`\nModules to grant on Admin roles: ${moduleIdsForPermissions.length}`);
    }

    const adminRoleFilter = {
      role: { $regex: /^admin$/i },
      ...(targetCompanyId ? { company: targetCompanyId } : {}),
    };

    const adminRoles = await roles.find(adminRoleFilter).project({ _id: 1, role: 1, company: 1, permissions: 1 }).toArray();

    if (targetCompanyId && !adminRoles.length) {
      console.log(`No Admin role found for company ${targetCompanyId}`);
    } else {
      console.log(`Admin roles found: ${adminRoles.length}`);
    }

    let rolesUpdated = 0;
    let permissionsAdded = 0;

    for (const role of adminRoles) {
      const existingModuleIds = new Set(
        (role.permissions || []).map(permission => permission.module?.toString()).filter(Boolean),
      );
      const missing = moduleIdsForPermissions.filter(id => !existingModuleIds.has(id.toString()));
      if (!missing.length) {
        continue;
      }

      console.log(`  Role ${role._id} (${role.role}) company=${role.company} missing permissions: ${missing.length}`);
      permissionsAdded += missing.length;

      if (apply) {
        // eslint-disable-next-line no-await-in-loop
        await roles.updateOne(
          { _id: role._id },
          {
            $push: {
              permissions: {
                $each: missing.map(moduleId => ({
                  module: moduleId,
                  ...FULL_PERMISSION,
                })),
              },
            },
          },
        );
        rolesUpdated += 1;
      }
    }

    console.log('\nSUMMARY');
    console.log(`   modules inserted     : ${modulesInserted}`);
    console.log(`   modules updated      : ${modulesUpdated}`);
    console.log(`   admin roles updated  : ${rolesUpdated}`);
    console.log(`   permissions to add   : ${permissionsAdded}`);

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to seed.\n');
      return;
    }

    console.log('\nComplaints modules seeded.\n');
  } catch (error) {
    console.error('Complaints modules seed failed:', error);
    process.exitCode = 1;
  } finally {
    await closeConnection(client);
  }
};

migrate();
