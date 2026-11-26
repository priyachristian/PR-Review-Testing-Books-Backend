/**
 * Report how many sales and purchase documents each company has created.
 *
 * Why:
 * - Helps identify companies that are onboarded but never actually used the
 *   product (zero or near-zero sales/purchase documents), vs. active companies.
 *
 * Collections checked (same set used by migrations/verifyDocumentTotalsLegacyFe.js
 * and scripts/migrate-transaction-currency-default.js):
 * - Sales:    quotes, salesorders, invoices, deliverychallans, creditnotes, recurringinvoices
 * - Purchase: purchaseorders, grpoorders, bills, debitnotes, recurringbills
 *
 * Usage:
 *   node migrations/checkCompanyDocumentUsage.js
 *   node migrations/checkCompanyDocumentUsage.js --threshold=5
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const fs = require('fs');
const path = require('path');
const { getConnection } = require('../config/db');

const SALES_COLLECTIONS = [
  { db: 'booksCrm', name: 'quotes' },
  { db: 'booksCrm', name: 'salesorders' },
  { db: 'books', name: 'invoices' },
  { db: 'books', name: 'deliverychallans' },
  { db: 'books', name: 'creditnotes' },
  { db: 'books', name: 'recurringinvoices' },
];

const PURCHASE_COLLECTIONS = [
  { db: 'books', name: 'purchaseorders' },
  { db: 'books', name: 'grpoorders' },
  { db: 'books', name: 'bills' },
  { db: 'books', name: 'debitnotes' },
  { db: 'books', name: 'recurringbills' },
];

function parseArgs() {
  const out = { threshold: 0 };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--threshold=')) out.threshold = Number(arg.split('=')[1].trim());
  }
  if (!Number.isFinite(out.threshold) || out.threshold < 0) out.threshold = 0;
  return out;
}

/** Runs a companyId group-count aggregation on one collection and merges the result into `countsByCompany`. */
async function accumulateCounts(dbHandles, { db, name }, countsByCompany, bucketKey) {
  const collection = dbHandles[db].collection(name);
  const results = await collection.aggregate([{ $group: { _id: '$companyId', count: { $sum: 1 } } }]).toArray();

  for (const row of results) {
    if (!row._id) continue;
    const companyId = String(row._id);
    const entry = countsByCompany.get(companyId) || { sales: 0, purchase: 0, byCollection: {} };
    entry[bucketKey] += row.count;
    entry.byCollection[name] = row.count;
    countsByCompany.set(companyId, entry);
  }
}

async function checkCompanyDocumentUsage() {
  const { threshold } = parseArgs();
  const connection = await getConnection();
  const { client } = connection;
  const dbHandles = { booksCrm: connection.booksCrm, books: connection.books };

  try {
    const companies = await connection.common
      .collection('companies')
      .find({}, { projection: { name: 1 } })
      .toArray();

    console.log(`Found ${companies.length} companies. Counting sales and purchase documents...\n`);

    const countsByCompany = new Map();

    for (const target of SALES_COLLECTIONS) {
      await accumulateCounts(dbHandles, target, countsByCompany, 'sales');
    }
    for (const target of PURCHASE_COLLECTIONS) {
      await accumulateCounts(dbHandles, target, countsByCompany, 'purchase');
    }

    const report = companies
      .map(company => {
        const companyId = String(company._id);
        const entry = countsByCompany.get(companyId) || { sales: 0, purchase: 0, byCollection: {} };
        return {
          companyId,
          companyName: company.name || '',
          salesDocs: entry.sales,
          purchaseDocs: entry.purchase,
          totalDocs: entry.sales + entry.purchase,
          byCollection: entry.byCollection,
        };
      })
      .sort((a, b) => a.totalDocs - b.totalDocs);

    const unusedCompanies = report.filter(row => row.totalDocs <= threshold);

    console.log(`Company-wise sales/purchase document counts (lowest first):`);
    console.table(
      report.map(({ companyId, companyName, salesDocs, purchaseDocs, totalDocs }) => ({
        companyId,
        companyName,
        salesDocs,
        purchaseDocs,
        totalDocs,
      })),
    );

    console.log(`\nCompanies with <= ${threshold} total sales+purchase docs (likely not in use): ${unusedCompanies.length}`);
    if (unusedCompanies.length > 0) {
      console.table(
        unusedCompanies.map(({ companyId, companyName, salesDocs, purchaseDocs, totalDocs }) => ({
          companyId,
          companyName,
          salesDocs,
          purchaseDocs,
          totalDocs,
        })),
      );
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(__dirname, `company-document-usage-${timestamp}.json`);
    fs.writeFileSync(
      outputFile,
      JSON.stringify(
        {
          summary: {
            totalCompanies: report.length,
            threshold,
            unusedCompanyCount: unusedCompanies.length,
          },
          companies: report,
        },
        null,
        2,
      ),
    );
    console.log(`\nFull report saved to: ${outputFile}`);
  } catch (error) {
    console.error('Error checking company document usage:', error);
  } finally {
    await client.close();
  }
}

checkCompanyDocumentUsage();
