/**
 * Migration: drop advance-removal journals that were posted more than once.
 *
 * Un-applying an advance posts an opposite journal rather than deleting the one it undoes, and
 * nothing stopped that removal being posted again. On PAYM-00690 one application was reversed
 * twice, another four times and another five times, so Accounts Payable ended up over-credited
 * and Prepaid Expenses over-debited by the same amount while the trial balance still showed
 * Dr = Cr — the two errors cancel each other, which is why no balance check caught it.
 *
 * The payment document says how many reversals a line should have:
 *
 *   line still applied on the payment   →  none, the application stands
 *   line no longer applied              →  exactly as many as it has applications
 *
 * Anything beyond that is a repeat, and the newest ones go first so the oldest reversal — the one
 * that matches the user's actual action — is the one kept. Legitimate apply/remove pairs are left
 * alone: they are the audit trail of a real un-apply.
 *
 * Journals are removed whole, and the resulting movement per account is reported, so the balance
 * change is seen before it is applied rather than found afterwards.
 *
 * Usage:
 *   node migrations/removeSurplusAdvanceReversals-remove.js up                         report only, all companies
 *   node migrations/removeSurplusAdvanceReversals-remove.js up --companyId=<id>        report only, one company
 *   node migrations/removeSurplusAdvanceReversals-remove.js up --apply                 write, all companies
 *   node migrations/removeSurplusAdvanceReversals-remove.js up --companyId=<id> --apply write, one company
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const MODULES = [
  {
    sourceModule: 'PAYMENT_RECEIVED',
    db: 'booksCrm',
    collection: 'paymentreceiveds',
    lineArrays: ['invoices', 'openingBalanceTransactions'],
  },
  { sourceModule: 'PAYMENT_MADE', db: 'books', collection: 'paymentmades', lineArrays: ['bills', 'openingBalanceTransactions'] },
];

const APPLIED = /applied to/i;
const REMOVED = /application removed/i;

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const parseArgs = () => {
  const companyHit = process.argv.find(a => a.startsWith('--companyId='));
  const companyArg = companyHit === undefined ? undefined : companyHit.slice('--companyId='.length);
  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return {
    companyId: companyArg ? new ObjectId(companyArg) : null,
    apply: process.argv.includes('--apply'),
  };
};

module.exports = {
  async up() {
    const { companyId, apply } = parseArgs();
    const connection = await getConnection();
    const { client, books } = connection;
    const ledgerEntries = books.collection('ledgerentries');
    const companyScope = companyId ? { companyId } : {};

    try {
      console.log(`Scope: ${companyId ? companyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

      const movement = new Map();
      let droppedJournals = 0;
      let droppedRows = 0;

      for (const module of MODULES) {
        const rows = await ledgerEntries
          .find({ sourceModule: module.sourceModule, $or: [{ narration: APPLIED }, { narration: REMOVED }], ...companyScope })
          .toArray();
        if (!rows.length) continue;

        // Which lines the payment still applies to.
        const filter = [];
        const projection = { _id: 1 };
        for (const array of module.lineArrays) {
          filter.push({ [`${array}._id`]: { $in: rows.map(row => row.sourceId) } });
          projection[array] = 1;
        }

        const payments = await connection[module.db]
          .collection(module.collection)
          .find({ $or: filter })
          .project(projection)
          .toArray();
        const stillApplied = new Set();
        for (const payment of payments) {
          for (const array of module.lineArrays) {
            for (const line of payment[array] || []) {
              stillApplied.add(String(line._id));
            }
          }
        }

        // Group each line's journals, keeping every row so whole journals can be removed.
        const lines = new Map();
        for (const row of rows) {
          const key = String(row.sourceId);
          if (!lines.has(key)) {
            lines.set(key, { applications: new Set(), reversals: new Map() });
          }
          const line = lines.get(key);
          const journal = String(row.journalId);
          if (REMOVED.test(row.narration)) {
            if (!line.reversals.has(journal)) line.reversals.set(journal, []);
            line.reversals.get(journal).push(row);
          } else {
            line.applications.add(journal);
          }
        }

        const surplus = [];
        let surplusLines = 0;

        for (const [key, line] of lines) {
          const allowed = stillApplied.has(key) ? 0 : line.applications.size;
          if (line.reversals.size <= allowed) continue;

          surplusLines += 1;
          // Newest first, so the reversal that matches the user's own action survives.
          const ordered = [...line.reversals.entries()].sort((a, b) => b[1][0].createdAt - a[1][0].createdAt);
          for (const [, journalRows] of ordered.slice(0, line.reversals.size - allowed)) {
            surplus.push(journalRows[0].journalId);
            droppedJournals += 1;
            droppedRows += journalRows.length;
            for (const row of journalRows) {
              const account = String(row.accountId);
              movement.set(account, round2((movement.get(account) || 0) - (row.debit || 0) + (row.credit || 0)));
            }
          }
        }

        console.log(`  ${module.sourceModule.padEnd(20)} ${lines.size} lines, ${surplusLines} with repeated reversals`);

        if (apply && surplus.length) {
          await ledgerEntries.deleteMany({ journalId: { $in: surplus }, ...companyScope });
        }
      }

      console.log(`\n${droppedRows} rows in ${droppedJournals} journals`);

      const moved = [...movement.entries()].filter(entry => entry[1] !== 0);
      if (moved.length) {
        const accounts = await books
          .collection('accounts')
          .find({ _id: { $in: moved.map(entry => new ObjectId(entry[0])) } })
          .project({ accountName: 1 })
          .toArray();
        const accountName = new Map(accounts.map(account => [String(account._id), account.accountName]));
        console.log('balances corrected:');
        for (const [account, amount] of moved) {
          console.log(
            `  ${String(accountName.get(account) || account).padEnd(28)} ${amount > 0 ? 'Dr' : 'Cr'} ${Math.abs(amount)}`,
          );
        }
      } else {
        console.log('no repeated reversals found');
      }

      console.log(apply ? '✅ Migration up completed' : 'ℹ️  Report only — rerun with --apply to write');
    } catch (err) {
      console.error('❌ Migration up failed:', err);
      throw err;
    } finally {
      await client.close();
    }
  },
};

if (require.main === module) {
  if (process.argv[2] !== 'up') {
    console.error('Usage: node migrations/removeSurplusAdvanceReversals-remove.js up [--companyId=<id>] [--apply]');
    process.exit(1);
  }

  module.exports
    .up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
