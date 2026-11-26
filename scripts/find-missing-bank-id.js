/**
 * Find documents with a missing `bankId` across the major books / books-crm collections,
 * grouped by company.
 *
 * "Missing" = field absent | null | invalid (empty string / non-ObjectId).
 *
 * Collections checked:
 *   booksCrm.quotes            (Quote)            id field: quoteId
 *   booksCrm.salesorders       (SalesOrder)       id field: salesOrderId
 *   books.deliverychallans     (DeliveryChallan)  id field: challanId
 *   books.invoices             (Invoice)          id field: invoiceId
 *   books.creditnotes          (CreditNote)       id field: creditNoteId
 *   books.purchaseorders       (PurchaseOrder)    id field: purchaseOrderId
 *   books.grpoorders           (GRPO)             id field: grpoOrderId
 *   books.bills                (Bill)             id field: billId
 *   books.debitnotes           (DebitNote)        id field: debitNoteId
 *
 * Output:
 *   1. Per-company table listing every offending document
 *      (Type, DocumentId, _id, status, createdAt).
 *   2. A final summary table: company | <perTypeCounts...> | total.
 *
 * Usage:
 *   node scripts/find-missing-bank-id.js
 *
 * Requires NODE_ENV + .env (ABSS_CLUSTER, db names).
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');

function fmt(v) {
  if (v === null || v === undefined) return '-';
  return String(v);
}

/**
 * Pretty-print an array of plain objects as an aligned table with box-drawing chars.
 *   columns: [{ key, label, align?: 'left'|'right', max?: number }]
 */
function printTable(rows, columns) {
  if (!rows || rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  const widths = columns.map(c => {
    let w = c.label.length;
    for (const r of rows) {
      const s = fmt(r[c.key]);
      if (s.length > w) w = s.length;
    }
    if (c.max && w > c.max) w = c.max;
    return w;
  });

  const pad = (s, w, align) => {
    let str = s.length > w ? s.slice(0, w - 1) + '…' : s;
    const space = w - str.length;
    if (align === 'right') return ' '.repeat(space) + str;
    return str + ' '.repeat(space);
  };

  const top = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

  const renderRow = vals => '│ ' + vals.map((v, i) => pad(v, widths[i], columns[i].align || 'left')).join(' │ ') + ' │';

  console.log(top);
  console.log(renderRow(columns.map(c => c.label)));
  console.log(mid);
  for (const r of rows) {
    console.log(renderRow(columns.map(c => fmt(r[c.key]))));
  }
  console.log(bot);
}

// dbKey is a key on the object returned by getConnection()
const TARGETS = [
  { dbKey: 'booksCrm', collection: 'quotes', type: 'Quote', idField: 'quoteId' },
  { dbKey: 'booksCrm', collection: 'salesorders', type: 'SalesOrder', idField: 'salesOrderId' },
  { dbKey: 'books', collection: 'deliverychallans', type: 'DeliveryChallan', idField: 'challanId' },
  { dbKey: 'books', collection: 'invoices', type: 'Invoice', idField: 'invoiceId' },
  { dbKey: 'books', collection: 'creditnotes', type: 'CreditNote', idField: 'creditNoteId' },
  { dbKey: 'books', collection: 'purchaseorders', type: 'PurchaseOrder', idField: 'purchaseOrderId' },
  { dbKey: 'books', collection: 'grpoorders', type: 'GRPO', idField: 'grpoOrderId' },
  { dbKey: 'books', collection: 'bills', type: 'Bill', idField: 'billId' },
  { dbKey: 'books', collection: 'debitnotes', type: 'DebitNote', idField: 'debitNoteId' },
];

async function run() {
  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const commonDb = db.common;

    const fetched = await Promise.all(
      TARGETS.map(async t => {
        const dbConn = db[t.dbKey];
        if (!dbConn) {
          console.warn(`Skipping ${t.collection}: db connection "${t.dbKey}" not available`);
          return { target: t, docs: [] };
        }
        // bankId is missing | null | empty
        const match = {
          $or: [{ bankId: { $exists: false } }, { bankId: null }, { bankId: '' }],
        };

        const docs = await dbConn
          .collection(t.collection)
          .find(match)
          .project({
            _id: 1,
            companyId: 1,
            status: 1,
            createdAt: 1,
            bankId: 1,
            [t.idField]: 1,
          })
          .toArray();
        return { target: t, docs };
      }),
    );

    // Collect all involved companies
    const companyIds = new Set();
    for (const { docs } of fetched) {
      for (const d of docs) {
        if (d.companyId) companyIds.add(d.companyId.toString());
      }
    }

    const companyMap = new Map();
    if (companyIds.size > 0) {
      const companies = await commonDb
        .collection('companies')
        .find({ _id: { $in: [...companyIds].map(id => new mongoose.Types.ObjectId(id)) } })
        .project({ _id: 1, name: 1 })
        .toArray();
      for (const co of companies) companyMap.set(co._id.toString(), co.name || '(unnamed)');
    }

    // Group rows by company
    const grouped = new Map(); // companyId -> { name, rows: [] }
    let totalCount = 0;
    const perTypeTotals = {}; // type -> count

    for (const { target, docs } of fetched) {
      perTypeTotals[target.type] = docs.length;
      totalCount += docs.length;
      for (const d of docs) {
        const cid = d.companyId ? d.companyId.toString() : 'NO_COMPANY';
        let entry = grouped.get(cid);
        if (!entry) {
          entry = { name: companyMap.get(cid) || '(unknown)', rows: [] };
          grouped.set(cid, entry);
        }
        entry.rows.push({
          Type: target.type,
          DocumentId: d[target.idField] || '-',
          _id: d._id.toString(),
          status: d.status || '-',
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '-',
        });
      }
    }

    console.log('\n=== Documents with missing `bankId` ===\n');
    console.log('Per-type totals:');
    printTable(
      TARGETS.map(t => ({
        Type: t.type,
        Collection: `${t.dbKey}.${t.collection}`,
        Missing: perTypeTotals[t.type] || 0,
      })),
      [
        { key: 'Type', label: 'Type' },
        { key: 'Collection', label: 'Collection' },
        { key: 'Missing', label: 'Missing', align: 'right' },
      ],
    );
    console.log(`\nGrand total missing : ${totalCount}`);
    console.log(`Companies affected  : ${grouped.size}\n`);

    if (totalCount === 0) {
      console.log('No documents found with missing bankId.');
      return;
    }

    const summary = [];
    const sortedCompanies = [...grouped.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

    const detailColumns = [
      { key: 'Type', label: 'Type', max: 16 },
      { key: 'DocumentId', label: 'DocumentId', max: 24 },
      { key: '_id', label: '_id (document_id)', max: 26 },
      { key: 'status', label: 'Status', max: 16 },
      { key: 'createdAt', label: 'CreatedAt', max: 24 },
    ];

    for (const [cid, g] of sortedCompanies) {
      const counts = {};
      for (const t of TARGETS) counts[t.type] = 0;
      for (const r of g.rows) counts[r.Type] = (counts[r.Type] || 0) + 1;

      const breakdown = TARGETS.map(t => `${t.type}: ${counts[t.type] || 0}`)
        .filter(s => !s.endsWith(': 0'))
        .join('  |  ');

      console.log(`\n──────────────────────────────────────────────────────────────────`);
      console.log(`Company : ${g.name}`);
      console.log(`Id      : ${cid}`);
      console.log(`Total   : ${g.rows.length}   ${breakdown ? '(' + breakdown + ')' : ''}`);
      console.log(`──────────────────────────────────────────────────────────────────`);
      printTable(g.rows, detailColumns);

      summary.push({
        Company: g.name,
        CompanyId: cid,
        ...counts,
        Total: g.rows.length,
      });
    }

    console.log('\n=== Summary by company ===');
    const summaryColumns = [
      { key: 'Company', label: 'Company', max: 32 },
      { key: 'CompanyId', label: 'CompanyId', max: 26 },
      ...TARGETS.map(t => ({ key: t.type, label: t.type, align: 'right' })),
      { key: 'Total', label: 'Total', align: 'right' },
    ];
    printTable(summary, summaryColumns);
  } catch (err) {
    console.error('Error:', err);
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
  }
}

run();
