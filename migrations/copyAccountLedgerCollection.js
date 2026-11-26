/**
 * Migration: copy the Account Ledger collection accountledger2 -> accountledger
 *
 * The model was renamed AccountLedger2 -> AccountLedger and now reads collection 'accountledger'
 * (abss-models accountLedger.model.js). This copies every document with the same _id (manual journals,
 * expenses and ledger entries point to these ids) and the same indexes. accountledger2 is left untouched
 * as a backup.
 *
 * Safe to run again: a document is copied only when it is missing from accountledger or newer in
 * accountledger2, so edits made in accountledger after the switch are never overwritten.
 *
 * Dry run by default; add --apply to write.
 *
 * Usage:
 *   node migrations/copyAccountLedgerCollection.js
 *   node migrations/copyAccountLedgerCollection.js --apply
 */
const { getConnection } = require('../config/db');

const from = 'accountledger2';
const to = 'accountledger';
const isApply = process.argv.includes('--apply');

const run = async () => {
  const { client, books } = await getConnection();

  try {
    const names = (await books.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name);
    if (!names.includes(from)) {
      console.log(`Nothing to do: ${from} does not exist.`);
      return;
    }

    const source = books.collection(from);
    const target = books.collection(to);

    // Step 1: which source documents the target is missing or has an older copy of
    const sourceDocs = await source.find({}).toArray();
    const targetUpdatedAt = new Map(
      (await target.find({}).project({ updatedAt: 1 }).toArray()).map(doc => [String(doc._id), doc.updatedAt]),
    );
    const missingDocs = sourceDocs.filter(doc => !targetUpdatedAt.has(String(doc._id)));
    const newerDocs = sourceDocs.filter(
      doc => targetUpdatedAt.has(String(doc._id)) && doc.updatedAt > targetUpdatedAt.get(String(doc._id)),
    );
    const sourceIndexes = (await source.indexes()).filter(index => index.name !== '_id_');

    console.log(
      `${from}: ${sourceDocs.length} docs | ${to}: ${names.includes(to) ? `${targetUpdatedAt.size} docs` : 'does not exist'}`,
    );
    console.log(`To copy: ${missingDocs.length} missing, ${newerDocs.length} newer in ${from}`);
    console.log(`Indexes: ${sourceIndexes.map(index => JSON.stringify(index.key) + (index.unique ? ' unique' : '')).join(', ')}`);

    if (!isApply) {
      console.log('DRY RUN - nothing written. Add --apply to copy.');
      return;
    }

    // Step 2: same indexes first, so the unique rule guards the copy
    for (const { key, name, unique, sparse, partialFilterExpression } of sourceIndexes) {
      await target.createIndex(key, {
        name,
        ...(unique ? { unique } : {}),
        ...(sparse ? { sparse } : {}),
        ...(partialFilterExpression ? { partialFilterExpression } : {}),
      });
    }

    // Step 3: copy with the same _id
    const writes = [...missingDocs, ...newerDocs].map(doc => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    }));
    if (writes.length) await target.bulkWrite(writes, { ordered: false });

    // Step 4: verify every source document is in the target, unchanged unless the target copy is newer
    const targetById = new Map((await target.find({}).toArray()).map(doc => [String(doc._id), doc]));
    const notCopied = sourceDocs.filter(doc => !targetById.has(String(doc._id)));
    const different = sourceDocs.filter(doc => {
      const copy = targetById.get(String(doc._id));
      return copy && !(copy.updatedAt > doc.updatedAt) && JSON.stringify(copy) !== JSON.stringify(doc);
    });

    console.log(`Copied ${writes.length} docs -> ${to} now has ${targetById.size} docs`);
    console.log(`Verify: missing ${notCopied.length}, different ${different.length}`);
    if (notCopied.length || different.length) {
      throw new Error(`Verification failed: ${[...notCopied, ...different].map(doc => String(doc._id)).join(', ')}`);
    }
    console.log('✅ All documents copied and verified');
  } finally {
    await client.close();
  }
};

run()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  });
