/**
 * Find documents with negative monetary fields, grouped by company.
 *
 * Collections:
 *   - invoices, bills (books): negative `balanceAmount`
 *   - paymentmades (books): negative `unusedAmount`
 *   - paymentreceiveds (booksCrm): negative `unusedAmount`
 *
 * Output:
 *   1. Per-company table listing every offending document.
 *   2. A final summary table with counts and negative totals per field type.
 *
 * Usage:
 *   node scripts/find-negative-balance-docs.js [--companyId=xxx]
 *
 * Requires NODE_ENV + .env (ABSS_CLUSTER, db names).
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  for (const a of args) {
    if (a.startsWith('--companyId=')) companyId = a.split('=')[1].trim();
  }
  return { companyId };
}

function toObjectIdMaybe(id) {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

function round(v) {
  if (v == null) return 0;
  return Math.round(Number(v) * 100) / 100;
}

function buildCompanyMatch(companyId, field, lt = 0) {
  const match = { [field]: { $lt: lt } };
  if (companyId) match.companyId = toObjectIdMaybe(companyId);
  return match;
}

async function run() {
  const { companyId } = parseArgs();
  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const booksDb = db.books;
    const booksCrmDb = db.booksCrm;
    const commonDb = db.common;

    const balanceMatch = buildCompanyMatch(companyId, 'balanceAmount');
    const unusedMatch = buildCompanyMatch(companyId, 'unusedAmount');

    const [invoices, bills, paymentMade, paymentReceived] = await Promise.all([
      booksDb
        .collection('invoices')
        .find(balanceMatch)
        .project({ _id: 1, invoiceId: 1, companyId: 1, balanceAmount: 1, total: 1, paidAmount: 1, status: 1 })
        .toArray(),
      booksDb
        .collection('bills')
        .find(balanceMatch)
        .project({ _id: 1, billId: 1, companyId: 1, balanceAmount: 1, total: 1, paidAmount: 1, status: 1 })
        .toArray(),
      booksDb
        .collection('paymentmades')
        .find(unusedMatch)
        .project({
          _id: 1,
          paymentMadeId: 1,
          companyId: 1,
          unusedAmount: 1,
          paymentMade: 1,
          status: 1,
        })
        .toArray(),
      booksCrmDb
        .collection('paymentreceiveds')
        .find(unusedMatch)
        .project({
          _id: 1,
          paymentReceivedId: 1,
          companyId: 1,
          unusedAmount: 1,
          amountReceived: 1,
          status: 1,
        })
        .toArray(),
    ]);

    const companyIds = new Set();
    const trackCompany = doc => doc.companyId && companyIds.add(doc.companyId.toString());
    invoices.forEach(trackCompany);
    bills.forEach(trackCompany);
    paymentMade.forEach(trackCompany);
    paymentReceived.forEach(trackCompany);

    const companyMap = new Map();
    if (companyIds.size > 0) {
      const companies = await commonDb
        .collection('companies')
        .find({ _id: { $in: [...companyIds].map(id => new mongoose.Types.ObjectId(id)) } })
        .project({ _id: 1, name: 1 })
        .toArray();
      for (const co of companies) companyMap.set(co._id.toString(), co.name || '(unnamed)');
    }

    const grouped = new Map(); // companyId -> { name, rows: [] }

    const ensureEntry = cid => {
      let entry = grouped.get(cid);
      if (!entry) {
        entry = { name: companyMap.get(cid) || '(unknown)', rows: [] };
        grouped.set(cid, entry);
      }
      return entry;
    };

    const addBalanceRow = (doc, type, docIdField) => {
      const cid = doc.companyId ? doc.companyId.toString() : 'NO_COMPANY';
      ensureEntry(cid).rows.push({
        Type: type,
        DocId: doc[docIdField] || '-',
        _id: doc._id.toString(),
        balanceAmount: round(doc.balanceAmount),
        total: round(doc.total),
        paidAmount: round(doc.paidAmount),
        unusedAmount: '-',
        paymentAmount: '-',
        status: doc.status || '-',
      });
    };

    const addUnusedRow = (doc, type, docIdField, amountField) => {
      const cid = doc.companyId ? doc.companyId.toString() : 'NO_COMPANY';
      ensureEntry(cid).rows.push({
        Type: type,
        DocId: doc[docIdField] || '-',
        _id: doc._id.toString(),
        balanceAmount: '-',
        total: '-',
        paidAmount: '-',
        unusedAmount: round(doc.unusedAmount),
        paymentAmount: round(doc[amountField]),
        status: doc.status || '-',
      });
    };

    invoices.forEach(i => addBalanceRow(i, 'Invoice', 'invoiceId'));
    bills.forEach(b => addBalanceRow(b, 'Bill', 'billId'));
    paymentMade.forEach(p => addUnusedRow(p, 'PaymentMade', 'paymentMadeId', 'paymentMade'));
    paymentReceived.forEach(p => addUnusedRow(p, 'PaymentReceived', 'paymentReceivedId', 'amountReceived'));

    const totalDocs = invoices.length + bills.length + paymentMade.length + paymentReceived.length;

    console.log('\n=== Documents with negative balanceAmount or unusedAmount ===');
    console.log(`Total invoices:         ${invoices.length}`);
    console.log(`Total bills:            ${bills.length}`);
    console.log(`Total payment made:     ${paymentMade.length}`);
    console.log(`Total payment received: ${paymentReceived.length}`);
    console.log(`Companies:              ${grouped.size}\n`);

    if (totalDocs === 0) {
      console.log('No documents found with negative balanceAmount or unusedAmount.');
      return;
    }

    const summary = [];
    const sortedCompanies = [...grouped.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

    for (const [cid, g] of sortedCompanies) {
      const invCount = g.rows.filter(r => r.Type === 'Invoice').length;
      const billCount = g.rows.filter(r => r.Type === 'Bill').length;
      const pmCount = g.rows.filter(r => r.Type === 'PaymentMade').length;
      const prCount = g.rows.filter(r => r.Type === 'PaymentReceived').length;
      const totalNegativeBalance = round(g.rows.reduce((s, r) => (r.balanceAmount === '-' ? s : s + r.balanceAmount), 0));
      const totalNegativeUnused = round(g.rows.reduce((s, r) => (r.unusedAmount === '-' ? s : s + r.unusedAmount), 0));

      console.log(`\n--- Company: ${g.name}  (${cid}) ---`);
      console.log(`Invoices: ${invCount}  |  Bills: ${billCount}  |  PaymentMade: ${pmCount}  |  PaymentReceived: ${prCount}`);
      console.log(
        `Total negative balanceAmount: ${totalNegativeBalance}  |  Total negative unusedAmount: ${totalNegativeUnused}`,
      );
      console.table(g.rows);

      summary.push({
        Company: g.name,
        CompanyId: cid,
        Invoices: invCount,
        Bills: billCount,
        PaymentMade: pmCount,
        PaymentReceived: prCount,
        TotalNegativeBalance: totalNegativeBalance,
        TotalNegativeUnused: totalNegativeUnused,
      });
    }

    console.log('\n=== Summary by company ===');
    console.table(summary);
  } catch (err) {
    console.error('Error:', err);
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
  }
}

run();
