/**
 * Chart of Accounts refactor — migrate parentType architecture to category-driven,
 * seed/sync the default chart (protected system accounts + editable defaults)
 * and link every bank to a chart-of-accounts entry.
 *
 * Reports what it would change unless --apply is passed. Safe to re-run: an account that
 * already matches the definition is left untouched.
 *
 * Run: node migrations/refactorChartOfAccountsCategories.js                     (dry run, all companies)
 *      node migrations/refactorChartOfAccountsCategories.js --apply             (write, all companies)
 *      node migrations/refactorChartOfAccountsCategories.js <companyId>         (dry run, one company)
 *      node migrations/refactorChartOfAccountsCategories.js <companyId> --apply (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { COA_SYSTEM_ACCOUNTS } = require('@smit9313/abss-models-core/src/utils/coaSystemAccounts');
const { ACCOUNT_CATEGORY_BY_BANK_TYPE } = require('../utils/enum');

const PARENT_TYPE_TO_CATEGORY = {
  'Capital / Equity': 'EQUITY',
  'Non-Current Liabilities': 'NON_CURRENT_LIABILITY',
  'Current Liabilities': 'OTHER_CURRENT_LIABILITY',
  'Fixed Assets': 'FIXED_ASSET',
  Investments: 'OTHER_CURRENT_ASSET',
  'Non Current Assets': 'NON_CURRENT_ASSET',
  'Current Assets': 'OTHER_CURRENT_ASSET',
  'Purchase Account': 'COGS',
  'Direct Expense': 'COGS',
  'Indirect Expense': 'EXPENSE',
  'Sales Account': 'INCOME',
  'Direct Income': 'INCOME',
  'Indirect Income': 'OTHER_INCOME',
  Other: 'EXPENSE',
};

const NAME_CATEGORY_OVERRIDES = {
  'Bank Account': 'BANK',
  'Cash Account': 'CASH',
  'Account Receivables / Debtors': 'ACCOUNTS_RECEIVABLE',
  'Account Payable / Sundry Creditors': 'ACCOUNTS_PAYABLE',
  'Stock in Hand / Inventory': 'STOCK',
  'Bank OD / CC Facility': 'CREDIT_CARD',
};

/** Create a default account if the company doesn't have it yet; otherwise just apply the config's protection flag. */
const seedAccount = async (accounts, companyId, def, parentAccountId, { apply, tally }) => {
  const existing = await accounts.findOne(
    { companyId, category: def.category, accountName: def.accountName },
    { projection: { _id: 1, systemAccountKey: 1 } },
  );
  if (existing) {
    if (existing.systemAccountKey !== (def.systemAccountKey || null)) tally.keyed += 1;
    else tally.unchanged += 1;

    if (apply) {
      await accounts.updateOne(
        { _id: existing._id },
        { $set: { isSystemAccount: def.isSystemAccount === true, systemAccountKey: def.systemAccountKey || null } },
      );
    }
    return existing;
  }

  tally.created += 1;
  if (!apply) return { _id: null };

  const now = new Date();
  const inserted = await accounts.insertOne({
    accountName: def.accountName,
    category: def.category,
    companyId,
    parentAccountId: parentAccountId || null,
    isSystemAccount: def.isSystemAccount === true,
    systemAccountKey: def.systemAccountKey || null,
    accountCode: null,
    isActive: true,
    updatedBy: [],
    createdAt: now,
    updatedAt: now,
  });
  return { _id: inserted.insertedId };
};

const migrate = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    const db = await getConnection();
    client = db.client;
    console.log('Connected to MongoDB');
    console.log(targetCompanyId ? `Scope: single company ${targetCompanyId}` : 'Scope: all companies');
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const accounts = db.books.collection('accounts');
    const banks = db.booksCrm.collection('banks');
    const companies = db.common.collection('companies');

    const companyScope = targetCompanyId ? { companyId: targetCompanyId } : {};

    // 1. Delete old level-1 grouping docs (categories replace them).
    const level1 = await accounts
      .find({ ...companyScope, level: 1, isParentAccount: true })
      .project({ _id: 1 })
      .toArray();
    const level1Ids = level1.map(d => d._id);
    if (level1Ids.length) {
      if (apply) await accounts.deleteMany({ _id: { $in: level1Ids } });
      console.log(`${apply ? 'Deleted' : 'Would delete'} ${level1Ids.length} old level-1 grouping accounts`);
    }

    // 2. Convert old-architecture docs to categories as plain user accounts;
    // step 3 applies the protection flag from the config where names match.
    const level1IdSet = new Set(level1Ids.map(String));
    const oldDocs = await accounts.find({ ...companyScope, parentType: { $exists: true } }).toArray();
    console.log(`${apply ? 'Converting' : 'Would convert'} ${oldDocs.length} accounts to category architecture...`);

    for (const doc of oldDocs) {
      if (!apply) continue;
      const category = NAME_CATEGORY_OVERRIDES[doc.accountName] || PARENT_TYPE_TO_CATEGORY[doc.parentType] || 'EXPENSE';
      const parentWasGroup = doc.parentAccountId && level1IdSet.has(String(doc.parentAccountId));

      await accounts.updateOne(
        { _id: doc._id },
        {
          $set: {
            category,
            parentAccountId: parentWasGroup ? null : doc.parentAccountId || null,
            isSystemAccount: false,
          },
          $unset: {
            parentType: '',
            isSubAccount: '',
            level: '',
            ancestors: '',
            isParentAccount: '',
            isDefault: '',
            sequence: '',
            description: '',
            allowTransactions: '',
            openingBalance: '',
            openingBalanceType: '',
            currencyId: '',
          },
        },
      );
    }

    // 3. Seed the default chart for every company (missing accounts created,
    // protection flag applied from the config).
    const allCompanies = await companies
      .find(targetCompanyId ? { _id: targetCompanyId } : {})
      .project({ _id: 1 })
      .toArray();

    const tally = { keyed: 0, created: 0, unchanged: 0 };

    for (const company of allCompanies) {
      let pettyCashAccountId = null;

      for (const def of COA_SYSTEM_ACCOUNTS) {
        const parent = await seedAccount(accounts, company._id, def, null, { apply, tally });
        if (def.category === 'CASH' && def.accountName === 'Petty Cash') {
          pettyCashAccountId = parent._id;
        }

        for (const child of def.children || []) {
          await seedAccount(accounts, company._id, child, parent._id, { apply, tally });
        }
      }

      // Link the company's default Petty Cash bank to the Petty Cash account.
      if (pettyCashAccountId && apply) {
        await banks.updateOne(
          { companyId: company._id, accountType: 'Petty Cash', accountId: { $in: [null, undefined] } },
          { $set: { accountId: pettyCashAccountId } },
        );
      }
    }
    console.log(`Chart of accounts across ${allCompanies.length} companies:`);
    console.log(`   ${apply ? 'keys set' : 'keys to set'}        : ${tally.keyed}`);
    console.log(`   ${apply ? 'accounts created' : 'accounts to create'} : ${tally.created}`);
    console.log(`   already correct       : ${tally.unchanged}`);

    // 4. Every bank shows in the chart of accounts — backfill missing links.
    const unlinkedBanks = await banks
      .find({ ...companyScope, $or: [{ accountId: null }, { accountId: { $exists: false } }] })
      .toArray();
    let linked = 0;

    for (const bank of unlinkedBanks) {
      const category = ACCOUNT_CATEGORY_BY_BANK_TYPE[bank.accountType] || null;
      if (!category) continue;

      linked++;
      if (!apply) continue;

      const now = new Date();
      const inserted = await accounts.insertOne({
        accountName: bank.accountName,
        accountCode: bank.accountCode || null,
        category,
        companyId: bank.companyId,
        parentAccountId: null,
        isSystemAccount: false,
        isActive: true,
        updatedBy: [],
        createdAt: now,
        updatedAt: now,
      });
      await banks.updateOne({ _id: bank._id }, { $set: { accountId: inserted.insertedId } });
    }
    console.log(`${apply ? 'Linked' : 'Would link'} ${linked} banks to chart-of-accounts entries`);

    console.log(
      apply
        ? 'Chart of Accounts migration completed successfully!'
        : 'Dry run complete — nothing was written. Re-run with --apply.',
    );
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
