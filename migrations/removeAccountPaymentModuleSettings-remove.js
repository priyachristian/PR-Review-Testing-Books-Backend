/**
 * [Run 2 of 3] Scrubs Account Payment Made / Account Payment Received module settings:
 *   Deletes ModuleSettings documents (booksCrm.modulesettings) whose moduleName
 *   is ACCOUNT_PAYMENT_MADE or ACCOUNT_PAYMENT_RECEIVED.
 *
 * Reports by default; writes only with --apply. Scope to one company with --companyId=<id>.
 *
 * Run: node migrations/removeAccountPaymentModuleSettings-remove.js                          (report only, all companies)
 *      node migrations/removeAccountPaymentModuleSettings-remove.js --companyId=<id>         (report only, single company)
 *      node migrations/removeAccountPaymentModuleSettings-remove.js --apply                  (removes the records, all companies)
 *      node migrations/removeAccountPaymentModuleSettings-remove.js --apply --companyId=<id> (removes the records, single company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

// Different environments store moduleName in different casing (SCREAMING_SNAKE like other module
// settings, or camelCase like the module catalog keys), so match both to stay robust.
const MODULE_NAMES = ['ACCOUNT_PAYMENT_MADE', 'ACCOUNT_PAYMENT_RECEIVED', 'accountPaymentMade', 'accountPaymentReceived'];

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

const findModuleSettingIds = async (db, companyId) => {
  const filter = { moduleName: { $in: MODULE_NAMES } };
  if (companyId) filter.companyId = new ObjectId(companyId);

  const settings = await db.booksCrm.collection('modulesettings').find(filter).project({ _id: 1 }).toArray();

  console.log(`ModuleSettings matched: ${settings.length}`);

  return settings.map(s => s._id);
};

const deleteModuleSettings = async (db, settingIds, apply) => {
  if (!settingIds.length || !apply) return { deletedCount: 0 };

  const result = await db.booksCrm.collection('modulesettings').deleteMany({ _id: { $in: settingIds } });
  console.log(`ModuleSettings deleted: ${result.deletedCount}`);

  return result;
};

const run = async () => {
  const { apply, companyId } = parseArgs();
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    console.log(`Scope: ${companyId || 'all companies'}  Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

    const settingIds = await findModuleSettingIds(db, companyId);
    await deleteModuleSettings(db, settingIds, apply);
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
  findModuleSettingIds,
  deleteModuleSettings,
  MODULE_NAMES,
};
