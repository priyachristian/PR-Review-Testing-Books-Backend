/**
 * Report: divisions / branches / warehouses that share the same name within a company.
 *
 * Names are only unique-ish by convention, not by a schema constraint — a branch is scoped
 * under a division (divisionId), so nothing stops two different divisions in the same company
 * from each having a branch named "B1". Same story for warehouses (scoped by division + branch)
 * and, at the top, for divisions themselves (scoped only by companyId). This script fetches,
 * company-wise, every division/branch/warehouse name that is reused more than once within that
 * company, and reports it — including companyName (and, where relevant, divisionName/branchName)
 * on every row so the output is readable without cross-referencing ids by hand.
 *
 * "Same name, different parent" (e.g. Div1 -> Branch B1 and Div2 -> Branch B1) is reported like
 * any other duplicate — this script does not judge whether that's expected or a data problem,
 * it just surfaces where it happens.
 *
 * This script is READ-ONLY — it does not modify any data.
 *
 * Usage:
 *   node migrations/reportDuplicateHierarchyNames.js                    # all companies
 *   node migrations/reportDuplicateHierarchyNames.js --companyId=<id>   # one company
 *   node migrations/reportDuplicateHierarchyNames.js --export           # also write JSON + txt to migrations/outputs
 */

const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

function parseArgs(argv) {
  const hit = argv.find(a => a.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return {
    companyId: companyArg ? new ObjectId(companyArg) : null,
    shouldExport: argv.includes('--export'),
  };
}

const normalizeName = name => (name ?? '').toString().trim().toLowerCase();

/**
 * Groups `rows` by `row[nameField]` (normalized) and keeps only groups with more than one row.
 * Returns [{ name, count, rows }].
 */
function findDuplicateNameGroups(rows, nameField) {
  const byName = new Map();
  for (const row of rows) {
    const key = normalizeName(row[nameField]);
    if (!key) continue; // unnamed rows aren't meaningfully "duplicate"
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }
  return [...byName.values()]
    .filter(group => group.length > 1)
    .map(group => ({ name: group[0][nameField], count: group.length, rows: group }));
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

async function run() {
  const { companyId: onlyCompanyId, shouldExport } = parseArgs(process.argv);
  const { client, common, booksCrm } = await getConnection();

  try {
    printSection('reportDuplicateHierarchyNames', '═');
    console.log(`\nScope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}   (read-only)`);

    const companyFilter = onlyCompanyId ? { _id: onlyCompanyId } : {};
    const companies = await common.collection('companies').find(companyFilter).project({ name: 1 }).toArray();
    if (!companies.length) {
      console.log('\nNo matching companies found.\n');
      return;
    }
    const companyIds = companies.map(c => c._id);
    const companyNameById = new Map(companies.map(c => [c._id.toString(), c.name || '(unnamed company)']));

    const scope = { companyId: { $in: companyIds } };
    const [divisions, branches, warehouses] = await Promise.all([
      booksCrm.collection('divisions').find(scope).project({ name: 1, companyId: 1 }).toArray(),
      booksCrm.collection('branches').find(scope).project({ name: 1, companyId: 1, divisionId: 1 }).toArray(),
      booksCrm.collection('warehouses').find(scope).project({ name: 1, companyId: 1, divisionId: 1, branchId: 1 }).toArray(),
    ]);

    const divisionNameById = new Map(divisions.map(d => [d._id.toString(), d.name || '(unnamed division)']));
    const branchNameById = new Map(branches.map(b => [b._id.toString(), b.name || '(unnamed branch)']));

    const byCompany = key => key.toString();
    const groupByCompany = rows => {
      const map = new Map();
      for (const row of rows) {
        const key = byCompany(row.companyId);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
      }
      return map;
    };
    const divisionsByCompany = groupByCompany(divisions);
    const branchesByCompany = groupByCompany(branches);
    const warehousesByCompany = groupByCompany(warehouses);

    const consoleRows = [];
    const exportCompanies = [];
    const stats = { companiesWithDuplicates: 0, duplicateDivisionNames: 0, duplicateBranchNames: 0, duplicateWarehouseNames: 0 };

    for (const company of companies) {
      const companyKey = company._id.toString();
      const companyName = companyNameById.get(companyKey);

      const divisionDuplicates = findDuplicateNameGroups(divisionsByCompany.get(companyKey) || [], 'name');
      const branchDuplicates = findDuplicateNameGroups(branchesByCompany.get(companyKey) || [], 'name');
      const warehouseDuplicates = findDuplicateNameGroups(warehousesByCompany.get(companyKey) || [], 'name');

      if (!divisionDuplicates.length && !branchDuplicates.length && !warehouseDuplicates.length) continue;

      stats.companiesWithDuplicates += 1;
      stats.duplicateDivisionNames += divisionDuplicates.length;
      stats.duplicateBranchNames += branchDuplicates.length;
      stats.duplicateWarehouseNames += warehouseDuplicates.length;

      for (const group of divisionDuplicates) {
        consoleRows.push({
          companyName,
          companyId: companyKey,
          level: 'division',
          name: group.name,
          count: group.count,
          parent: '—',
          ids: group.rows.map(r => r._id.toString()).join(', '),
        });
      }
      for (const group of branchDuplicates) {
        consoleRows.push({
          companyName,
          companyId: companyKey,
          level: 'branch',
          name: group.name,
          count: group.count,
          parent: group.rows.map(r => divisionNameById.get(r.divisionId?.toString()) || '(no division)').join(' | '),
          ids: group.rows.map(r => r._id.toString()).join(', '),
        });
      }
      for (const group of warehouseDuplicates) {
        consoleRows.push({
          companyName,
          companyId: companyKey,
          level: 'warehouse',
          name: group.name,
          count: group.count,
          parent: group.rows
            .map(r => {
              const divisionName = divisionNameById.get(r.divisionId?.toString()) || '(no division)';
              const branchName = branchNameById.get(r.branchId?.toString()) || '(no branch)';
              return `${divisionName} / ${branchName}`;
            })
            .join(' | '),
          ids: group.rows.map(r => r._id.toString()).join(', '),
        });
      }

      exportCompanies.push({
        companyId: companyKey,
        companyName,
        divisions: divisionDuplicates.map(g => ({
          name: g.name,
          count: g.count,
          divisionIds: g.rows.map(r => r._id.toString()),
        })),
        branches: branchDuplicates.map(g => ({
          name: g.name,
          count: g.count,
          entries: g.rows.map(r => ({
            branchId: r._id.toString(),
            divisionId: r.divisionId?.toString() ?? null,
            divisionName: divisionNameById.get(r.divisionId?.toString()) || null,
          })),
        })),
        warehouses: warehouseDuplicates.map(g => ({
          name: g.name,
          count: g.count,
          entries: g.rows.map(r => ({
            warehouseId: r._id.toString(),
            divisionId: r.divisionId?.toString() ?? null,
            divisionName: divisionNameById.get(r.divisionId?.toString()) || null,
            branchId: r.branchId?.toString() ?? null,
            branchName: branchNameById.get(r.branchId?.toString()) || null,
          })),
        })),
      });
    }

    if (!consoleRows.length) {
      console.log('\n✅ No duplicate division/branch/warehouse names found in this scope.\n');
      return;
    }

    printSection('Duplicate names by company');
    console.table(consoleRows);

    printSection('Summary', '─');
    console.table([
      { Metric: 'Companies scanned', Value: companies.length },
      { Metric: 'Companies with at least one duplicate name', Value: stats.companiesWithDuplicates },
      { Metric: 'Duplicate division names', Value: stats.duplicateDivisionNames },
      { Metric: 'Duplicate branch names (across divisions)', Value: stats.duplicateBranchNames },
      { Metric: 'Duplicate warehouse names (across divisions/branches)', Value: stats.duplicateWarehouseNames },
    ]);

    console.log('\n⚠  This is a READ-ONLY report — nothing was modified.\n');

    if (shouldExport) {
      const outputDir = path.join(__dirname, 'outputs');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const jsonFile = path.join(outputDir, `duplicate-hierarchy-names-${timestamp}.json`);
      const txtFile = path.join(outputDir, `duplicate-hierarchy-names-${timestamp}.txt`);

      fs.writeFileSync(
        jsonFile,
        JSON.stringify({ generatedAt: new Date().toISOString(), summary: stats, companies: exportCompanies }, null, 2),
      );

      const lines = [`=== Duplicate Division/Branch/Warehouse Names Report ===`, `Generated at: ${new Date().toISOString()}`, ''];
      for (const company of exportCompanies) {
        lines.push(`Company: ${company.companyName} [${company.companyId}]`);
        for (const group of company.divisions) {
          lines.push(`  DIVISION "${group.name}" appears ${group.count}x -> ${group.divisionIds.join(', ')}`);
        }
        for (const group of company.branches) {
          lines.push(`  BRANCH "${group.name}" appears ${group.count}x:`);
          group.entries.forEach(e => lines.push(`    - branchId ${e.branchId} (division: ${e.divisionName || e.divisionId})`));
        }
        for (const group of company.warehouses) {
          lines.push(`  WAREHOUSE "${group.name}" appears ${group.count}x:`);
          group.entries.forEach(e =>
            lines.push(
              `    - warehouseId ${e.warehouseId} (division: ${e.divisionName || e.divisionId}, branch: ${e.branchName || e.branchId})`,
            ),
          );
        }
        lines.push('');
      }
      fs.writeFileSync(txtFile, lines.join('\n'));

      console.log(`📄 Full detail exported to:\n   ${jsonFile}\n   ${txtFile}\n`);
    }
  } catch (err) {
    console.error('❌ Report failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

run().catch(() => process.exit(1));
