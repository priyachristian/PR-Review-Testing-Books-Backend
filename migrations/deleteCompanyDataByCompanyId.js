/**
 * Delete ALL data for a given companyId, across every collection in every
 * connected database (common, books-crm, books, crm, admin) that references
 * it — normally via a `companyId` field, or via FIELD_OVERRIDES below for
 * collections that name that field differently (e.g. books.roles/crm.roles
 * use `company`).
 *
 * Unlike scripts/undo-copy-company.js (which walks a hardcoded model list),
 * this discovers collections dynamically via listCollections(), so it can't
 * go stale as new modules/collections are added.
 *
 * After clearing referencing data, the company's own document in the
 * `companies` collection (matched by _id, not companyId) is also deleted —
 * this is a full teardown of the company.
 *
 * USE WITH CAUTION: This is destructive and cannot be reversed.
 *
 * Usage:
 *   node migrations/deleteCompanyDataByCompanyId.js --companyId=<companyId>            (dry-run)
 *   node migrations/deleteCompanyDataByCompanyId.js --companyId=<companyId> --confirm  (live delete)
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const readline = require('readline');
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const SKIP_COLLECTIONS = new Set(['companies']);

// Collections that reference the company via a field other than `companyId`.
const FIELD_OVERRIDES = {
  roles: 'company', // books.roles and crm.roles use `company`, not `companyId`
};

function parseArgs() {
  const out = { companyId: null, confirm: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--companyId=')) out.companyId = arg.split('=')[1].trim();
    else if (arg === '--confirm') out.confirm = true;
  }
  return out;
}

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Deletes (or counts, in dry-run) matching docs across every non-system collection in one DB. */
async function processDatabase(db, dbLabel, companyObjectId, isDryRun) {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  let dbTotal = 0;
  const results = [];

  for (const { name } of collections) {
    if (SKIP_COLLECTIONS.has(name) || name.startsWith('system.')) continue;

    const fieldName = FIELD_OVERRIDES[name] || 'companyId';
    const filter = { [fieldName]: companyObjectId };
    const collection = db.collection(name);
    const count = await collection.countDocuments(filter);
    if (count === 0) continue;

    if (isDryRun) {
      console.log(`  ~ ${dbLabel}.${name} (${fieldName}): ${count} docs would be deleted`);
    } else {
      await collection.deleteMany(filter);
      console.log(`  ✓ ${dbLabel}.${name} (${fieldName}): ${count} docs deleted`);
    }

    dbTotal += count;
    results.push({ collection: name, count });
  }

  if (results.length === 0) {
    console.log(`  - no matching documents in ${dbLabel}`);
  }

  return { dbTotal, results };
}

async function main() {
  const { companyId, confirm } = parseArgs();
  const isDryRun = !confirm;

  if (!companyId || !ObjectId.isValid(companyId)) {
    console.error('Usage: node migrations/deleteCompanyDataByCompanyId.js --companyId=<companyId> [--confirm]');
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('   Delete Company Data by companyId');
  console.log('========================================');
  console.log(`Company : ${companyId}`);
  console.log(`Mode    : ${isDryRun ? 'DRY-RUN (no changes)' : 'LIVE DELETE'}`);
  console.log(`Env     : ${process.env.NODE_ENV}\n`);

  if (isDryRun) {
    console.log('Running in DRY-RUN mode — nothing will be deleted.');
    console.log('Add --confirm to perform actual deletion.\n');
  } else {
    console.log('WARNING: This will permanently delete ALL data referencing this company,');
    console.log('AND the company record itself. This cannot be undone.\n');
    const answer = await prompt('Type the companyId to confirm deletion: ');
    if (answer !== companyId) {
      console.log('\nConfirmation failed. Aborting.');
      process.exit(1);
    }
    console.log();
  }

  const connection = await getConnection();
  const { client } = connection;
  const companyObjectId = new ObjectId(companyId);
  const databases = [
    { db: connection.common, label: 'common' },
    { db: connection.booksCrm, label: 'booksCrm' },
    { db: connection.books, label: 'books' },
    { db: connection.crm, label: 'crm' },
    { db: connection.admin, label: 'admin' },
  ];

  const startTime = Date.now();
  let totalDocs = 0;
  const breakdown = {};

  try {
    for (const { db, label } of databases) {
      if (!db) continue;
      console.log(`\n${label} DB`);
      const { dbTotal, results } = await processDatabase(db, label, companyObjectId, isDryRun);
      totalDocs += dbTotal;
      if (results.length > 0) breakdown[label] = results;
    }

    console.log('\ncompanies (company record)');
    const companyRecordFilter = { _id: companyObjectId };
    const companyExists = await connection.common.collection('companies').countDocuments(companyRecordFilter);
    if (companyExists === 0) {
      console.log('  - no matching company record');
    } else if (isDryRun) {
      console.log(`  ~ companies: 1 doc would be deleted`);
      totalDocs += 1;
    } else {
      await connection.common.collection('companies').deleteOne(companyRecordFilter);
      console.log(`  ✓ companies: 1 doc deleted`);
      totalDocs += 1;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n========================================');
    if (isDryRun) {
      console.log(`  DRY-RUN complete in ${elapsed}s`);
      console.log(`  ${totalDocs} documents would be deleted`);
      console.log('\n  Run with --confirm to perform actual deletion.');
    } else {
      console.log(`  Done in ${elapsed}s — ${totalDocs} documents deleted`);
    }
    console.log('========================================\n');
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
