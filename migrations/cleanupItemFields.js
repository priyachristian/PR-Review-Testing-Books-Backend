// Removes item fields that were taken out of the Item Master and that nothing reads. Add future item field removals to REMOVED_FIELDS.
// dry-run: node migrations/cleanupItemFields.js
// apply: node migrations/cleanupItemFields.js --apply
const { getConnection } = require('../config/db');

const REMOVED_FIELDS = [
  // Purchasing Data → Purchase Item Packing Data
  'purchasingData.itemPackingData',
  // Sales Data → Purchase Item Packing Data, Packaging UOM Name, Quantity Per Package
  'salesData.purchaseItemPackingData',
  'salesData.packagingUOMName',
  'salesData.quantityPerPackage',
  // Production Data → duplicate Time Batch / Punching Expiry Mandatory rows (GRPO and Bill read the Purchasing Data ones)
  'productionData.timeBatchNumberMandatory',
  'productionData.punchingTimeBatchNumberMandatory',
  // Production Data → OQC switch and OQC Standard
  'productionData.oqc',
  'productionData.oqcStander',
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
