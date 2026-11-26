/**
 * Migration: drop the time of day from ledger posting dates.
 *
 * A journal is dated, not timed. Documents pass a plain date, but payments, production and
 * inventory adjustments pass "now", so their rows carried a time. The account ledger sorts by
 * postingDate and then by createdAt, so a row with a time sorted above every row of the same day
 * — a newly created invoice landed in the middle of the list instead of on top.
 *
 * postJournal now stores the day alone. This does the same to the rows already written, so the
 * whole ledger sorts by day and then by the order things were entered.
 *
 * Only rows that still carry a time are touched, so the migration is idempotent.
 *
 * Note: a row posted at 18:00 UTC or later moves back one day on screen for a viewer ahead of
 * UTC. That is the same day the row would be given if it were posted now, so the migration makes
 * old rows agree with new ones rather than introducing a new rule. The report counts them.
 *
 * Usage:
 *   node migrations/normalizeLedgerPostingDate-remove.js up                         report only, all companies
 *   node migrations/normalizeLedgerPostingDate-remove.js up --companyId=<id>        report only, one company
 *   node migrations/normalizeLedgerPostingDate-remove.js up --apply                 write, all companies
 *   node migrations/normalizeLedgerPostingDate-remove.js up --companyId=<id> --apply write, one company
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const startOfDay = { $dateTrunc: { date: '$postingDate', unit: 'day' } };

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
    const { client, books } = await getConnection();
    const ledgerEntries = books.collection('ledgerentries');
    const companyScope = companyId ? { companyId } : {};

    try {
      console.log(`Scope: ${companyId ? companyId.toString() : 'ALL COMPANIES'}   Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

      const filter = { ...companyScope, $expr: { $ne: ['$postingDate', startOfDay] } };
      const rows = await ledgerEntries.countDocuments(filter);

      const byModule = await ledgerEntries
        .aggregate([
          { $match: filter },
          { $group: { _id: { module: '$sourceModule', shifts: { $gte: [{ $hour: '$postingDate' }, 18] } }, n: { $sum: 1 } } },
          { $sort: { n: -1 } },
        ])
        .toArray();

      console.log(`${rows} rows still carry a time of day`);
      for (const group of byModule) {
        const note = group._id.shifts ? '  (moves back one day on screen ahead of UTC)' : '';
        console.log(`  ${String(group._id.module).padEnd(24)} ${group.n}${note}`);
      }

      if (apply && rows) {
        await ledgerEntries.updateMany(filter, [{ $set: { postingDate: startOfDay } }]);
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
    console.error('Usage: node migrations/normalizeLedgerPostingDate-remove.js up [--companyId=<id>] [--apply]');
    process.exit(1);
  }

  module.exports
    .up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
