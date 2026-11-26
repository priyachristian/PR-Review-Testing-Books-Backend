/**
 * Migration: drop the retired `branchConfig.bankId` field from CompanySettings
 *
 * branchConfig.bankId (an array of Account ids) let split-config companies flag which
 * bank accounts are managed from Settings instead of the Bank screens. The field was
 * dropped from the schema (BOOKS-1255) and its read/write paths in bank.service.js and
 * companyProfile.validate.js were removed — this migration clears it off documents that
 * still carry it so the stored data matches the schema.
 *
 * Usage:
 *   node migrations/removeBranchConfigBankId-remove.js                         report only, all companies
 *   node migrations/removeBranchConfigBankId-remove.js --companyId=<id>        report only, one company
 *   node migrations/removeBranchConfigBankId-remove.js --apply                 write, all companies
 *   node migrations/removeBranchConfigBankId-remove.js --companyId=<id> --apply write, one company
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const parseArgs = () => {
  const companyHit = process.argv.find(a => a.startsWith('--companyId='));
  const companyArg = companyHit === undefined ? undefined : companyHit.slice('--companyId='.length);
  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return {
    companyId: companyArg ? new ObjectId(companyArg) : null,
    apply: process.argv.includes('--apply'),
  };
};

module.exports = {
  async run() {
    const { companyId, apply } = parseArgs();
    const { client, common } = await getConnection();
    const companySettings = common.collection('companysettings');
    const companyScope = companyId ? { companyId } : {};

    try {
      console.log(`Scope: ${companyId ? companyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

      const filter = { ...companyScope, 'branchConfig.bankId': { $exists: true } };
      const docs = await companySettings.find(filter).project({ _id: 1, companyId: 1, 'branchConfig.bankId': 1 }).toArray();

      console.log(`CompanySettings with branchConfig.bankId: ${docs.length}`);
      if (!docs.length) {
        console.log('Nothing to fix.');
        return;
      }

      docs.forEach((doc, i) => {
        console.log(`  ${i + 1}. companyId=${doc.companyId} bankId=${JSON.stringify(doc.branchConfig?.bankId)}`);
      });

      if (!apply) {
        console.log('\nℹ️  Report only — rerun with --apply to write.');
        return;
      }

      const result = await companySettings.updateMany(filter, { $unset: { 'branchConfig.bankId': '' } });
      console.log(`\n✅ Removed branchConfig.bankId from ${result.modifiedCount} document(s).`);
    } catch (err) {
      console.error('❌ Migration failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  module.exports
    .run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
