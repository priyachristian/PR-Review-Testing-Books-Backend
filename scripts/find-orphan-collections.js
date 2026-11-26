/**
 * find-orphan-collections.js
 *
 * Finds MongoDB collections that still exist in the databases but are no longer
 * backed by any model in the INSTALLED @smit9313/abss-models-core package — i.e.
 * collections whose model file was removed from abss-models.
 *
 * Detection source of truth = the registered Mongoose models (their real
 * collection names via Model.collection.collectionName), compared against the
 * collections actually present in each physical database.
 *
 * IMPORTANT: this reflects the abss-models version installed in THIS backend's
 * node_modules. If you removed a model in the abss-models repo but have not yet
 * published + `npm install`ed that new version here, the model is still
 * registered and its collection will NOT be reported as an orphan. The script
 * prints the installed version so you can confirm.
 *
 * Usage:
 *   node scripts/find-orphan-collections.js                 # report every DB (read-only)
 *   node scripts/find-orphan-collections.js --db=books      # report one DB
 *
 *   # Act on SPECIFIC detected orphans only (never mass-acts):
 *   node scripts/find-orphan-collections.js --db=books --archive --only=foo,bar
 *   node scripts/find-orphan-collections.js --db=books --drop    --only=foo,bar --yes
 *
 *   --archive  rename each named orphan to `zz_orphan_<name>_<YYYYMMDD>` (REVERSIBLE)
 *   --drop     permanently drop each named orphan (requires --yes)
 *   --only     comma-separated collection names; every name must be a detected
 *              orphan in the chosen --db, or the script refuses and does nothing
 *   --db       required for --archive/--drop (disambiguates same-named collections)
 */

// Load env the same way config/config.js does (environment-specific first, then
// fallback), BEFORE requiring the models package — it validates ABSS_CLUSTER and
// the six DB URLs at require time. Override the target env with NODE_ENV=<env>.
const path = require('path');
const dotenv = require('dotenv');
const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: path.join(__dirname, `../.env.${env}`) });
dotenv.config({ path: path.join(__dirname, '../.env') });

// Collections that legitimately have no model — never treat these as orphans.
// Edit this list for your environment.
const IGNORE_PATTERNS = [
  /^system\./, // Mongo internal
  /\.chunks$/, // GridFS
  /\.files$/, // GridFS
  /^fs\./, // GridFS default bucket
  /^migrations?$/i, // migration bookkeeping
  /^changelog$/i, // migration bookkeeping
  /^customfields$/i, // customField.model.js is loaded as a sub-schema, not a standalone model
];

const args = process.argv.slice(2);
const hasFlag = name => args.includes(`--${name}`);
const getOpt = name => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const ARCHIVE = hasFlag('archive');
const DROP = hasFlag('drop');
const YES = hasFlag('yes');
const DB_FILTER = getOpt('db');
const ONLY = (getOpt('only') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const isIgnored = name => IGNORE_PATTERNS.some(re => re.test(name));
const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function main() {
  if (ARCHIVE && DROP) {
    console.error('Pass only one of --archive or --drop, not both.');
    process.exit(1);
  }
  if ((ARCHIVE || DROP) && !DB_FILTER) {
    console.error('--archive/--drop require --db=<key> (e.g. --db=books) to target one database.');
    process.exit(1);
  }
  if ((ARCHIVE || DROP) && !ONLY.length) {
    console.error('--archive/--drop require --only=name1,name2 naming the exact orphan collections to act on.');
    process.exit(1);
  }

  const { getModelsAndConnections } = require('@smit9313/abss-models-core');
  const config = require('../config/config');

  let installedVersion = 'unknown';
  try {
    installedVersion = require('@smit9313/abss-models-core/package.json').version;
  } catch (_) {
    /* ignore */
  }
  console.log(`Installed @smit9313/abss-models-core: ${installedVersion}`);
  console.log('Orphan detection reflects THIS installed version. If you removed models in the');
  console.log('abss-models repo but have not installed that version here, run npm install first.\n');

  const { models, connections } = await getModelsAndConnections(config.mongoose.db_names);

  // Wait for the underlying cluster connection to be ready before listing collections.
  const raw = connections.rawConnection;
  if (raw.readyState !== 1) await raw.asPromise();

  // Group known collection names by PHYSICAL database name (several model keys can,
  // in principle, resolve to the same physical DB — union their known collections).
  const knownByDb = new Map(); // physicalDbName -> Set<collectionName>
  const connByDb = new Map(); // physicalDbName -> mongoose connection
  const keyByDb = new Map(); // physicalDbName -> model key (for messaging)

  for (const [key, conn] of Object.entries(connections)) {
    if (key === 'rawConnection') continue;
    const physical = conn.name; // the db name passed to useDb()
    if (!knownByDb.has(physical)) {
      knownByDb.set(physical, new Set());
      connByDb.set(physical, conn);
      keyByDb.set(physical, key);
    }
    const registry = models[key] || {};
    for (const model of Object.values(registry)) {
      knownByDb.get(physical).add(model.collection.collectionName);
    }
  }

  // If a --db filter is given, map it to its physical db name.
  let onlyPhysical = null;
  if (DB_FILTER) {
    const conn = connections[DB_FILTER];
    if (!conn) {
      console.error(
        `Unknown --db=${DB_FILTER}. Valid keys: ${Object.keys(connections)
          .filter(k => k !== 'rawConnection')
          .join(', ')}`,
      );
      await raw.close();
      process.exit(1);
    }
    onlyPhysical = conn.name;
  }

  const report = []; // { physical, key, orphans: [{name, type, count}] }

  for (const [physical, known] of knownByDb.entries()) {
    if (onlyPhysical && physical !== onlyPhysical) continue;

    const conn = connByDb.get(physical);
    const nativeDb = conn.db;
    const existing = await nativeDb.listCollections().toArray();

    const orphans = [];
    const ignored = [];
    for (const info of existing) {
      const name = info.name;
      if (known.has(name)) continue;
      if (isIgnored(name)) {
        ignored.push(name);
        continue;
      }
      let count = null;
      try {
        count = await nativeDb.collection(name).estimatedDocumentCount();
      } catch (_) {
        /* views etc. */
      }
      orphans.push({ name, type: info.type || 'collection', count });
    }

    console.log(`\n=== DB "${physical}" (key: ${keyByDb.get(physical)}) ===`);
    console.log(`  models/known collections: ${known.size}`);
    console.log(`  collections in DB:        ${existing.length}`);
    if (ignored.length) console.log(`  ignored (no model by design): ${ignored.join(', ')}`);
    if (!orphans.length) {
      console.log('  No orphan collections. ✅');
    } else {
      console.log(`  ORPHAN candidates (in DB, no current model): ${orphans.length}`);
      for (const o of orphans) {
        console.log(`    - ${o.name}  [${o.type}]  ~${o.count == null ? '?' : o.count} docs`);
      }
    }
    report.push({ physical, key: keyByDb.get(physical), orphans });
  }

  // ---- Destructive / reversible actions (only with --db + --only) ----
  if (ARCHIVE || DROP) {
    const target = report.find(r => r.physical === onlyPhysical);
    const orphanNames = new Set((target?.orphans || []).map(o => o.name));

    // Refuse any name that is not a detected orphan in this DB.
    const bad = ONLY.filter(n => !orphanNames.has(n));
    if (bad.length) {
      console.error(`\nRefusing to act. These --only names are NOT detected orphans in "${onlyPhysical}": ${bad.join(', ')}`);
      console.error('Re-run the report and copy exact orphan names. Nothing was changed.');
      await raw.close();
      process.exit(1);
    }

    if (DROP && !YES) {
      console.error('\n--drop permanently deletes data. Re-run with --yes to confirm. Nothing was changed.');
      await raw.close();
      process.exit(1);
    }

    const nativeDb = connByDb.get(onlyPhysical).db;
    console.log(`\nMode: ${ARCHIVE ? 'ARCHIVE (rename, reversible)' : 'DROP (permanent)'} on DB "${onlyPhysical}"`);
    for (const name of ONLY) {
      if (ARCHIVE) {
        const archived = `zz_orphan_${name}_${stamp()}`;
        await nativeDb.renameCollection(name, archived);
        console.log(`  archived: ${name} -> ${archived}`);
      } else {
        await nativeDb.collection(name).drop();
        console.log(`  dropped: ${name}`);
      }
    }
    console.log('Done.');
  } else {
    const anyOrphans = report.some(r => r.orphans.length);
    if (anyOrphans) {
      console.log('\nTo remove specific orphans (reversible first, recommended):');
      console.log('  node scripts/find-orphan-collections.js --db=<key> --archive --only=name1,name2');
      console.log('Then, once confident, drop permanently:');
      console.log('  node scripts/find-orphan-collections.js --db=<key> --drop --only=name1,name2 --yes');
    }
  }

  await raw.close();
  process.exit(0);
}

main().catch(error => {
  console.error('find-orphan-collections failed:', error);
  process.exit(1);
});
