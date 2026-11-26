/**
 * Ensures every COA_SYSTEM_ACCOUNTS entry exists for one company (company-scoped).
 *
 * Match key: companyId + systemAccountKey only.
 * Old/global accounts (no companyId) or same name without this key are ignored —
 * a new company row is still created (duplicate name is OK).
 *
 * Run: node migrations/seedMissingSystemAccounts.js <companyId>            (dry run)
 *      node migrations/seedMissingSystemAccounts.js <companyId> --apply    (write)
 *      node migrations/seedMissingSystemAccounts.js <companyId> --apply --create-only
 *                                                              (write, no drift sync)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { COA_SYSTEM_ACCOUNTS } = require('@smit9313/abss-models-core/src/utils/coaSystemAccounts');

const migrate = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const createOnly = args.includes('--create-only');
    const companyArg = args.find(arg => !arg.startsWith('--'));

    const db = await getConnection();
    client = db.client;
    console.log('Connected to MongoDB');

    // One company when named, otherwise every company — the chart has to exist for all of them
    // before anything reads it, and naming 60-odd ids by hand is how one gets missed.
    const companyFilter = companyArg ? { _id: new ObjectId(companyArg) } : {};
    const companyRows = await db.common.collection('companies').find(companyFilter).project({ _id: 1, name: 1 }).toArray();
    const companyNameById = new Map(companyRows.map(row => [String(row._id), row.name]));
    const companyIds = companyArg ? [new ObjectId(companyArg)] : companyRows.map(row => row._id);

    const nameFor = companyId => companyNameById.get(String(companyId)) || 'Unknown';

    console.log(
      `Scope: ${companyArg ? `single company ${nameFor(companyIds[0])} (${companyIds[0]})` : `all companies (${companyIds.length})`}`,
    );
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const accounts = db.books.collection('accounts');
    const tally = { created: 0, synced: 0, unchanged: 0 };

    const seedOrSync = async (companyId, def, parentAccountId) => {
      if (!def.systemAccountKey) {
        throw new Error(`COA def missing systemAccountKey: ${def.accountName}`);
      }

      const existing = await accounts.findOne(
        { companyId, systemAccountKey: def.systemAccountKey },
        { projection: { _id: 1, systemAccountKey: 1, isSystemAccount: 1, parentAccountId: 1, accountName: 1, category: 1 } },
      );

      const wanted = {
        accountName: def.accountName,
        category: def.category,
        isSystemAccount: def.isSystemAccount === true,
        systemAccountKey: def.systemAccountKey,
        parentAccountId: parentAccountId || null,
      };

      if (existing) {
        const needsSync =
          existing.accountName !== wanted.accountName ||
          existing.category !== wanted.category ||
          existing.isSystemAccount !== wanted.isSystemAccount ||
          String(existing.parentAccountId || '') !== String(wanted.parentAccountId || '');

        if (needsSync && !createOnly) {
          tally.synced += 1;
          if (apply) {
            await accounts.updateOne(
              { _id: existing._id, companyId },
              {
                $set: {
                  accountName: wanted.accountName,
                  category: wanted.category,
                  isSystemAccount: wanted.isSystemAccount,
                  parentAccountId: wanted.parentAccountId,
                  updatedAt: new Date(),
                },
              },
            );
          }
        } else {
          tally.unchanged += 1;
        }
        return existing._id;
      }

      // Always create for this company — do not skip because a global/old row
      // has the same accountName/category without companyId or without this key.
      tally.created += 1;
      if (!apply) return null;

      const now = new Date();
      const inserted = await accounts.insertOne({
        accountName: wanted.accountName,
        category: wanted.category,
        companyId,
        parentAccountId: wanted.parentAccountId,
        isSystemAccount: wanted.isSystemAccount,
        systemAccountKey: wanted.systemAccountKey,
        accountCode: null,
        isActive: true,
        updatedBy: [],
        createdAt: now,
        updatedAt: now,
      });
      return inserted.insertedId;
    };

    const alreadyCorrectCompanies = [];

    for (const companyId of companyIds) {
      const before = tally.created;
      const syncedBefore = tally.synced;
      for (const def of COA_SYSTEM_ACCOUNTS) {
        const parentId = await seedOrSync(companyId, def, null);
        for (const child of def.children || []) {
          await seedOrSync(companyId, child, parentId);
        }
      }
      if (!companyArg && tally.created > before) {
        console.log(`   ${nameFor(companyId)} (${companyId})  ${apply ? 'created' : 'would create'} ${tally.created - before}`);
      }
      if (tally.created === before && tally.synced === syncedBefore) {
        alreadyCorrectCompanies.push(companyId);
      }
    }

    console.log(`\n${apply ? 'Created' : 'Would create'}   : ${tally.created}`);
    console.log(`${apply ? 'Synced' : 'Would sync'}    : ${tally.synced}`);
    console.log(`Already correct : ${tally.unchanged}`);
    console.log(`Total in list   : ${tally.created + tally.synced + tally.unchanged}`);

    console.log(`\nAlready-correct companies (${alreadyCorrectCompanies.length}):`);
    if (alreadyCorrectCompanies.length === 0) {
      console.log('   none');
    } else {
      for (const companyId of alreadyCorrectCompanies) {
        console.log(`   ${nameFor(companyId)} (${companyId})`);
      }
    }
    console.log(
      apply
        ? '\nDone — company now has every COA_SYSTEM_ACCOUNTS row (by systemAccountKey).'
        : '\nDry run complete — nothing was written. Re-run with --apply.',
    );
  } catch (error) {
    console.error('Seed failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
