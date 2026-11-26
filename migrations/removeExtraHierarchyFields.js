/**
 * Strip division/branch/warehouse documents down to an approved set of fields,
 * removing everything else.
 *
 * Fields KEPT (everything else on the document is unset):
 *   - divisions:  companyId, name, divisionCode, address (street1/2, city, state,
 *                 country, pinCode, phone), contactEmail, contactPhone, isActive,
 *                 addedBy, updatedBy
 *   - branches:   companyId, divisionId, branchCode, name, address (basic), gstin,
 *                 branchManager (firstName/lastName/contactEmail/contactPhone),
 *                 isActive, addedBy, updatedBy
 *   - warehouses: companyId, divisionId, branchId, warehouseId, name, isActive,
 *                 addedBy, updatedBy
 *
 * Concretely this removes:
 *   - divisions:  address.faxNumber, divisionManager
 *   - branches:   branchLogo, address.faxNumber, websiteURL, primaryContact,
 *                 transactionNumberSeries, defaultTransactionNumberSeries
 *   - warehouses: warehouseSize, rent, permissions, zoneName, binRack, totalCbm
 *
 * _id, createdAt, and updatedAt are never touched.
 *
 * SAFETY:
 *   - Dry-run by default — prints what would be removed, writes nothing.
 *   - Real values about to be deleted (i.e. not already empty/default) are printed
 *     to the console before the update runs.
 *
 * Usage:
 *   node migrations/removeExtraHierarchyFields.js                          (dry-run, all companies)
 *   node migrations/removeExtraHierarchyFields.js --companyId=<id>         (dry-run, one company)
 *   node migrations/removeExtraHierarchyFields.js --apply                  (write)
 *   node migrations/removeExtraHierarchyFields.js --companyId=<id> --apply (write, one company)
 */

const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const LEVELS = [
  { collection: 'divisions', label: 'division', removeFields: ['address.faxNumber', 'divisionManager'] },
  {
    collection: 'branches',
    label: 'branch',
    removeFields: [
      'branchLogo',
      'address.faxNumber',
      'websiteURL',
      'primaryContact',
      'transactionNumberSeries',
      'defaultTransactionNumberSeries',
    ],
  },
  {
    collection: 'warehouses',
    label: 'warehouse',
    removeFields: ['warehouseSize', 'rent', 'permissions', 'zoneName', 'binRack', 'totalCbm'],
  },
];

function parseArgs(argv) {
  const companyHit = argv.find(a => a.startsWith('--companyId='));
  const companyArg = companyHit === undefined ? undefined : companyHit.slice('--companyId='.length);
  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return {
    companyId: companyArg ? new ObjectId(companyArg) : null,
    apply: argv.includes('--apply'),
  };
}

function getPath(doc, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.some(hasValue);
  if (typeof v === 'boolean') return v === true;
  if (typeof v === 'number') return !Number.isNaN(v);
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'object') return Object.values(v).some(hasValue);
  return Boolean(v);
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

async function run() {
  const { companyId: onlyCompanyId, apply } = parseArgs(process.argv.slice(2));
  const { client, booksCrm } = await getConnection();

  try {
    printSection('removeExtraHierarchyFields', '═');
    console.log(`\nScope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

    const scope = onlyCompanyId ? { companyId: onlyCompanyId } : {};

    for (const level of LEVELS) {
      const collection = booksCrm.collection(level.collection);
      const docs = await collection.find(scope).toArray();

      const affected = [];
      for (const doc of docs) {
        const removedValues = {};
        for (const field of level.removeFields) {
          const value = getPath(doc, field);
          if (hasValue(value)) removedValues[field] = value;
        }
        if (Object.keys(removedValues).length > 0) {
          affected.push({ _id: doc._id.toString(), name: doc.name || '(unnamed)', removedValues });
        }
      }

      console.log(
        `\n[${level.label}] ${docs.length} record(s) scanned, ${affected.length} with real data in fields to be removed:`,
      );
      affected.forEach(e => console.log(`  - ${e._id} "${e.name}" -> ${Object.keys(e.removedValues).join(', ')}`));

      if (apply) {
        const unsetDoc = Object.fromEntries(level.removeFields.map(f => [f, '']));
        const result = await collection.updateMany(scope, { $unset: unsetDoc });
        console.log(`  ✅ Unset [${level.removeFields.join(', ')}] on ${result.modifiedCount} document(s).`);
      }
    }

    if (!apply) {
      console.log('\nDry-run only — nothing was written. Re-run with --apply to write changes.\n');
    }
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
