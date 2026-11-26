/**
 * Migration: <short description here>
 *
 * Usage:
 *   node migrations/MIGRATION_TEMPLATE.js up
 *   node migrations/MIGRATION_TEMPLATE.js down
 */
const { getConnection } = require('../config/db');

module.exports = {
  /**
   * Apply the migration.
   */
  async up() {
    const { client, booksCrm } = await getConnection();

    try {
      // TODO: Add forward migration logic here.
      // Example:
      // await booksCrm.collection('myCollection').updateMany({}, { $set: { migrated: true } });

      console.log('✅ Migration up completed');
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },

  /**
   * Revert the migration.
   */
  async down() {
    const { client, booksCrm } = await getConnection();

    try {
      // TODO: Add rollback logic here.
      // Example:
      // await booksCrm.collection('myCollection').updateMany({}, { $unset: { migrated: '' } });

      console.log('✅ Migration down completed');
    } catch (err) {
      console.error('❌ Migration down failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  const direction = process.argv[2];

  if (!['up', 'down'].includes(direction)) {
    console.error('Usage: node <file> [up|down]');
    process.exit(1);
  }

  module.exports[direction]()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
