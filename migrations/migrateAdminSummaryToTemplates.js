/**
 * Migration: move AdminSummarySetting whatsapp.{daily,weekly,monthly} into
 * the generalized whatsapp.templates array as a `financialSummary` template.
 *
 * Usage:
 *   node migrations/migrateAdminSummaryToTemplates.js up
 *   node migrations/migrateAdminSummaryToTemplates.js down
 */
const { getConnection } = require('../config/db');

const COLLECTION = 'adminsummarysettings';
const FINANCIAL_SUMMARY_KEY = 'financialSummary';

module.exports = {
  async up() {
    const { client, books } = await getConnection();

    try {
      const col = books.collection(COLLECTION);
      const cursor = col.find({
        $or: [
          { 'whatsapp.daily': { $exists: true } },
          { 'whatsapp.weekly': { $exists: true } },
          { 'whatsapp.monthly': { $exists: true } },
        ],
      });

      let migrated = 0;
      // eslint-disable-next-line no-await-in-loop
      while (await cursor.hasNext()) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await cursor.next();
        const whatsapp = doc.whatsapp || {};
        const daily = whatsapp.daily || null;
        const weekly = whatsapp.weekly || null;
        const monthly = whatsapp.monthly || null;

        const templateEnabled = Boolean(daily?.enabled || weekly?.enabled || monthly?.enabled);
        const existingTemplates = Array.isArray(whatsapp.templates) ? whatsapp.templates : [];
        const otherTemplates = existingTemplates.filter(t => t?.key !== FINANCIAL_SUMMARY_KEY);

        const financialSummary = {
          key: FINANCIAL_SUMMARY_KEY,
          enabled: templateEnabled,
          ...(daily ? { daily } : {}),
          ...(weekly ? { weekly } : {}),
          ...(monthly ? { monthly } : {}),
        };

        // eslint-disable-next-line no-await-in-loop
        await col.updateOne(
          { _id: doc._id },
          {
            $set: { 'whatsapp.templates': [financialSummary, ...otherTemplates] },
            $unset: { 'whatsapp.daily': '', 'whatsapp.weekly': '', 'whatsapp.monthly': '' },
          },
        );
        migrated += 1;
      }

      console.log(`✅ Migration up completed — moved ${migrated} setting(s) to whatsapp.templates`);
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },

  async down() {
    const { client, books } = await getConnection();

    try {
      const col = books.collection(COLLECTION);
      const cursor = col.find({ 'whatsapp.templates.key': FINANCIAL_SUMMARY_KEY });

      let reverted = 0;
      // eslint-disable-next-line no-await-in-loop
      while (await cursor.hasNext()) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await cursor.next();
        const whatsapp = doc.whatsapp || {};
        const templates = Array.isArray(whatsapp.templates) ? whatsapp.templates : [];
        const financialSummary = templates.find(t => t?.key === FINANCIAL_SUMMARY_KEY) || {};
        const otherTemplates = templates.filter(t => t?.key !== FINANCIAL_SUMMARY_KEY);

        const set = { 'whatsapp.templates': otherTemplates };
        if (financialSummary.daily) set['whatsapp.daily'] = financialSummary.daily;
        if (financialSummary.weekly) set['whatsapp.weekly'] = financialSummary.weekly;
        if (financialSummary.monthly) set['whatsapp.monthly'] = financialSummary.monthly;

        // eslint-disable-next-line no-await-in-loop
        await col.updateOne({ _id: doc._id }, { $set: set });
        reverted += 1;
      }

      console.log(`✅ Migration down completed — reverted ${reverted} setting(s)`);
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
    console.error('Usage: node migrations/migrateAdminSummaryToTemplates.js [up|down]');
    process.exit(1);
  }

  module.exports[direction]()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
