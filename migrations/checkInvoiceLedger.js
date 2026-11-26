/**
 * Audit: Show the ledger entries posted for one invoice and check they balance.
 *
 * Prints every ledger row written against the invoice with its account name, debit/credit
 * and status, then compares total debit to total credit. A journal that does not balance
 * means the posting for that invoice is wrong.
 *
 * This script is READ-ONLY — it does not modify any data.
 *
 * Usage:
 *   node migrations/checkInvoiceLedger.js <invoiceId>
 */

const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

async function run(invoiceId) {
  const { client, books } = await getConnection();

  try {
    const rows = await books
      .collection('ledgerentries')
      .aggregate([
        { $match: { sourceModule: 'INVOICE', sourceId: new ObjectId(invoiceId) } },
        { $lookup: { from: 'accounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
        { $unwind: '$account' },
        {
          $project: {
            _id: 0,
            journalId: 1,
            account: '$account.accountName',
            debit: 1,
            credit: 1,
            status: 1,
            postingDate: 1,
            narration: 1,
          },
        },
        { $sort: { journalId: 1, debit: -1 } },
      ])
      .toArray();

    if (!rows.length) {
      console.log('No ledger rows for this invoice.');
      return;
    }

    console.table(rows.map(row => ({ ...row, postingDate: row.postingDate?.toISOString().slice(0, 10) })));

    const totalDebit = rows.reduce((sum, row) => sum + (row.debit || 0), 0);
    const totalCredit = rows.reduce((sum, row) => sum + (row.credit || 0), 0);
    console.log(
      `Σ Debit = ${totalDebit.toFixed(2)}   Σ Credit = ${totalCredit.toFixed(2)}   ` +
        `${Math.abs(totalDebit - totalCredit) < 0.005 ? '✅ BALANCED' : '❌ NOT BALANCED'}`,
    );
  } catch (err) {
    console.error('❌ Audit failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

// ─── entry point ────────────────────────────────────────────────────────────

const invoiceId = process.argv[2];

if (!ObjectId.isValid(invoiceId)) {
  console.error('Usage: node migrations/checkInvoiceLedger.js <invoiceId>');
  process.exit(1);
}

run(invoiceId).catch(() => process.exit(1));
