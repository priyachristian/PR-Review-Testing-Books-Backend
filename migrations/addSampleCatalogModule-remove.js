/**
 * Seeds the Sample Catalogs module under Customer App, its role permissions and its numbering rows
 * (booksCrm.modulesettings). Touches nothing else. Idempotent, dry run unless --apply.
 * Admin roles get full access, other roles get none (deny by default, enable from the Roles screen).
 *
 * Run: node migrations/addSampleCatalogModule-remove.js                       (dry run, all companies)
 *      node migrations/addSampleCatalogModule-remove.js --apply               (write, all companies)
 *      node migrations/addSampleCatalogModule-remove.js <companyId>           (dry run, one company)
 *      node migrations/addSampleCatalogModule-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection, closeConnection } = require('../config/db');
const { RIGHT_LIST, MODULE_NAMES } = require('../utils/enum');

const PARENT_MODULE_KEY = RIGHT_LIST.CUSTOMER_APP;

// Order here is the sidebar order under Customer App.
const MODULES = [
  {
    name: 'Sample Catalogs',
    description: 'Sample Catalogs',
    path: '/sample-catalogs',
    icon: 'AppstoreOutlined',
    isActive: true,
    key: RIGHT_LIST.SAMPLE_CATALOG,
    featureName: 'CUSTOMER_ORDER',
  },
];

const MODULE_SETTINGS = [{ moduleName: MODULE_NAMES.SAMPLE_CATALOG, prefix: 'SC-' }];
const STARTING_SEQUENCE = '0001';

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

const ensureModules = async (modules, apply, now) => {
  const parent = await modules.findOne({ key: PARENT_MODULE_KEY });
  if (!parent) {
    throw new Error(`Parent module '${PARENT_MODULE_KEY}' not found. Run migrations/addCustomerAppModule.js first.`);
  }

  const [lastChild] = await modules.find({ parentModule: parent._id }).sort({ sequence: -1 }).limit(1).toArray();
  let nextSequence = (lastChild?.sequence ?? -1) + 1;
  const moduleIds = [];

  for (const moduleDef of MODULES) {
    const existing = await modules.findOne({ key: moduleDef.key });

    // Insert only: an existing row is left untouched.
    if (existing) {
      console.log(`Module already exists, skipped: ${moduleDef.key} -> ${existing._id}`);
      moduleIds.push({ key: moduleDef.key, id: existing._id, isNew: false });
      continue;
    }

    const moduleId = new ObjectId();
    const sequence = nextSequence++;
    console.log(`Would insert module ${moduleDef.name} (${moduleDef.key}) under ${parent.key} sequence=${sequence}`);
    if (apply) {
      await modules.insertOne({
        _id: moduleId,
        ...moduleDef,
        parentModule: parent._id,
        sequence,
        isCustomPlanModule: Boolean(parent.isCustomPlanModule),
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
    }
    moduleIds.push({ key: moduleDef.key, id: moduleId, isNew: true });
  }

  return moduleIds;
};

const ensureRolePermissions = async (roles, moduleIds, targetCompanyId, apply) => {
  const companyFilter = targetCompanyId ? { company: targetCompanyId } : {};
  const operations = [];

  for (const { key, id } of moduleIds) {
    const rolesToUpdate = await roles
      .find({ 'permissions.module': { $ne: id }, ...companyFilter })
      .project({ _id: 1, role: 1 })
      .toArray();
    const adminCount = rolesToUpdate.filter(role => isAdminRole(role.role)).length;
    console.log(
      `Roles missing '${key}': ${rolesToUpdate.length} (admin ${adminCount}, others ${rolesToUpdate.length - adminCount})`,
    );

    rolesToUpdate.forEach(role =>
      operations.push({
        updateOne: {
          // Re-checked in the filter so a concurrent run cannot push a duplicate entry.
          filter: { _id: role._id, 'permissions.module': { $ne: id } },
          update: {
            $push: { permissions: { module: id, ...(isAdminRole(role.role) ? ADMIN_PERMISSION : DEFAULT_PERMISSION) } },
          },
        },
      }),
    );
  }

  if (!apply || !operations.length) return { planned: operations.length, updated: 0 };
  const result = await roles.bulkWrite(operations, { ordered: false });
  return { planned: operations.length, updated: result.modifiedCount };
};

const ensureModuleSettings = async (db, targetCompanyId, apply, now) => {
  const moduleSettings = db.booksCrm.collection('modulesettings');
  const companyIds = targetCompanyId
    ? [targetCompanyId]
    : await db.books.collection('userroles').distinct('companyId', { companyId: { $ne: null } });

  const docs = [];
  for (const { moduleName, prefix } of MODULE_SETTINGS) {
    const existing = await moduleSettings
      .find({ moduleName, companyId: { $in: companyIds } })
      .project({ companyId: 1 })
      .toArray();
    const existingIds = new Set(existing.map(doc => String(doc.companyId)));
    const missing = companyIds.filter(id => !existingIds.has(String(id)));
    console.log(`${moduleName} settings: ${existingIds.size} exist, ${missing.length} to insert (${prefix}${STARTING_SEQUENCE})`);

    missing.forEach(companyId =>
      docs.push({
        useCustomPrefix: true,
        startingSequence: STARTING_SEQUENCE,
        nextSequence: STARTING_SEQUENCE,
        companyId,
        moduleName,
        prefix,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      }),
    );
  }

  if (!apply || !docs.length) return { planned: docs.length, inserted: 0 };
  const result = await moduleSettings.insertMany(docs, { ordered: false });
  return { planned: docs.length, inserted: result.insertedCount };
};

const migrate = async () => {
  let client;
  try {
    const { apply, targetCompanyId } = parseArgs();
    const db = await getConnection();
    client = db.client;

    console.log(`\nScope : ${targetCompanyId ? `company ${targetCompanyId}` : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode  : APPLYING CHANGES\n' : 'Mode  : DRY RUN, pass --apply to write\n');

    const now = new Date();
    const moduleIds = await ensureModules(db.books.collection('modules'), apply, now);
    const roleResult = await ensureRolePermissions(db.books.collection('roles'), moduleIds, targetCompanyId, apply);
    const settingsResult = await ensureModuleSettings(db, targetCompanyId, apply, now);

    console.log('\nSUMMARY');
    moduleIds.forEach(({ key, id, isNew }) =>
      console.log(`   ${key.padEnd(16)}: ${id}${isNew && !apply ? ' (preview id, not saved)' : ''}`),
    );
    console.log(`   role permissions : ${roleResult.updated}/${roleResult.planned} written`);
    console.log(`   module settings  : ${settingsResult.inserted}/${settingsResult.planned} written`);

    if (!apply) console.log('\nNothing was written. Re-run with --apply to seed.\n');
  } catch (error) {
    console.error('Sample catalog module seed failed:', error);
    process.exitCode = 1;
  } finally {
    await closeConnection(client);
  }
};

migrate();
