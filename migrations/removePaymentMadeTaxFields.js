// Removes the old `taxDeducted` / `taxType` fields from payments made; they were only labels with no amount or ledger effect.
// dry-run: node migrations/removePaymentMadeTaxFields.js
// apply: node migrations/removePaymentMadeTaxFields.js --apply
const { getConnection } = require('../config/db');

const migrate = async () => {
  let client;
  try {
    const apply = process.argv.slice(2).includes('--apply');
    const db = await getConnection();
    client = db.client;
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const paymentMades = db.books.collection('paymentmades');
    const filter = { $or: [{ taxDeducted: { $exists: true } }, { taxType: { $exists: true } }] };
    const rows = await paymentMades
      .find(filter)
      .project({ paymentMadeId: 1, companyId: 1, status: 1, taxDeducted: 1, taxType: 1 })
      .toArray();
    console.log(`Payments made with taxDeducted / taxType stored: ${rows.length}`);

    const flaggedRows = rows.filter(row => row.taxDeducted === true || row.taxType);
    console.log(`Marked as tax deducted: ${flaggedRows.length}`);
    flaggedRows.forEach(row => console.log(`  - ${row.paymentMadeId} (${row.companyId}, ${row.status}, ${row.taxType || '-'})`));

    if (!apply) {
      console.log('Nothing was written. Re-run with --apply.');
      return;
    }

    const result = await paymentMades.updateMany(filter, { $unset: { taxDeducted: '', taxType: '' } });
    console.log(`Updated: ${result.modifiedCount}`);
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
