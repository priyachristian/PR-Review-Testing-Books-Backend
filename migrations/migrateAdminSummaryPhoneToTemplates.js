/**
 * Migration: move AdminSummarySetting's top-level whatsapp.enabled / whatsapp.adminPhoneNumber
 * into each entry of whatsapp.templates as a per-template adminPhoneNumber array, matching the
 * schema change that dropped those two top-level fields in favor of a per-template phone list.
 *
 * The old top-level `enabled` acted as a master switch on top of each template's own `enabled`
 * flag. Since that switch no longer exists, any doc where it was `false` has every template's
 * `enabled` forced to `false` too, so a config that was effectively off before this migration
 * stays off after it (instead of silently starting to send).
 *
 * adminPhoneNumber also changed from a single string to an array of strings, so the old
 * top-level string (and any already-migrated per-template string) is wrapped into a
 * single-element array.
 *
 * Usage:
 *   node migrations/migrateAdminSummaryPhoneToTemplates.js
 */
const { getConnection } = require('../config/db');

const COLLECTION = 'adminsummarysettings';

module.exports = {
  async up() {
    const { client, books } = await getConnection();

    try {
      const col = books.collection(COLLECTION);
      const cursor = col.find({
        $or: [
          { 'whatsapp.enabled': { $exists: true } },
          { 'whatsapp.adminPhoneNumber': { $exists: true } },
          { 'whatsapp.templates.adminPhoneNumber': { $type: 'string' } },
        ],
      });

      let migrated = 0;
      // eslint-disable-next-line no-await-in-loop
      while (await cursor.hasNext()) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await cursor.next();
        const whatsapp = doc.whatsapp || {};
        const wasEnabled = whatsapp.enabled !== false; // treat missing as previously-on, same as old schema default
        const topLevelPhones = whatsapp.adminPhoneNumber ? [whatsapp.adminPhoneNumber] : [];
        const templates = Array.isArray(whatsapp.templates) ? whatsapp.templates : [];

        const migratedTemplates = templates.map(template => {
          const templatePhones = Array.isArray(template?.adminPhoneNumber)
            ? template.adminPhoneNumber.filter(Boolean)
            : [template?.adminPhoneNumber].filter(Boolean);

          return {
            ...template,
            enabled: wasEnabled ? Boolean(template?.enabled) : false,
            adminPhoneNumber: templatePhones.length ? templatePhones : topLevelPhones,
          };
        });

        // eslint-disable-next-line no-await-in-loop
        await col.updateOne(
          { _id: doc._id },
          {
            $set: { 'whatsapp.templates': migratedTemplates },
            $unset: { 'whatsapp.enabled': '', 'whatsapp.adminPhoneNumber': '' },
          },
        );
        migrated += 1;
      }

      console.log(`✅ Migration up completed — migrated ${migrated} setting(s) to per-template adminPhoneNumber`);
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  module.exports
    .up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
