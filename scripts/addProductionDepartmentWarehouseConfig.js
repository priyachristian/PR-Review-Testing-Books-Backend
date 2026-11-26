/**
 * Add Production Department Warehouse Config
 *
 * Updates:
 * 1. Common DB:
 *    - Adds productionDepartmentWarehouseConfig: [] to existing CompanySettings
 *      documents where the field is missing or null.
 *
 * 2. Books DB:
 *    - Admin roles: all permissions true.
 *    - Non-admin roles: all permissions false.
 *
 * Usage:
 *   node scripts/addProductionDepartmentWarehouseConfig.js
 *   node scripts/addProductionDepartmentWarehouseConfig.js --apply
 *   node scripts/addProductionDepartmentWarehouseConfig.js --apply --companyId=xxx
 *
 * Dry run is the default.
 * Use --apply to actually update records.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

const isApply = process.argv.includes('--apply');

const companyIdArg = process.argv.find(arg => arg.startsWith('--companyId='));
const companyId = companyIdArg?.split('=')[1]?.trim();

const permission = {
  view: true,
  add: true,
  update: true,
  delete: true,
};

const noPermission = {
  view: false,
  add: false,
  update: false,
  delete: false,
};

const migrate = async () => {
  let client;

  try {
    // Validate company ID.
    if (companyId && !mongoose.Types.ObjectId.isValid(companyId)) {
      throw new Error('Invalid companyId');
    }

    // Establish database connection.
    const db = await getConnection();

    client = db.client;

    const commonDb = db.common;
    const booksDb = db.books;

    // Prepare company filters.
    const objectId = companyId ? new mongoose.Types.ObjectId(companyId) : null;

    const companySettingsFilter = companyId ? { companyId: objectId } : {};

    const roleFilter = companyId ? { company: objectId } : {};
    const missingConfigPermission = { 'otherSettings.productionDepartmentWarehouseConfig': { $exists: false } };

    // Collection names.
    const companySettingsCollection = commonDb.collection('companysettings');
    const roleCollection = booksDb.collection('roles');

    // CompanySettings: field missing or null.
    const companySettingsQuery = {
      ...companySettingsFilter,
      productionDepartmentWarehouseConfig: null,
    };

    // Admin roles.
    const adminRoleQuery = {
      ...roleFilter,
      ...missingConfigPermission,
      role: /^admin$/i,
    };

    // Non-admin roles.
    // Excludes documents where role is missing.
    const nonAdminRoleQuery = {
      ...roleFilter,
      ...missingConfigPermission,
      role: {
        $exists: true,
        $not: /^admin$/i,
      },
    };

    // Count records before migration.
    const companySettingsCount = await companySettingsCollection.countDocuments(companySettingsQuery);

    const adminRoleCount = await roleCollection.countDocuments(adminRoleQuery);

    const nonAdminRoleCount = await roleCollection.countDocuments(nonAdminRoleQuery);

    console.log('\n========== MIGRATION SUMMARY ==========');
    console.log('Mode:', isApply ? 'APPLY' : 'DRY RUN');
    console.log('Company ID:', companyId || 'All companies');
    console.log('Common DB - CompanySettings:', companySettingsCount);
    console.log('Books DB - Admin Roles:', adminRoleCount);
    console.log('Books DB - Non-admin Roles:', nonAdminRoleCount);

    // Stop here in dry-run mode.
    if (!isApply) {
      console.log('\nDry run completed. Use --apply to update records.');
      return;
    }

    // 1. Update CompanySettings in Common DB.
    const companySettingsResult = await companySettingsCollection.updateMany(companySettingsQuery, {
      $set: {
        productionDepartmentWarehouseConfig: [],
      },
    });

    // 2. Update Admin Roles in Books DB.
    const adminResult = await roleCollection.updateMany(adminRoleQuery, {
      $set: {
        'otherSettings.productionDepartmentWarehouseConfig': permission,
      },
    });

    // 3. Update Non-admin Roles in Books DB.
    const nonAdminResult = await roleCollection.updateMany(nonAdminRoleQuery, {
      $set: {
        'otherSettings.productionDepartmentWarehouseConfig': noPermission,
      },
    });

    console.log('\n========== MIGRATION RESULT ==========');

    console.log('CompanySettings modified:', companySettingsResult.modifiedCount);

    console.log('Admin Roles modified:', adminResult.modifiedCount);

    console.log('Non-admin Roles modified:', nonAdminResult.modifiedCount);

    console.log('\nMigration completed successfully.');
  } catch (error) {
    console.error('\nMigration failed:', error);
    process.exitCode = 1;
  } finally {
    // Close MongoDB connection.
    if (client) {
      await client.close();
      console.log('\nMongoDB connection closed.');
    }
  }
};

migrate();
