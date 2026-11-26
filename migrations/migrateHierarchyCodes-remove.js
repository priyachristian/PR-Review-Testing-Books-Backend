/**
 * Migrate branch/warehouse codes to the new division-prefixed hierarchical format.
 *
 * Old format:
 *   - divisions:  divisionCode is already in the target format (e.g. "DIV-1") — untouched,
 *                 only read to build the lookup used for branches.
 *   - branches:   branchCode like "BR1", unrelated to its division (e.g. "BR1", "BR2", ...)
 *   - warehouses: warehouseId a plain number/number-string (e.g. "1"), unrelated to its branch
 *
 * New format:
 *   - branches:   "<divisionCode>-BR-<n>"      e.g. "DIV-1-BR-1"
 *   - warehouses: "<new branchCode>-WH-<n>"    e.g. "DIV-1-BR-1-WH-1"
 *
 * The trailing number is reused as-is from the existing branchCode/warehouseId — this migration
 * only reformats codes, it does not renumber anything. Warehouses are re-coded using each branch's
 * *new* branchCode, so branches must be processed first (this script does both in one pass).
 *
 * SAFETY:
 *   - Dry-run by default — prints what would change, writes nothing.
 *   - Records already in the new format are skipped (safe to re-run / re-apply).
 *   - Records whose code has no trailing number, or whose parent has no code yet, are skipped
 *     and reported instead of guessed at.
 *   - A branch update that would violate the {divisionId, branchCode} unique index (two branches
 *     in the same division resolving to the same new code) is reported as a conflict and skipped.
 *
 * Usage:
 *   node migrations/migrateHierarchyCodes-remove.js                          (dry-run, all companies)
 *   node migrations/migrateHierarchyCodes-remove.js --companyId=<id>         (dry-run, one company)
 *   node migrations/migrateHierarchyCodes-remove.js --apply                  (write, all companies)
 *   node migrations/migrateHierarchyCodes-remove.js --companyId=<id> --apply (write, one company)
 */

const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

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

function extractTrailingNumber(value) {
  if (value === undefined || value === null) return null;
  const match = value.toString().match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    printSection('migrateHierarchyCodes', '═');
    console.log(`\nScope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

    const scope = onlyCompanyId ? { companyId: onlyCompanyId } : {};

    const divisionsCol = booksCrm.collection('divisions');
    const branchesCol = booksCrm.collection('branches');
    const warehousesCol = booksCrm.collection('warehouses');

    // 1) Divisions are already in the target format — only build the id -> divisionCode lookup.
    const divisions = await divisionsCol.find(scope).project({ divisionCode: 1, name: 1 }).toArray();
    const divisionCodeById = new Map(divisions.map(d => [d._id.toString(), d.divisionCode]));

    const missingDivisionCode = divisions.filter(d => !d.divisionCode);
    if (missingDivisionCode.length) {
      printSection('⚠ Divisions missing divisionCode (dependent branches will be skipped)');
      missingDivisionCode.forEach(d => console.log(`  - ${d._id} "${d.name || '(unnamed)'}"`));
    }

    // 2) Branches: "<divisionCode>-BR-<n>"
    printSection('Branches');
    const branches = await branchesCol.find(scope).project({ branchCode: 1, name: 1, divisionId: 1 }).toArray();

    const newBranchCodeById = new Map(); // branchId -> new branchCode, used to migrate warehouses below
    const stats = {
      branchUpdated: 0,
      branchAlready: 0,
      branchSkipped: 0,
      branchConflict: 0,
      warehouseUpdated: 0,
      warehouseAlready: 0,
      warehouseSkipped: 0,
    };

    for (const branch of branches) {
      const divisionCode = branch.divisionId ? divisionCodeById.get(branch.divisionId.toString()) : null;
      if (!divisionCode) {
        console.log(
          `  ⏭  SKIP ${branch._id} "${branch.name || '(unnamed)'}" — no divisionCode for division ${branch.divisionId}`,
        );
        stats.branchSkipped += 1;
        continue;
      }

      const alreadyMigrated = new RegExp(`^${escapeRegex(divisionCode)}-BR-\\d+$`).test(branch.branchCode || '');
      if (alreadyMigrated) {
        newBranchCodeById.set(branch._id.toString(), branch.branchCode);
        stats.branchAlready += 1;
        continue;
      }

      const number = extractTrailingNumber(branch.branchCode);
      if (!number) {
        console.log(`  ⏭  SKIP ${branch._id} "${branch.name || '(unnamed)'}" — unparseable branchCode "${branch.branchCode}"`);
        stats.branchSkipped += 1;
        continue;
      }

      const newBranchCode = `${divisionCode}-BR-${number}`;
      console.log(`  ${branch._id} "${branch.name || '(unnamed)'}": "${branch.branchCode}" -> "${newBranchCode}"`);

      if (apply) {
        try {
          await branchesCol.updateOne({ _id: branch._id }, { $set: { branchCode: newBranchCode } });
        } catch (err) {
          if (err.code === 11000) {
            console.log(
              `  ❌ CONFLICT ${branch._id} — "${newBranchCode}" already exists in division ${branch.divisionId}, skipped`,
            );
            stats.branchConflict += 1;
            continue;
          }
          throw err;
        }
      }

      newBranchCodeById.set(branch._id.toString(), newBranchCode);
      stats.branchUpdated += 1;
    }

    console.log(
      `\n[branches] ${branches.length} scanned, ${stats.branchUpdated} ${apply ? 'updated' : 'to update'}, ` +
        `${stats.branchAlready} already migrated, ${stats.branchSkipped} skipped, ${stats.branchConflict} conflicts.`,
    );

    // 3) Warehouses: "<new branchCode>-WH-<n>"
    printSection('Warehouses');
    const warehouses = await warehousesCol.find(scope).project({ warehouseId: 1, name: 1, branchId: 1 }).toArray();

    for (const warehouse of warehouses) {
      const branchCode = warehouse.branchId ? newBranchCodeById.get(warehouse.branchId.toString()) : null;
      if (!branchCode) {
        console.log(
          `  ⏭  SKIP ${warehouse._id} "${warehouse.name || '(unnamed)'}" — no branchCode for branch ${warehouse.branchId}`,
        );
        stats.warehouseSkipped += 1;
        continue;
      }

      const alreadyMigrated = new RegExp(`^${escapeRegex(branchCode)}-WH-\\d+$`).test((warehouse.warehouseId || '').toString());
      if (alreadyMigrated) {
        stats.warehouseAlready += 1;
        continue;
      }

      const number = extractTrailingNumber(warehouse.warehouseId);
      if (!number) {
        console.log(
          `  ⏭  SKIP ${warehouse._id} "${warehouse.name || '(unnamed)'}" — unparseable warehouseId "${warehouse.warehouseId}"`,
        );
        stats.warehouseSkipped += 1;
        continue;
      }

      const newWarehouseId = `${branchCode}-WH-${number}`;
      console.log(`  ${warehouse._id} "${warehouse.name || '(unnamed)'}": "${warehouse.warehouseId}" -> "${newWarehouseId}"`);

      if (apply) {
        await warehousesCol.updateOne({ _id: warehouse._id }, { $set: { warehouseId: newWarehouseId } });
      }
      stats.warehouseUpdated += 1;
    }

    console.log(
      `\n[warehouses] ${warehouses.length} scanned, ${stats.warehouseUpdated} ${apply ? 'updated' : 'to update'}, ` +
        `${stats.warehouseAlready} already migrated, ${stats.warehouseSkipped} skipped.`,
    );

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
