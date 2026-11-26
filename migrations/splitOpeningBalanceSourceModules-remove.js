/**
 * Migration: tag every opening balance ledger row with the source it was posted from.
 *
 * Opening balance reaches the ledger from three unrelated places, and for a long time all of
 * them wrote sourceModule OPENING_BALANCE:
 *
 *   account.service.js         sourceId is an AccountOpeningBalance    (books)
 *   customerMaster.service.js  sourceId is an OpeningBalanceTransaction (books-crm)
 *   item.service.js            sourceId is an Item                      (books-crm)
 *
 * SOURCE_DOCUMENTS maps one sourceModule to one model, so the two that are not
 * AccountOpeningBalance could never be looked up. That is why those rows show an empty
 * Document No., no party name and no branch on the Opening Balance Adjustment ledger.
 *
 * The code now posts OPENING_BALANCE (chart account), OPENING_BALANCE_PARTY and OPENING_STOCK.
 * This retags everything written before that by asking each collection which ids it owns, so it
 * also corrects the short-lived OPENING_BALANCE_ACCOUNT / OPENING_BALANCE_ITEM values. Party rows
 * additionally get the branch backfilled, which the old posting path could not resolve.
 *
 * Every row is decided by its source document, never by what it currently says, so the migration
 * is idempotent and safe to re-run. Rows whose source document no longer exists are left alone
 * and listed — there is nothing to point them at.
 *
 * Usage:
 *   node migrations/splitOpeningBalanceSourceModules-remove.js up                         report only, all companies
 *   node migrations/splitOpeningBalanceSourceModules-remove.js up --companyId=<id>        report only, one company
 *   node migrations/splitOpeningBalanceSourceModules-remove.js up --apply                 write, all companies
 *   node migrations/splitOpeningBalanceSourceModules-remove.js up --companyId=<id> --apply write, one company
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

// Everything opening balance has ever been tagged as.
const OPENING_BALANCE_MODULES = ['OPENING_BALANCE', 'OPENING_BALANCE_PARTY', 'OPENING_BALANCE_ITEM', 'OPENING_BALANCE_ACCOUNT'];

// The module each row should carry, and the collection that owns the ids it claims.
const OWNERS = [
  { sourceModule: 'OPENING_BALANCE', db: 'books', collection: 'accountopeningbalances' },
  { sourceModule: 'OPENING_BALANCE_PARTY', db: 'booksCrm', collection: 'openingbalancetransactions' },
  { sourceModule: 'OPENING_STOCK', db: 'booksCrm', collection: 'items' },
];

const parseArgs = () => {
  const companyHit = process.argv.find(a => a.startsWith('--companyId='));
  const companyArg = companyHit === undefined ? undefined : companyHit.slice('--companyId='.length);
  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return {
    companyId: companyArg ? new ObjectId(companyArg) : null,
    apply: process.argv.includes('--apply'),
  };
};

module.exports = {
  async up() {
    const { companyId, apply } = parseArgs();
    const connection = await getConnection();
    const { client, books } = connection;
    const ledgerEntries = books.collection('ledgerentries');
    const companyScope = companyId ? { companyId } : {};

    try {
      console.log(`Scope: ${companyId ? companyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

      const sourceIds = await ledgerEntries.distinct('sourceId', {
        sourceModule: { $in: OPENING_BALANCE_MODULES },
        ...companyScope,
      });
      console.log(`${sourceIds.length} source documents behind opening balance rows`);

      const claimed = new Set();

      for (const owner of OWNERS) {
        const owned = await connection[owner.db]
          .collection(owner.collection)
          .find({ _id: { $in: sourceIds }, ...companyScope })
          .project({ _id: 1, branchId: 1, divisionId: 1 })
          .toArray();

        const ids = [];
        for (const document of owned) {
          claimed.add(String(document._id));
          ids.push(document._id);
        }

        if (!ids.length) {
          console.log(`  ${owner.sourceModule}: none`);
          continue;
        }
        const filter = {
          sourceModule: { $in: OPENING_BALANCE_MODULES, $ne: owner.sourceModule },
          sourceId: { $in: ids },
          ...companyScope,
        };
        const rows = await ledgerEntries.countDocuments(filter);
        console.log(`  ${owner.sourceModule}: ${owned.length} documents, ${rows} rows to retag`);

        if (!apply) continue;
        await ledgerEntries.updateMany(filter, { $set: { sourceModule: owner.sourceModule } });

        // The old path resolved branch against the wrong model, so these rows never got one.
        const withBranch = owned.filter(document => document.branchId);
        if (withBranch.length) {
          const writes = [];
          for (const document of withBranch) {
            writes.push({
              updateMany: {
                filter: { sourceModule: owner.sourceModule, sourceId: document._id, branchId: null, ...companyScope },
                update: { $set: { branchId: document.branchId, divisionId: document.divisionId ?? null } },
              },
            });
          }

          await ledgerEntries.bulkWrite(writes);
        }
      }

      const orphans = sourceIds.filter(id => !claimed.has(String(id)));
      if (orphans.length) {
        console.log(`  ${orphans.length} source documents no longer exist and were left as they are:`);
        for (const id of orphans) {
          console.log(`    ${id}`);
        }
      }

      console.log(apply ? '✅ Migration up completed' : 'ℹ️  Report only — rerun with --apply to write');
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  if (process.argv[2] !== 'up') {
    console.error('Usage: node migrations/splitOpeningBalanceSourceModules-remove.js up [--companyId=<id>] [--apply]');
    process.exit(1);
  }

  module.exports
    .up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
