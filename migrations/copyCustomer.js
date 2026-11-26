/**
 * @deprecated Misnamed — this file previously copied items. Use:
 *   node migrations/copyItemsBetweenCompanies.js
 *
 * Kept as a thin alias so old commands still work.
 */
const { copyItemsBetweenCompanies } = require('./copyItemsBetweenCompanies');

copyItemsBetweenCompanies()
  .then(() => {
    console.log('Migration completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
