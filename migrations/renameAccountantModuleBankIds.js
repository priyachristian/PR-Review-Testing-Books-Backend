/**
 * Bank references -> chart-of-accounts references.
 *
 * These collections stored `bankId` pointing at the Bank collection (and some
 * may still hold a Bank._id in the newer Account field after a schema-only
 * rename). Banks are now Accounts, so each value is remapped through
 * Bank.accountId and the field is set to the role it plays (deposit-to /
 * paid-through / refund from-account / refund to-account).
 *
 * Covers:
 *   - Books expense / payment made / payment received (+ refunds)
 *   - Credit / debit note refunds
 *
 * Run AFTER mergeBanksIntoAccounts.js (which creates the Bank -> Account links).
 * Idempotent: documents already carrying Account ids are left alone.
 *
 * Run: node migrations/renameAccountantModuleBankIds.js            (all companies)
 *      node migrations/renameAccountantModuleBankIds.js <companyId> (single company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { buildBankToAccountMap } = require('./migrateDocumentBankAccountId');

const TARGETS = [
  // Books — old bankId still present on historical rows across companies
  { db: 'books', collection: 'expenses', field: 'paidThroughAccountId' },
  { db: 'books', collection: 'recurringexpenses', field: 'paidThroughAccountId' },
  { db: 'books', collection: 'paymentmades', field: 'paidThroughAccountId' },
  { db: 'booksCrm', collection: 'paymentreceiveds', field: 'depositToAccountId' },
];

const REFUND_TARGETS = [
  { db: 'books', collection: 'paymentmades', field: 'toAccountId' },
  { db: 'booksCrm', collection: 'paymentreceiveds', field: 'fromAccountId' },
  { db: 'books', collection: 'creditnotes', field: 'fromAccountId' },
  { db: 'books', collection: 'debitnotes', field: 'toAccountId' },
];

const getCollection = (db, target) => db[target.db].collection(target.collection);

const remapTopLevelBankIds = async (collection, companyScope, accountIdByBankId, field) => {
  const documents = await collection
    .find({ ...companyScope, bankId: { $exists: true, $ne: null } })
    .project({ _id: 1, bankId: 1, [field]: 1 })
    .toArray();

  let remapped = 0;
  let unlinked = 0;

  for (const document of documents) {
    const accountId = accountIdByBankId.get(document.bankId.toString());
    if (accountId) {
      await collection.updateOne({ _id: document._id }, { $set: { [field]: accountId }, $unset: { bankId: '' } });
      remapped += 1;
    } else {
      await collection.updateOne({ _id: document._id }, { $unset: { bankId: '' } });
      unlinked += 1;
    }
  }

  return { remapped, unlinked };
};

/** Schema renamed bankId -> Account field but left Bank._id values in place. */
const remapAccountFieldHoldingBankId = async (collection, companyScope, accountIdByBankId, field) => {
  const documents = await collection
    .find({ ...companyScope, [field]: { $exists: true, $ne: null } })
    .project({ _id: 1, [field]: 1 })
    .toArray();

  let remapped = 0;

  for (const document of documents) {
    const value = document[field];
    if (!value) continue;
    const accountId = accountIdByBankId.get(value.toString());
    if (!accountId) continue;
    if (accountId.toString() === value.toString()) continue;

    await collection.updateOne({ _id: document._id }, { $set: { [field]: accountId } });
    remapped += 1;
  }

  return remapped;
};

const remapRefundBankIds = async (collection, companyScope, accountIdByBankId, field) => {
  const documents = await collection
    .find({ ...companyScope, 'refunds.bankId': { $exists: true, $ne: null } })
    .project({ _id: 1, refunds: 1 })
    .toArray();

  let remapped = 0;
  let unlinked = 0;

  for (const document of documents) {
    for (const refund of document.refunds || []) {
      if (!refund.bankId) continue;

      const accountId = accountIdByBankId.get(refund.bankId.toString());
      await collection.updateOne(
        { _id: document._id },
        accountId
          ? { $set: { [`refunds.$[r].${field}`]: accountId }, $unset: { 'refunds.$[r].bankId': '' } }
          : { $unset: { 'refunds.$[r].bankId': '' } },
        { arrayFilters: [{ 'r._id': refund._id }] },
      );

      if (accountId) remapped += 1;
      else unlinked += 1;
    }
  }

  return { remapped, unlinked };
};

const remapRefundFieldHoldingBankId = async (collection, companyScope, accountIdByBankId, field) => {
  const documents = await collection
    .find({ ...companyScope, [`refunds.${field}`]: { $exists: true, $ne: null } })
    .project({ _id: 1, refunds: 1 })
    .toArray();

  let remapped = 0;

  for (const document of documents) {
    for (const refund of document.refunds || []) {
      const value = refund[field];
      if (!value || refund.bankId) continue;

      const accountId = accountIdByBankId.get(value.toString());
      if (!accountId || accountId.toString() === value.toString()) continue;

      await collection.updateOne(
        { _id: document._id },
        { $set: { [`refunds.$[r].${field}`]: accountId } },
        { arrayFilters: [{ 'r._id': refund._id }] },
      );
      remapped += 1;
    }
  }

  return remapped;
};

const runRenameAccountantModuleBankIds = async (targetCompanyId = null, excludeCompanyIds = []) => {
  const db = await getConnection();
  const client = db.client;

  try {
    console.log('Connected to MongoDB');

    const companyScope = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludeCompanyIds.length
        ? { companyId: { $nin: excludeCompanyIds } }
        : {};
    const accountIdByBankId = await buildBankToAccountMap(db, companyScope);
    console.log(`Bank -> Account links available: ${accountIdByBankId.size}`);

    const summary = { targets: {}, refunds: {} };

    for (const target of TARGETS) {
      const collection = getCollection(db, target);
      const fromBankId = await remapTopLevelBankIds(collection, companyScope, accountIdByBankId, target.field);
      const fromAccountField = await remapAccountFieldHoldingBankId(collection, companyScope, accountIdByBankId, target.field);

      summary.targets[target.collection] = { ...fromBankId, fieldRemapped: fromAccountField };
      console.log(
        `${target.collection}: ${fromBankId.remapped} bankId -> ${target.field}, ` +
          `${fromBankId.unlinked} dead bankId cleared, ${fromAccountField} ${target.field} held Bank id`,
      );
    }

    for (const target of REFUND_TARGETS) {
      const collection = getCollection(db, target);
      const fromBankId = await remapRefundBankIds(collection, companyScope, accountIdByBankId, target.field);
      const fromAccountField = await remapRefundFieldHoldingBankId(collection, companyScope, accountIdByBankId, target.field);

      summary.refunds[target.collection] = { ...fromBankId, fieldRemapped: fromAccountField };
      console.log(
        `${target.collection} refunds: ${fromBankId.remapped} bankId -> ${target.field}, ` +
          `${fromBankId.unlinked} dead bankId cleared, ${fromAccountField} ${target.field} held Bank id`,
      );
    }

    return summary;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

const migrate = async () => {
  try {
    const targetCompanyId = process.argv[2] ? new ObjectId(process.argv[2]) : null;
    await runRenameAccountantModuleBankIds(targetCompanyId);
    console.log('Bank reference migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
};

if (require.main === module) {
  migrate();
}

module.exports = { runRenameAccountantModuleBankIds };
