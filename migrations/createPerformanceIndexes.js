/**
 * Build the performance indexes for list / report / analytics query paths.
 *
 * These indexes are declared in the abss-models schemas; this migration builds them
 * on the existing collections explicitly, in the background, so the build is deliberate
 * and off the app-boot path (rather than relying on Mongoose autoIndex at startup).
 *
 * SAFETY:
 *   - Dry-run by default — prints exactly what it would build, creates nothing.
 *   - createIndex is idempotent — indexes that already exist are skipped by MongoDB.
 *   - background: true — builds without holding a long exclusive lock (run off-peak anyway).
 *   - Collection names are resolved against the live DB (case-insensitive), so a
 *     pluralization mismatch is reported instead of silently creating a wrong/empty collection.
 *
 * Usage:
 *   node migrations/createPerformanceIndexes.js                          (dry-run, all collections)
 *   node migrations/createPerformanceIndexes.js --apply                  (build all)
 *   node migrations/createPerformanceIndexes.js --only=invoices          (dry-run, one collection)
 *   node migrations/createPerformanceIndexes.js --only=invoices --apply  (build one collection — run these one-by-one, off-peak)
 */

const { getConnection } = require('../config/db');

// dbKey -> expected collection name -> [ index specs ]  (all tiers; createIndex is idempotent)
const INDEX_PLAN = {
  books: {
    invoices: [
      { companyId: 1, isSplit: 1, createdAt: -1 },
      { companyId: 1, invoiceDate: 1 },
      { companyId: 1, 'items.itemId': 1 },
      { companyId: 1, dueDate: 1, balanceAmount: 1 },
    ],
    bills: [
      { companyId: 1, isSplit: 1, createdAt: -1 },
      { companyId: 1, billDate: 1 },
      { companyId: 1, dueDate: 1, balanceAmount: 1 },
      { companyId: 1, 'items.itemId': 1 },
    ],
    deliverychallans: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, challanDate: 1 },
      { companyId: 1, 'items.itemId': 1 },
    ],
    creditnotes: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, creditNoteDate: 1 },
    ],
    debitnotes: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, debitNoteDate: 1 },
    ],
    purchaseorders: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, date: 1 },
      { companyId: 1, 'items.itemId': 1 },
    ],
    grpoorders: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, date: 1 },
      { companyId: 1, 'items.itemId': 1 },
    ],
    paymentmades: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, paymentDate: 1 },
      { companyId: 1, 'bills.billId': 1 },
    ],
    expenses: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, date: 1 },
    ],
    productionorders: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, productionDate: 1 },
    ],
    rejectionorders: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, arrivalDate: 1 },
    ],
    inventorylogs: [{ companyId: 1, createdAt: -1 }],
    inventoryadjustments: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, adjustmentDate: 1 },
    ],
    inventorytransferrequests: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, date: 1 },
    ],
    manualjournals: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, date: 1 },
      { companyId: 1, 'journalEntries.businessAccountLedgerMasterId': 1 },
    ],
    customerorders: [{ companyId: 1, createdAt: -1 }],
    recurringinvoices: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, recurringInvoiceDate: 1 },
    ],
    recurringbills: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, recurringBillDate: 1 },
    ],
  },
  booksCrm: {
    salesorders: [
      { companyId: 1, orderDate: 1 },
      { companyId: 1, 'items.itemId': 1 },
      { companyId: 1, createdAt: -1 },
    ],
    paymentreceiveds: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, paymentDate: 1 },
      { companyId: 1, 'invoices.invoiceId': 1 },
    ],
    quotes: [
      { companyId: 1, createdAt: -1 },
      { companyId: 1, quoteDate: 1 },
      { companyId: 1, 'items.itemId': 1 },
    ],
    customers: [{ companyId: 1, createdAt: -1 }],
    items: [{ companyId: 1, createdAt: -1 }],
    itemgroups: [{ companyId: 1, createdAt: -1 }],
  },
};

const describe = spec =>
  Object.entries(spec)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const onlyHit = args.find(a => a.startsWith('--only='));
  const only = onlyHit ? onlyHit.slice('--only='.length).toLowerCase() : null;
  const { client, ...dbs } = await getConnection();

  try {
    console.log(`\n=== Performance Indexes  (mode: ${apply ? 'APPLY' : 'DRY-RUN'})${only ? `  only=${only}` : ''} ===\n`);

    let created = 0;
    let missing = 0;

    for (const [dbKey, collections] of Object.entries(INDEX_PLAN)) {
      const db = dbs[dbKey];
      if (!db) {
        console.log(`  ⚠ DB handle "${dbKey}" not found in getConnection() — skipping.`);
        continue;
      }

      const existing = await db.listCollections({}, { nameOnly: true }).toArray();
      const byLower = new Map(existing.map(c => [c.name.toLowerCase(), c.name]));

      for (const [expectedName, specs] of Object.entries(collections)) {
        if (only && expectedName.toLowerCase() !== only) continue;
        const actualName = byLower.get(expectedName.toLowerCase());
        if (!actualName) {
          console.log(`  ⚠ [${dbKey}] collection "${expectedName}" not found in DB — skipping its ${specs.length} index(es).`);
          missing += specs.length;
          continue;
        }

        for (const spec of specs) {
          const label = `[${dbKey}.${actualName}] { ${describe(spec)} }`;
          if (!apply) {
            console.log(`  • would build ${label}`);
            continue;
          }
          try {
            const name = await db.collection(actualName).createIndex(spec, { background: true });
            console.log(`  ✔ built ${label}  -> ${name}`);
            created += 1;
          } catch (err) {
            console.log(`  ❌ failed ${label}: ${err.message}`);
          }
        }
      }
    }

    if (!apply) {
      console.log('\nDry-run only — nothing was built. Re-run with --apply during a low-traffic window.\n');
    } else {
      console.log(`\nDone. ${created} index build request(s) issued; ${missing} skipped (missing collection).`);
      console.log('Note: background builds continue on the server after this exits; verify with db.<coll>.getIndexes().\n');
    }
  } catch (err) {
    console.error('Index migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
