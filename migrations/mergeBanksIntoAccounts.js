/**
 * Bank -> Account merge — the Bank collection is retired; bank/cash accounts
 * live in the chart of accounts (Account, category BANK/CASH/CREDIT_CARD).
 * Available balance is derived from the ledger (and opening-balance docs), not
 * stored on Account.
 *
 * For every bank document:
 *   - its linked Account (Bank.accountId) receives the bank fields
 *     (accountNumber, bankName, ifsc, branch, gstinUin, isPrimary, description,
 *     currency -> currencyId, divisionId, branchId);
 *   - a bank without a linked account gets one created (category from accountType);
 *   - a non-zero openingBalance becomes an AccountOpeningBalance record
 *     (skipped if one already exists for the account).
 * Company settings branchConfig.bankId values are remapped to the account ids.
 *
 * The banks collection itself is left in place (read by nothing after this;
 * CRM bank CRUD is retired — use migrateCrmLegacyBanks.js to run the full chain).
 * Idempotent: safe to re-run.
 *
 * Run: node migrations/mergeBanksIntoAccounts.js            (all companies)
 *      node migrations/mergeBanksIntoAccounts.js <companyId> (single company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { BALANCE_TYPES } = require('@smit9313/abss-models-core/src/utils/enum');
const { ACCOUNT_CATEGORY_BY_BANK_TYPE } = require('../utils/enum');

const runMergeBanksIntoAccounts = async (targetCompanyId = null, excludeCompanyIds = []) => {
  const db = await getConnection();
  const client = db.client;

  try {
    console.log('Connected to MongoDB');

    const companyFilter = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludeCompanyIds.length
        ? { companyId: { $nin: excludeCompanyIds } }
        : {};
    const banks = db.booksCrm.collection('banks');
    const accounts = db.books.collection('accounts');
    const accountOpeningBalances = db.books.collection('accountopeningbalances');
    const companySettings = db.common.collection('companysettings');

    const allBanks = await banks.find(companyFilter).toArray();

    let merged = 0;
    let created = 0;
    let openingBalances = 0;
    let banksLinked = 0;
    const accountIdByBankId = new Map();

    for (const bank of allBanks) {
      const category = ACCOUNT_CATEGORY_BY_BANK_TYPE[bank.accountType];
      if (!category) {
        console.log(`Skipping bank ${bank._id} — unknown accountType "${bank.accountType}"`);
        continue;
      }

      const bankFields = {
        bankDetails: {
          accountNumber: bank.accountNumber || '',
          bankName: bank.bankName || '',
          ifsc: bank.ifsc || '',
          branch: bank.branch || '',
          gstinUin: bank.gstinUin || '',
          isPrimary: bank.isPrimary === true,
        },
        description: bank.description || '',
        currencyId: bank.currency || null,
        divisionId: bank.divisionId || null,
        branchId: bank.branchId || null,
        isActive: true,
      };

      let accountId = bank.accountId;
      if (accountId && (await accounts.findOne({ _id: accountId }, { projection: { _id: 1 } }))) {
        await accounts.updateOne({ _id: accountId }, { $set: bankFields });
        merged += 1;
      } else {
        const now = new Date();
        const inserted = await accounts.insertOne({
          accountName: bank.accountName,
          accountCode: bank.accountCode || null,
          category,
          companyId: bank.companyId,
          parentAccountId: null,
          isSystemAccount: false,
          systemAccountKey: null,
          addedBy: bank.addedBy || null,
          updatedBy: [],
          createdAt: now,
          updatedAt: now,
          ...bankFields,
        });
        accountId = inserted.insertedId;
        created += 1;
      }

      accountIdByBankId.set(bank._id.toString(), accountId);
      await banks.updateOne({ _id: bank._id }, { $set: { accountId, updatedAt: new Date() } });
      banksLinked += 1;

      if (bank.openingBalance) {
        const existing = await accountOpeningBalances.findOne(
          { companyId: bank.companyId, accountId },
          { projection: { _id: 1 } },
        );
        if (!existing) {
          const now = new Date();
          await accountOpeningBalances.insertOne({
            companyId: bank.companyId,
            accountId,
            amount: Math.abs(bank.openingBalance),
            balanceType: bank.openingBalance > 0 ? BALANCE_TYPES.DEBIT : BALANCE_TYPES.CREDIT,
            openingBalanceDate: bank.createdAt || new Date(),
            addedBy: bank.addedBy || null,
            updatedBy: [],
            createdAt: now,
            updatedAt: now,
          });
          openingBalances += 1;
        }
      }
    }

    const settingsFilter = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludeCompanyIds.length
        ? { companyId: { $nin: excludeCompanyIds } }
        : {};
    const allSettings = await companySettings
      .find({ ...settingsFilter, 'branchConfig.bankId': { $exists: true, $ne: null } })
      .toArray();
    let settingsUpdated = 0;

    for (const settings of allSettings) {
      const bankIdValue = settings.branchConfig.bankId;
      const remap = value => accountIdByBankId.get(String(value)) || value;
      const remapped = Array.isArray(bankIdValue) ? bankIdValue.map(remap) : remap(bankIdValue);
      await companySettings.updateOne({ _id: settings._id }, { $set: { 'branchConfig.bankId': remapped } });
      settingsUpdated += 1;
    }

    const summary = {
      banksProcessed: allBanks.length,
      merged,
      created,
      banksLinked,
      openingBalances,
      settingsUpdated,
      accountIdByBankId,
    };

    console.log(`Banks processed: ${summary.banksProcessed}`);
    console.log(`Merged into linked accounts: ${summary.merged}`);
    console.log(`Accounts created for unlinked banks: ${summary.created}`);
    console.log(`Bank documents linked with accountId: ${summary.banksLinked}`);
    console.log(`Opening balance records created: ${summary.openingBalances}`);
    console.log(`Company settings remapped: ${summary.settingsUpdated}`);

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
    await runMergeBanksIntoAccounts(targetCompanyId);
    console.log('Bank -> Account merge completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
};

if (require.main === module) {
  migrate();
}

module.exports = { runMergeBanksIntoAccounts };
