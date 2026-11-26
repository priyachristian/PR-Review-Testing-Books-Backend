// Marks TDS accounts as system accounts and adds the missing TCS accounts, so resolveSystemAccount can find all four.
// Only companies that already have the TDS_PAYABLE account are touched.
// dry-run: node migrations/fixTaxSystemAccounts.js
// apply: node migrations/fixTaxSystemAccounts.js --apply
const { getConnection } = require('../config/db');

const TAX_ACCOUNTS = [
  { accountName: 'TDS Receivable', category: 'OTHER_CURRENT_ASSET', systemAccountKey: 'TDS_RECEIVABLE' },
  { accountName: 'TCS Receivable', category: 'OTHER_CURRENT_ASSET', systemAccountKey: 'TCS_RECEIVABLE' },
  { accountName: 'TDS Payable', category: 'OTHER_CURRENT_LIABILITY', systemAccountKey: 'TDS_PAYABLE' },
  { accountName: 'TCS Payable', category: 'OTHER_CURRENT_LIABILITY', systemAccountKey: 'TCS_PAYABLE' },
];

const migrate = async () => {
  let client;
  try {
    const apply = process.argv.slice(2).includes('--apply');
    const db = await getConnection();
    client = db.client;
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const accounts = db.books.collection('accounts');
    const companyIds = await accounts.distinct('companyId', { systemAccountKey: 'TDS_PAYABLE' });
    console.log(`Companies: ${companyIds.length}`);

    for (const def of TAX_ACCOUNTS) {
      const companyScope = { companyId: { $in: companyIds } };
      const keyed = { ...companyScope, systemAccountKey: def.systemAccountKey };
      const notSystem = { ...keyed, isSystemAccount: { $ne: true } };
      const toFlag = await accounts.countDocuments(notSystem);

      const companiesWithKey = await accounts.distinct('companyId', keyed);
      const withKey = new Set(companiesWithKey.map(String));
      const missing = companyIds.filter(companyId => !withKey.has(String(companyId)));

      let toLink = 0;
      let toCreate = 0;
      const now = new Date();
      for (const companyId of missing) {
        const sameName = await accounts.findOne(
          { companyId, category: def.category, accountName: def.accountName },
          { projection: { _id: 1 } },
        );
        if (sameName) {
          toLink += 1;
          if (apply) {
            await accounts.updateOne(
              { _id: sameName._id },
              { $set: { isSystemAccount: true, systemAccountKey: def.systemAccountKey, updatedAt: now } },
            );
          }
          continue;
        }

        toCreate += 1;
        if (apply) {
          await accounts.insertOne({
            accountName: def.accountName,
            category: def.category,
            companyId,
            parentAccountId: null,
            isSystemAccount: true,
            systemAccountKey: def.systemAccountKey,
            accountCode: null,
            isActive: true,
            updatedBy: [],
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      if (apply && toFlag) {
        await accounts.updateMany(notSystem, { $set: { isSystemAccount: true, updatedAt: now } });
      }
      console.log(`${def.systemAccountKey}: mark as system ${toFlag}, link existing ${toLink}, create ${toCreate}`);
    }

    if (!apply) console.log('Nothing was written. Re-run with --apply.');
  } finally {
    if (client) await client.close();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
