/**
 * Migration: Remove stale `backOrderOnly` field from ItemInventory documents.
 *
 * `backOrderOnly` is no longer part of the ItemInventory schema (see
 * @smit9313/abss-models-core itemInventory.model.js) but still lingers on documents in
 * `booksCrm.iteminventories` from before the field was dropped.
 *
 * Runs as a DRY RUN by default — pass --apply to actually write.
 *
 * Usage:
 *   node migrations/removeBackOrderOnlyFromItemInventory.js            # dry run
 *   node migrations/removeBackOrderOnlyFromItemInventory.js --apply
 */
const { getConnection } = require('../config/db');

const COLLECTION = 'iteminventories';
const FIELD = 'backOrderOnly';

async function run(apply = false) {
  const { client, booksCrm } = await getConnection();

  try {
    const itemInventories = booksCrm.collection(COLLECTION);
    const filter = { [FIELD]: { $exists: true } };

    console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);

    const toUpdate = await itemInventories.countDocuments(filter);
    console.log('--- Remove backOrderOnly (ItemInventory) ---');
    console.log(`Documents with field: ${toUpdate}`);

    if (toUpdate === 0) {
      console.log('\nNothing to update.');
      return;
    }

    if (!apply) {
      console.log('\nDry run only — re-run with --apply to unset the field.');
      return;
    }

    const result = await itemInventories.updateMany(filter, { $unset: { [FIELD]: '' } });
    console.log(`\nUpdated ${result.modifiedCount} document(s).`);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { run };

if (require.main === module) {
  const apply = process.argv.includes('--apply');

  run(apply)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
