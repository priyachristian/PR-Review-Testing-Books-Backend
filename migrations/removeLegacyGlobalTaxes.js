// Removes the old global `taxes` rows (no companyId); nothing reads them and a JSON backup is saved first.
// Run: node migrations/removeLegacyGlobalTaxes.js [--apply]
const fs = require('fs');
const path = require('path');
const { getConnection } = require('../config/db');

const migrate = async () => {
  let client;
  try {
    const apply = process.argv.slice(2).includes('--apply');
    const db = await getConnection();
    client = db.client;
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const filter = { companyId: { $exists: false } };
    const rows = await db.books.collection('taxes').find(filter).toArray();
    console.log(`Global tax rows without companyId: ${rows.length}`);
    rows.forEach(row => console.log(`  - ${row.taxName} (${row.natureofCollection || '-'}, ${row.taxRate}%)`));

    if (!apply || !rows.length) {
      if (!apply) console.log('Nothing was written. Re-run with --apply.');
      return;
    }

    const backupPath = path.join(
      __dirname,
      'logs',
      `removeLegacyGlobalTaxes_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2));
    console.log(`Backup written: ${backupPath}`);

    const result = await db.books.collection('taxes').deleteMany(filter);
    console.log(`Deleted: ${result.deletedCount}`);
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
