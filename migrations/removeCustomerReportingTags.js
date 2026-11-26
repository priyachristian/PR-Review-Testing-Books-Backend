// Removes the old `reportingTags` field from customers and vendors; the Reporting Tags tab was removed and nothing reads it.
// dry-run: node migrations/removeCustomerReportingTags.js
// apply: node migrations/removeCustomerReportingTags.js --apply
const { getConnection } = require('../config/db');

const migrate = async () => {
  let client;
  try {
    const apply = process.argv.slice(2).includes('--apply');
    const db = await getConnection();
    client = db.client;
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const customers = db.booksCrm.collection('customers');
    const filter = { reportingTags: { $exists: true } };
    const rows = await customers.find(filter).project({ customerDisplayName: 1, companyId: 1, reportingTags: 1 }).toArray();
    console.log(`Customers / vendors with reportingTags stored: ${rows.length}`);

    const taggedRows = rows.filter(row => Array.isArray(row.reportingTags) && row.reportingTags.length > 0);
    console.log(`With at least one tag: ${taggedRows.length}`);
    taggedRows.forEach(row =>
      console.log(`  - ${row.customerDisplayName} (${row.companyId}): ${row.reportingTags.map(tag => tag?.name).join(', ')}`),
    );

    if (!apply) {
      console.log('Nothing was written. Re-run with --apply.');
      return;
    }

    const result = await customers.updateMany(filter, { $unset: { reportingTags: '' } });
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
