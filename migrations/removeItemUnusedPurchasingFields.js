// Removes the old BOE, IQC, Purchase to Sales UOM Convert and Vendor Platform / Preferred Vendor fields from items; nothing read them.
// dry-run: node migrations/removeItemUnusedPurchasingFields.js
// apply: node migrations/removeItemUnusedPurchasingFields.js --apply
const { getConnection } = require('../config/db');

const REMOVED_FIELDS = [
  'purchasingData.vendorPlatformAndApp',
  'purchasingData.preferredVendor',
  'purchasingData.boeNumberMandatory',
  'purchasingData.beforeDispatchFromVendorFactory',
  'purchasingData.beforeDispatchQCStandard',
  'purchasingData.afterGRPOOnOurWarehouse',
  'purchasingData.afterGRPOQCStandard',
  'purchasingData.purchaseToSalesUOMConvert',
];

const migrate = async () => {
  let client;
  try {
    const apply = process.argv.slice(2).includes('--apply');
    const db = await getConnection();
    client = db.client;
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const items = db.booksCrm.collection('items');
    for (const field of REMOVED_FIELDS) {
      const stored = await items.countDocuments({ [field]: { $exists: true } });
      console.log(`${field}: stored on ${stored}`);
    }

    const filter = { $or: REMOVED_FIELDS.map(field => ({ [field]: { $exists: true } })) };
    console.log(`Items to update: ${await items.countDocuments(filter)}`);

    if (!apply) {
      console.log('Nothing was written. Re-run with --apply.');
      return;
    }

    const unsetFields = Object.fromEntries(REMOVED_FIELDS.map(field => [field, '']));
    const result = await items.updateMany(filter, { $unset: unsetFields });
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
