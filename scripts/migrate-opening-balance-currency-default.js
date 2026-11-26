/**
 * Backfill currency + exchangeRate on opening balance transactions where currency is missing/null.
 * contact.otherDetails.currency → else company.baseCurrency, exchangeRate = 1.
 *
 *   node scripts/migrate-opening-balance-currency-default.js
 *   node scripts/migrate-opening-balance-currency-default.js --apply
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();
    const obColl = db.booksCrm.collection('openingbalancetransactions');

    const companies = await db.common
      .collection('companies')
      .find({ baseCurrency: { $ne: null } }, { projection: { _id: 1, baseCurrency: 1 } })
      .toArray();
    const baseByCompany = new Map(companies.map(c => [String(c._id), c.baseCurrency]));

    const docs = await obColl
      .find({ $or: [{ currency: { $exists: false } }, { currency: null }] })
      .project({ _id: 1, companyId: 1, contactId: 1, transactionNo: 1, type: 1, amount: 1, currency: 1 })
      .toArray();

    const contacts = docs.length
      ? await db.booksCrm
          .collection('customers')
          .find({ _id: { $in: docs.map(d => d.contactId).filter(Boolean) } })
          .project({ _id: 1, customerDisplayName: 1, code: 1, 'otherDetails.currency': 1 })
          .toArray()
      : [];
    const contactById = new Map(contacts.map(c => [String(c._id), c]));

    const toUpdate = [];
    const skipped = [];

    for (const doc of docs) {
      const contact = contactById.get(String(doc.contactId));
      const contactCurrency = contact?.otherDetails?.currency || null;
      const baseCurrency = baseByCompany.get(String(doc.companyId)) || null;

      const currency = contactCurrency || baseCurrency;
      const source = contactCurrency ? 'contact' : baseCurrency ? 'company' : null;

      if (!currency) {
        skipped.push({ doc, contact });
        continue;
      }

      toUpdate.push({ doc, contact, currency, source });
    }

    console.log('--- Opening balance: missing currency ---');
    console.log(`To update: ${toUpdate.length}`);
    console.log(`Skipped: ${skipped.length}\n`);

    toUpdate.forEach(({ doc, contact, currency, source }, i) => {
      const contactLabel = contact?.customerDisplayName || contact?.code || doc.contactId;
      console.log(
        `${i + 1}. _id=${doc._id} transactionNo=${doc.transactionNo ?? '-'} type=${doc.type ?? '-'} contact=${contactLabel} source=${source} currency=${JSON.stringify(doc.currency)} → ${currency}`,
      );
    });

    if (skipped.length > 0) {
      console.log('\nSkipped (no contact/company currency):');
      skipped.forEach(({ doc, contact }, i) => {
        const contactLabel = contact?.customerDisplayName || contact?.code || doc.contactId || '-';
        console.log(
          `${i + 1}. _id=${doc._id} transactionNo=${doc.transactionNo ?? '-'} contact=${contactLabel} companyId=${doc.companyId}`,
        );
      });
    }

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }

    if (toUpdate.length === 0) return;

    const res = await obColl.bulkWrite(
      toUpdate.map(({ doc, currency }) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { currency, exchangeRate: 1 } },
        },
      })),
      { ordered: false },
    );

    console.log(`\nUpdated: ${res.modifiedCount ?? 0}`);
  } finally {
    if (db?.client) await db.client.close();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
