/**
 * Migration: Remove stray `currencyId` field from booksCrm banks
 *
 * The Bank schema uses `currency` only — `currencyId` is a legacy leftover
 * field still present on some documents. This migration unsets it.
 *
 * Usage:
 *   node migrations/removeBankCurrencyId.js            (dry-run, prints only)
 *   node migrations/removeBankCurrencyId.js --apply    (applies changes)
 */
const { getConnection } = require('../config/db');

async function up() {
  const apply = process.argv.includes('--apply');
  const { client, booksCrm } = await getConnection();

  try {
    const banks = booksCrm.collection('banks');

    const docs = await banks
      .find({ currencyId: { $exists: true } })
      .project({ _id: 1, accountName: 1, accountCode: 1, bankName: 1, companyId: 1, currencyId: 1 })
      .toArray();

    console.log('--- Remove Bank.currencyId ---');
    console.log(`Banks with currencyId: ${docs.length}`);

    if (docs.length === 0) {
      console.log('\nNothing to fix.');
      return;
    }

    docs.forEach((doc, i) => {
      console.log(
        `  ${i + 1}. "${doc.accountName || doc.bankName || doc._id}" companyId=${doc.companyId} currencyId=${JSON.stringify(doc.currencyId)}`,
      );
    });

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }

    const result = await banks.updateMany({ currencyId: { $exists: true } }, { $unset: { currencyId: '' } });
    console.log(`\n✅ Removed currencyId from ${result.modifiedCount} bank(s).`);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { up };

if (require.main === module) {
  up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
