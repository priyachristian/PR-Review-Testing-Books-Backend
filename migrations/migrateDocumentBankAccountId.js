/**
 * Document-level bank reference -> bankAccountId (accounting-correct split).
 *
 * Sales-side documents (customer pays us) keep the company bank account whose
 * details print on the PDF: the field is renamed bankId -> bankAccountId and
 * old values (Bank collection ids) are remapped through Bank.accountId to the
 * merged chart-of-accounts Account ids.
 *
 * Purchase-side documents (we pay the vendor) never need our bank details on
 * them, so their bankId is removed entirely.
 *
 * Run AFTER mergeBanksIntoAccounts.js (which creates the Bank -> Account links).
 * Idempotent: documents already carrying bankAccountId without bankId are skipped.
 *
 * Run: node migrations/migrateDocumentBankAccountId.js            (all companies)
 *      node migrations/migrateDocumentBankAccountId.js <companyId> (single company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const SALES_TARGETS = [
  { db: 'booksCrm', collection: 'quotes' },
  { db: 'booksCrm', collection: 'salesorders' },
  { db: 'books', collection: 'invoices' },
  { db: 'books', collection: 'recurringinvoices' },
  { db: 'books', collection: 'creditnotes' },
  { db: 'books', collection: 'deliverychallans' },
];

const PURCHASE_TARGETS = [
  { db: 'books', collection: 'bills' },
  { db: 'books', collection: 'recurringbills' },
  { db: 'books', collection: 'purchaseorders' },
  { db: 'books', collection: 'grpoorders' },
  { db: 'books', collection: 'debitnotes' },
];

const buildBankToAccountMap = async (db, companyScope) => {
  const banks = await db.booksCrm.collection('banks').find(companyScope).project({ _id: 1, accountId: 1 }).toArray();

  const accountIdByBankId = new Map();
  for (const bank of banks) {
    if (bank.accountId) {
      accountIdByBankId.set(bank._id.toString(), bank.accountId);
    }
  }
  return accountIdByBankId;
};

const runMigrateDocumentBankAccountId = async (targetCompanyId = null, excludeCompanyIds = []) => {
  const db = await getConnection();
  const client = db.client;

  try {
    console.log('Connected to MongoDB');

    const companyScope = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludeCompanyIds.length
        ? { companyId: { $nin: excludeCompanyIds } }
        : {};
    const accountIdByBankId = await buildBankToAccountMap(db, companyScope);
    console.log(`Bank -> Account links available: ${accountIdByBankId.size}`);

    const summary = { sales: {}, purchase: {} };

    for (const target of SALES_TARGETS) {
      const collection = db[target.db].collection(target.collection);
      const documents = await collection
        .find({
          ...companyScope,
          bankId: { $exists: true, $ne: null },
        })
        .project({ _id: 1, bankId: 1, bankAccountId: 1 })
        .toArray();

      let migrated = 0;
      let skipped = 0;

      for (const document of documents) {
        if (document.bankAccountId && !document.bankId) {
          skipped += 1;
          continue;
        }

        const mappedAccountId = document.bankId ? accountIdByBankId.get(document.bankId.toString()) : null;
        const accountId = mappedAccountId || document.bankAccountId || document.bankId || null;

        await collection.updateOne({ _id: document._id }, { $set: { bankAccountId: accountId }, $unset: { bankId: '' } });
        migrated += 1;
      }

      summary.sales[target.collection] = { migrated, skipped };
      console.log(`${target.collection}: ${migrated} migrated to bankAccountId, ${skipped} skipped`);
    }

    for (const target of PURCHASE_TARGETS) {
      const collection = db[target.db].collection(target.collection);
      const result = await collection.updateMany({ ...companyScope, bankId: { $exists: true } }, { $unset: { bankId: '' } });
      summary.purchase[target.collection] = result.modifiedCount;
      console.log(`${target.collection}: ${result.modifiedCount} documents cleared of bankId`);
    }

    return summary;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

const migrate = async () => {
  try {
    const targetCompanyId = process.argv[2] ? new ObjectId(process.argv[2]) : null;
    await runMigrateDocumentBankAccountId(targetCompanyId);
    console.log('Document bankAccountId migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
};

if (require.main === module) {
  migrate();
}

module.exports = { runMigrateDocumentBankAccountId, buildBankToAccountMap };
