/**
 * Migration: Round Bank.availableBalance / openingBalance to 2 decimal places
 *
 * Historical updates on Bank.availableBalance accumulated floating-point
 * error (e.g. 11150.79000000006 instead of 11150.79). This migration finds every
 * bank whose openingBalance or availableBalance has more than 2 decimal places
 * and rounds it.
 *
 * Usage:
 *   node migrations/roundBankAvailableBalance.js
 */
const { getConnection } = require('../config/db');

const round2 = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const needsRounding = value => Number(value || 0) !== round2(value);

async function up() {
  const { client, booksCrm } = await getConnection();

  try {
    const banks = booksCrm.collection('banks');

    const allBanks = await banks
      .find({}, { projection: { _id: 1, accountName: 1, openingBalance: 1, availableBalance: 1 } })
      .toArray();

    const toFix = allBanks.filter(bank => needsRounding(bank.openingBalance) || needsRounding(bank.availableBalance));

    console.log('--- Round Bank openingBalance / availableBalance ---');
    console.log(`Total banks scanned : ${allBanks.length}`);
    console.log(`Banks needing fix   : ${toFix.length}`);

    if (toFix.length === 0) {
      console.log('\nNothing to fix.');
      return;
    }

    const ops = toFix.map(bank => {
      const originalOpeningBalance = Number(bank.openingBalance || 0);
      const originalAvailableBalance = Number(bank.availableBalance || 0);
      const roundedOpeningBalance = round2(originalOpeningBalance);
      const roundedAvailableBalance = round2(originalAvailableBalance);

      console.log(
        `  "${bank.accountName || bank._id}": ` +
          `openingBalance ${originalOpeningBalance} -> ${roundedOpeningBalance}, ` +
          `availableBalance ${originalAvailableBalance} -> ${roundedAvailableBalance}`,
      );

      return {
        updateOne: {
          filter: { _id: bank._id },
          update: {
            $set: {
              openingBalance: roundedOpeningBalance,
              availableBalance: roundedAvailableBalance,
            },
          },
        },
      };
    });

    const result = await banks.bulkWrite(ops);
    console.log(`\n✅ Rounded ${result.modifiedCount} bank(s).`);
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
