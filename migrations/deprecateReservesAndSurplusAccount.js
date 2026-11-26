/**
 * Deprecate all chart-of-accounts entries, across every company.
 *
 * Marks each account as deprecated (isDepriciable: true) and appends " (Depricated)"
 * to its accountName. Reports what it would change unless --apply is passed.
 * Safe to re-run: an account that's already deprecated (isDepriciable: true, or
 * accountName already carrying the suffix) is left untouched.
 *
 * Run: node migrations/deprecateReservesAndSurplusAccount.js          (dry run)
 *      node migrations/deprecateReservesAndSurplusAccount.js --apply  (write)
 */
const { getConnection } = require('../config/db');

const DEPRECATED_SUFFIX = ' (Depricated)';

const migrate = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');

    const db = await getConnection();
    client = db.client;
    console.log('Connected to MongoDB');
    console.log('Scope: all companies');
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const accounts = db.books.collection('accounts');

    const allAccounts = await accounts.find({}).toArray();

    if (!allAccounts.length) {
      console.log('No accounts found — nothing to do.');
      return;
    }

    const tally = { deprecated: 0, skipped: 0 };

    for (const account of allAccounts) {
      const alreadyDeprecated = account.isDepriciable === true || account.accountName.endsWith(DEPRECATED_SUFFIX);

      if (alreadyDeprecated) {
        tally.skipped += 1;
        continue;
      }

      const newAccountName = `${account.accountName}${DEPRECATED_SUFFIX}`;

      console.log(`${apply ? 'Updating' : 'Would update'} account ${account._id}:`);
      console.log(`   accountName   : "${account.accountName}" -> "${newAccountName}"`);
      console.log(`   isDepriciable : ${account.isDepriciable ?? 'undefined'} -> true`);

      tally.deprecated += 1;

      if (apply) {
        await accounts.updateOne(
          { _id: account._id },
          {
            $set: {
              accountName: newAccountName,
              isDepriciable: true,
              updatedAt: new Date(),
            },
          },
        );
      }
    }

    console.log('Accounts across all companies:');
    console.log(`   ${apply ? 'deprecated' : 'to deprecate'} : ${tally.deprecated}`);
    console.log(`   already deprecated  : ${tally.skipped}`);

    console.log(apply ? 'Accounts deprecated successfully.' : 'Dry run complete — nothing was written. Re-run with --apply.');
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
