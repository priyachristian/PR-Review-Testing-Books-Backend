/**
 * Bank transfer log bank references -> chart-of-accounts references.
 *
 * Bank transfer logs stored `fromBankId` / `toBankId` pointing at the retired
 * Bank collection. Banks are now Accounts, so each value is remapped through
 * Bank.accountId and the fields are renamed `fromBankId` -> `fromAccountId` and
 * `toBankId` -> `toAccountId`, matching the updated bankTransferLog schema and
 * the rest of the product.
 *
 * Run AFTER mergeBanksIntoAccounts.js (which creates the Bank -> Account links).
 * Idempotent: logs already carrying the new fields (old fields removed) are
 * skipped, since the old fields are unset after each run.
 *
 * Run: node migrations/migrateBankTransferLogAccountIds.js            (all companies)
 *      node migrations/migrateBankTransferLogAccountIds.js <companyId> (single company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { buildBankToAccountMap } = require('./migrateDocumentBankAccountId');

const FIELD_MAP = [
  { from: 'fromBankId', to: 'fromAccountId' },
  { from: 'toBankId', to: 'toAccountId' },
];

const runMigrateBankTransferLogAccountIds = async (targetCompanyId = null, excludeCompanyIds = []) => {
  const db = await getConnection();
  const client = db.client;

  try {
    console.log('Connected to MongoDB');

    const companyScope = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludeCompanyIds.length
        ? { companyId: { $nin: excludeCompanyIds } }
        : {};
    const accountIdByBankId = await buildBankToAccountMap(db, companyScope);
    console.log(`Bank -> Account links available: ${accountIdByBankId.size}`);

    const collection = db.booksCrm.collection('banktransferlogs');
    const documents = await collection
      .find({
        ...companyScope,
        $or: [{ fromBankId: { $exists: true, $ne: null } }, { toBankId: { $exists: true, $ne: null } }],
      })
      .project({ _id: 1, fromBankId: 1, toBankId: 1 })
      .toArray();

    let remapped = 0;
    let unlinked = 0;

    for (const document of documents) {
      const set = {};
      const unset = {};

      for (const { from, to } of FIELD_MAP) {
        const bankId = document[from];
        if (!bankId) continue;

        const accountId = accountIdByBankId.get(bankId.toString());
        if (accountId) {
          set[to] = accountId;
          remapped += 1;
        } else {
          unlinked += 1;
        }
        unset[from] = '';
      }

      const update = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      if (Object.keys(update).length) {
        await collection.updateOne({ _id: document._id }, update);
      }
    }

    const summary = { logsProcessed: documents.length, remapped, unlinked };
    console.log(
      `banktransferlogs: ${documents.length} processed, ${remapped} references remapped, ${unlinked} dead references cleared`,
    );

    return summary;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

const migrate = async () => {
  try {
    const targetCompanyId = process.argv[2] ? new ObjectId(process.argv[2]) : null;
    await runMigrateBankTransferLogAccountIds(targetCompanyId);
    console.log('Bank transfer log reference migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
};

if (require.main === module) {
  migrate();
}

module.exports = { runMigrateBankTransferLogAccountIds };
