/**
 * Backfills subItemGroupId (per-company auto-increment number) on existing sub item groups.
 * Groups missing the number are numbered in createdAt order (ties broken by _id), continuing after
 * the company's current highest subItemGroupId, so it is safe to re-run and never renumbers.
 *
 * Run: node migrations/backfillSubItemGroupId.js                      (dry run, all companies)
 *      node migrations/backfillSubItemGroupId.js <companyId>           (dry run, one company)
 *      node migrations/backfillSubItemGroupId.js <companyId> --apply   (write)
 *      node migrations/backfillSubItemGroupId.js --apply               (write, all companies)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const missingFilter = { $or: [{ subItemGroupId: { $exists: false } }, { subItemGroupId: null }] };

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`Scope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode: APPLY' : 'Mode: dry run — pass --apply to write');

    const groups = db.booksCrm.collection('subitemgroups');
    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};

    const companyIds = await groups.distinct('companyId', { ...scope, ...missingFilter });
    console.log(`Companies with unnumbered sub item groups: ${companyIds.length}`);

    let totalUpdated = 0;

    for (const companyId of companyIds) {
      const last = await groups
        .find({ companyId, subItemGroupId: { $type: 'number' } })
        .sort({ subItemGroupId: -1 })
        .limit(1)
        .project({ subItemGroupId: 1 })
        .toArray();
      let next = (last[0]?.subItemGroupId || 0) + 1;

      const pending = await groups
        .find({ companyId, ...missingFilter })
        .sort({ createdAt: 1, _id: 1 })
        .project({ name: 1 })
        .toArray();

      const ops = pending.map(group => ({
        updateOne: { filter: { _id: group._id }, update: { $set: { subItemGroupId: next++ } } },
      }));

      console.log(
        `\nCompany ${companyId}: ${pending.length} to number (${ops[0].updateOne.update.$set.subItemGroupId}..${next - 1})`,
      );
      pending.slice(0, 5).forEach((group, index) => {
        console.log(`   ${String(ops[index].updateOne.update.$set.subItemGroupId).padStart(4)}  ${group.name}`);
      });
      if (pending.length > 5) console.log(`   ... and ${pending.length - 5} more`);

      if (apply && ops.length) {
        const result = await groups.bulkWrite(ops, { ordered: true });
        totalUpdated += result.modifiedCount;
      }
    }

    console.log(`\nSub item groups ${apply ? 'updated' : 'that would be updated'}: ${apply ? totalUpdated : 'see above'}`);
    if (!apply) console.log('Nothing written. Re-run with --apply to backfill.');
  } catch (error) {
    console.error('Sub item group id backfill failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
