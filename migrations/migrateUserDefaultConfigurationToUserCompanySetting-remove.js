/**
 * Migration: move User.defaultConfiguration into UserCompanySetting (per company).
 *
 * Associates each user's existing defaultConfiguration with companies they own
 * via Company.addedBy. Users with config who own no companies are reported and skipped.
 *
 * Dry-run by default — prints what would change, writes nothing.
 * Pass --apply to actually write.
 *
 * Usage:
 *   node migrations/migrateUserDefaultConfigurationToUserCompanySetting-remove.js up
 *   node migrations/migrateUserDefaultConfigurationToUserCompanySetting-remove.js up --companyId=<id>
 *   node migrations/migrateUserDefaultConfigurationToUserCompanySetting-remove.js up --apply
 *   node migrations/migrateUserDefaultConfigurationToUserCompanySetting-remove.js up --companyId=<id> --apply
 *   node migrations/migrateUserDefaultConfigurationToUserCompanySetting-remove.js down --companyId=<id>
 *   node migrations/migrateUserDefaultConfigurationToUserCompanySetting-remove.js down --companyId=<id> --apply
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const parseArgs = argv => {
  const companyHit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = companyHit === undefined ? undefined : companyHit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return {
    companyId: companyArg ? new ObjectId(companyArg) : null,
    apply: argv.includes('--apply'),
  };
};

const hasUsableDefaultConfiguration = user => {
  const config = user.defaultConfiguration;
  if (!config || typeof config !== 'object') {
    return false;
  }
  return Boolean(config.divisionId || config.branchId || config.warehouseId);
};

const upsertSetting = async (userCompanySettings, user, companyId) => {
  const now = new Date();
  await userCompanySettings.updateOne(
    { userId: user._id, companyId },
    {
      $set: {
        defaultConfiguration: user.defaultConfiguration,
        updatedAt: now,
      },
      $unset: {
        migratedFromUserDefaultConfiguration: '',
      },
      $setOnInsert: {
        userId: user._id,
        companyId,
        createdAt: now,
      },
    },
    { upsert: true },
  );
};

module.exports = {
  /**
   * Apply the migration.
   * Pass --companyId=<id> to migrate only that company's owner (easy local test).
   * After a successful copy, User.defaultConfiguration is unset.
   * Writes only when --apply is passed.
   */
  async up() {
    const { client, common } = await getConnection();

    try {
      const { companyId, apply } = parseArgs(process.argv.slice(3));
      const users = common.collection('users');
      const companies = common.collection('companies');
      const userCompanySettings = common.collection('usercompanysettings');

      console.log(apply ? 'Mode: APPLY (writes enabled)' : 'Mode: DRY RUN (no writes). Re-run with --apply to write.');

      if (apply) {
        await userCompanySettings.createIndex({ userId: 1, companyId: 1 }, { unique: true });
        // Strip leftover internal rollback marker from an earlier migration version
        const cleanup = await userCompanySettings.updateMany(
          { migratedFromUserDefaultConfiguration: { $exists: true } },
          { $unset: { migratedFromUserDefaultConfiguration: '' } },
        );
        if (cleanup.modifiedCount) {
          console.log(`Removed migratedFromUserDefaultConfiguration from ${cleanup.modifiedCount} doc(s)`);
        }
      }

      if (companyId) {
        const company = await companies.findOne({ _id: companyId }, { projection: { _id: 1, name: 1, addedBy: 1 } });
        if (!company) {
          throw new Error(`Company ${companyId} not found`);
        }
        if (!company.addedBy) {
          throw new Error(`Company ${companyId} (${company.name}) has no addedBy user`);
        }

        const user = await users.findOne({ _id: company.addedBy }, { projection: { _id: 1, email: 1, defaultConfiguration: 1 } });
        if (!user) {
          throw new Error(`Owner user ${company.addedBy} not found for company ${companyId}`);
        }
        if (!hasUsableDefaultConfiguration(user)) {
          console.log(
            `Company ${company.name} (${companyId}): owner ${user._id} has no usable defaultConfiguration. Nothing to do.`,
          );
          console.log('✅ Migration up completed');
          return;
        }

        if (apply) {
          await upsertSetting(userCompanySettings, user, company._id);
          await users.updateOne({ _id: user._id }, { $unset: { defaultConfiguration: '' } });
          console.log(`Upserted UserCompanySetting for company=${company.name} (${companyId}), user=${user.email || user._id}`);
          console.log(`Unset User.defaultConfiguration for user=${user.email || user._id}`);
        } else {
          console.log(
            `[dry run] Would upsert UserCompanySetting for company=${company.name} (${companyId}), user=${user.email || user._id}`,
          );
          console.log(`[dry run] defaultConfiguration: ${JSON.stringify(user.defaultConfiguration)}`);
          console.log(`[dry run] Would unset User.defaultConfiguration for user=${user.email || user._id}`);
          console.log('Re-run with --apply to write.');
        }
        console.log('✅ Migration up completed');
        return;
      }

      const usersWithConfig = await users
        .find({ defaultConfiguration: { $exists: true, $ne: null } })
        .project({ _id: 1, email: 1, defaultConfiguration: 1 })
        .toArray();

      let migratedUsers = 0;
      let upsertedSettings = 0;
      const skippedNoCompany = [];
      const skippedEmptyConfig = [];

      for (const user of usersWithConfig) {
        if (!hasUsableDefaultConfiguration(user)) {
          skippedEmptyConfig.push(String(user._id));
          continue;
        }

        const ownedCompanies = await companies.find({ addedBy: user._id }).project({ _id: 1, name: 1 }).toArray();

        if (!ownedCompanies.length) {
          skippedNoCompany.push({
            userId: String(user._id),
            email: user.email || null,
          });
          continue;
        }

        for (const company of ownedCompanies) {
          if (apply) {
            await upsertSetting(userCompanySettings, user, company._id);
          } else {
            console.log(
              `[dry run] Would upsert UserCompanySetting user=${user.email || user._id} company=${company.name} (${company._id})`,
            );
          }
          upsertedSettings += 1;
        }

        if (apply) {
          await users.updateOne({ _id: user._id }, { $unset: { defaultConfiguration: '' } });
        }
        migratedUsers += 1;
      }

      const action = apply ? 'migrated' : 'would migrate';
      console.log(`Users scanned with defaultConfiguration field: ${usersWithConfig.length}`);
      console.log(`Users ${action} (config unset): ${migratedUsers}`);
      console.log(`UserCompanySetting upserts ${apply ? '' : '(planned)'}: ${upsertedSettings}`);
      console.log(`Skipped (empty/null config ids): ${skippedEmptyConfig.length}`);
      console.log(`Skipped (no owned company via addedBy): ${skippedNoCompany.length}`);
      if (skippedNoCompany.length) {
        console.log('Users with config but no Company.addedBy match (not migrated):');
        skippedNoCompany.forEach(entry => console.log(`  - ${entry.userId} ${entry.email || ''}`));
      }
      if (!apply) {
        console.log('Re-run with --apply to write.');
      }

      console.log('✅ Migration up completed');
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },

  /**
   * Revert for one company (--companyId required).
   * Restores that company's UserCompanySetting.defaultConfiguration onto the owner User,
   * then deletes the UserCompanySetting doc.
   * Writes only when --apply is passed.
   */
  async down() {
    const { client, common } = await getConnection();

    try {
      const { companyId, apply } = parseArgs(process.argv.slice(3));
      if (!companyId) {
        throw new Error('--companyId=<id> is required for down (avoids deleting user-created settings)');
      }

      const users = common.collection('users');
      const companies = common.collection('companies');
      const userCompanySettings = common.collection('usercompanysettings');

      console.log(apply ? 'Mode: APPLY (writes enabled)' : 'Mode: DRY RUN (no writes). Re-run with --apply to write.');

      const company = await companies.findOne({ _id: companyId }, { projection: { _id: 1, name: 1, addedBy: 1 } });
      if (!company) {
        throw new Error(`Company ${companyId} not found`);
      }
      if (!company.addedBy) {
        throw new Error(`Company ${companyId} (${company.name}) has no addedBy user`);
      }

      const setting = await userCompanySettings.findOne({ userId: company.addedBy, companyId });
      if (!setting) {
        console.log(`No UserCompanySetting found for company=${company.name} (${companyId}). Nothing to do.`);
        console.log('✅ Migration down completed');
        return;
      }

      if (apply) {
        await users.updateOne({ _id: company.addedBy }, { $set: { defaultConfiguration: setting.defaultConfiguration || {} } });
        await userCompanySettings.deleteOne({ _id: setting._id });
        console.log(`Restored User.defaultConfiguration and deleted UserCompanySetting for company=${company.name}`);
      } else {
        console.log(
          `[dry run] Would restore User.defaultConfiguration for userId=${company.addedBy} from company=${company.name}`,
        );
        console.log(`[dry run] Would delete UserCompanySetting ${setting._id}`);
        console.log('Re-run with --apply to write.');
      }

      console.log('✅ Migration down completed');
    } catch (err) {
      console.error('❌ Migration down failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  const direction = process.argv[2];

  if (!['up', 'down'].includes(direction)) {
    console.error(
      'Usage: node migrations/migrateUserDefaultConfigurationToUserCompanySetting-remove.js [up|down] [--companyId=<id>] [--apply]',
    );
    process.exit(1);
  }

  module.exports[direction]()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
