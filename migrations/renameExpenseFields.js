// Renames two Expense fields: `customer` → `party` (it holds a customer, a vendor or an Account Ledger)
// and `amount` → `total` (the grand total, as on Bill and Invoice). Line amounts are not touched.
// Some old rows already carry a stray `total`: when `amount` exists it wins, because the journal was posted from it.
// dry-run: node migrations/renameExpenseFields.js
// apply: node migrations/renameExpenseFields.js --apply
const { getConnection } = require('../config/db');

const migrate = async () => {
  let client;
  try {
    const apply = process.argv.slice(2).includes('--apply');
    const db = await getConnection();
    client = db.client;
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const expenses = db.books.collection('expenses');
    const withCustomer = { customer: { $exists: true } };
    const withAmount = { amount: { $exists: true } };

    console.log(`Expenses: ${await expenses.countDocuments({})}`);

    // customer → party
    const customerRows = await expenses.countDocuments(withCustomer);
    const partyConflicts = await expenses.countDocuments({ ...withCustomer, party: { $exists: true } });
    console.log(`customer → party: ${customerRows} rows`);
    if (partyConflicts) {
      throw new Error(`${partyConflicts} expenses have both customer and party. Nothing was written.`);
    }

    // amount → total
    const amountRows = await expenses.countDocuments(withAmount);
    const totalOnly = await expenses.countDocuments({ amount: { $exists: false }, total: { $exists: true } });
    const staleTotals = await expenses
      .find({ ...withAmount, total: { $exists: true }, $expr: { $ne: ['$amount', '$total'] } })
      .project({ expenseId: 1, amount: 1, total: 1 })
      .toArray();
    console.log(`amount → total: ${amountRows} rows`);
    console.log(`Rows with only total (kept as they are): ${totalOnly}`);
    console.log(`Rows whose old total differs from amount (amount wins): ${staleTotals.length}`);
    staleTotals.forEach(row => console.log(`  ${row.expenseId || row._id}: amount ${row.amount}, old total ${row.total}`));

    if (apply) {
      if (customerRows) {
        const renamed = await expenses.updateMany(withCustomer, { $rename: { customer: 'party' } });
        console.log(`Renamed customer → party on ${renamed.modifiedCount} expenses`);
      }
      if (amountRows) {
        const moved = await expenses.updateMany(withAmount, [{ $set: { total: '$amount' } }, { $unset: 'amount' }]);
        console.log(`Moved amount → total on ${moved.modifiedCount} expenses`);
      }
    }

    console.log(
      `Left with customer: ${await expenses.countDocuments(withCustomer)}, left with amount: ${await expenses.countDocuments(withAmount)}`,
    );
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
