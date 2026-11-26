const { getConnection } = require('../config/db');

const INDEX_SPEC = { code: 1 };
// Auto-generated name for the { code: 1 } index — used to drop it by name in down().
const INDEX_NAME = 'code_1';
// Partial (not sparse): only index documents whose `code` is a real string.
// `company.code` defaults to null, so a sparse unique index would treat every
// null-code company as indexed and reject the 2nd one with E11000. `$type: 'string'`
// excludes null AND missing, so unlimited companies may have no code while set
// codes stay unique. Must match the index declared in abss-models company.model.js.
const INDEX_OPTIONS = { unique: true, partialFilterExpression: { code: { $type: 'string' } } };

module.exports = {
  /**
   * Apply the migration
   */
  async up(apply = false) {
    const { client, common } = await getConnection();

    try {
      const companies = common.collection('companies');

      if (!apply) {
        console.log(`[dry run] Would build index { ${JSON.stringify(INDEX_SPEC)} } on companies with`, INDEX_OPTIONS);
        console.log('Re-run with --apply to write.');
        return;
      }

      const name = await companies.createIndex(INDEX_SPEC, INDEX_OPTIONS);
      console.log(`✅ Migration up completed — built index "${name}" on companies.code`);
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },

  /**
   * Revert the migration
   */
  async down(apply = false) {
    const { client, common } = await getConnection();

    try {
      const companies = common.collection('companies');

      if (!apply) {
        console.log('[dry run] Would drop the companies.code index. Re-run with --apply to write.');
        return;
      }

      await companies.dropIndex(INDEX_NAME);
      console.log('✅ Migration down completed — dropped index on companies.code');
    } catch (err) {
      if (err.codeName === 'IndexNotFound') {
        console.log('Index already absent. Nothing to do.');
        return;
      }
      console.error('❌ Migration down failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

// Optional CLI helper
if (require.main === module) {
  const direction = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!['up', 'down'].includes(direction)) {
    console.error('Usage: node <file> [up|down] [--apply]');
    process.exit(1);
  }
  module.exports[direction](apply)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
