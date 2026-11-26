// Removes the old Portable Language, Add More Details, Category and Code fields from customers and vendors; their UI and validation were removed.
// Also removes the customer code copied into the old `customerData` object on early documents.
// dry-run: node migrations/removeCustomerUnusedFields.js
// apply: node migrations/removeCustomerUnusedFields.js --apply
const { getConnection } = require('../config/db');

const REMOVED_FIELDS = [
  'otherDetails.portableLanguage',
  'otherDetails.website',
  'otherDetails.department',
  'otherDetails.designation',
  'otherDetails.twitter',
  'otherDetails.skypeNumber',
  'otherDetails.facebook',
  'Category',
  'code',
];

const DOCUMENT_COLLECTIONS = [
  ['books', 'grpoorders'],
  ['books', 'purchaseorders'],
  ['books', 'creditnotes'],
  ['booksCrm', 'salesorders'],
  ['booksCrm', 'quotes'],
];

const migrate = async () => {
  let client;
  try {
    const apply = process.argv.slice(2).includes('--apply');
    const db = await getConnection();
    client = db.client;
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const customers = db.booksCrm.collection('customers');
    for (const field of REMOVED_FIELDS) {
      const stored = await customers.countDocuments({ [field]: { $exists: true } });
      console.log(`${field}: stored on ${stored}`);
    }

    const filter = { $or: REMOVED_FIELDS.map(field => ({ [field]: { $exists: true } })) };
    console.log(`Customers / vendors to update: ${await customers.countDocuments(filter)}`);

    const documentFilter = { 'customerData.code': { $exists: true } };
    for (const [dbName, collectionName] of DOCUMENT_COLLECTIONS) {
      const stored = await db[dbName].collection(collectionName).countDocuments(documentFilter);
      console.log(`${collectionName} with customerData.code: ${stored}`);
    }

    if (!apply) {
      console.log('Nothing was written. Re-run with --apply.');
      return;
    }

    const unsetFields = Object.fromEntries(REMOVED_FIELDS.map(field => [field, '']));
    const result = await customers.updateMany(filter, { $unset: unsetFields });
    console.log(`Updated: ${result.modifiedCount}`);

    for (const [dbName, collectionName] of DOCUMENT_COLLECTIONS) {
      const documentResult = await db[dbName]
        .collection(collectionName)
        .updateMany(documentFilter, { $unset: { 'customerData.code': '' } });
      console.log(`${collectionName} updated: ${documentResult.modifiedCount}`);
    }
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
