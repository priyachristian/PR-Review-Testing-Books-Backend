/**
 * CRM + Books legacy bank migration (full chain).
 *
 * Runs, in order:
 *   1. mergeBanksIntoAccounts      — Bank docs -> Account + link bank.accountId
 *   2. migrateDocumentBankAccountId — quotes, sales orders, invoices, etc.
 *   3. renameAccountantModuleBankIds — expense / payments / accountant / refunds
 *      (bankId -> paidThroughAccountId / depositToAccountId / refund account fields)
 *   4. migrateBankTransferLogAccountIds — bank transfer logs
 *      (fromBankId/toBankId -> fromAccountId/toAccountId)
 *
 * Prerequisite: CRM companies should have default COA seeded
 * (abss-account-backend/migrations/seedCoaForCrmCompanies.js --apply).
 *
 * Idempotent: safe to re-run.
 *
 * Usage:
 *   node migrations/migrateCrmLegacyBanks.js                  # dry run report
 *   node migrations/migrateCrmLegacyBanks.js --apply          # all companies
 *   node migrations/migrateCrmLegacyBanks.js --apply <companyId>
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { runMergeBanksIntoAccounts } = require('./mergeBanksIntoAccounts');
const { runMigrateDocumentBankAccountId, buildBankToAccountMap } = require('./migrateDocumentBankAccountId');
const { runRenameAccountantModuleBankIds } = require('./renameAccountantModuleBankIds');
const { runMigrateBankTransferLogAccountIds } = require('./migrateBankTransferLogAccountIds');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const companyArg = args.find(arg => arg !== '--apply' && ObjectId.isValid(arg));
  return {
    apply,
    companyId: companyArg ? new ObjectId(companyArg) : null,
  };
}

async function buildReport(db, companyId, excludeIds = []) {
  const companyScope = companyId ? { companyId } : excludeIds.length ? { companyId: { $nin: excludeIds } } : {};

  const [
    bankCount,
    banksWithoutAccountId,
    quotesWithBankId,
    salesOrdersWithBankId,
    quotesWithBankAccountIdOnly,
    salesOrdersWithBankAccountIdOnly,
    transferLogsWithLegacyBankId,
    transferLogsAlreadyMigrated,
  ] = await Promise.all([
    db.booksCrm.collection('banks').countDocuments(companyScope),
    db.booksCrm
      .collection('banks')
      .countDocuments({ ...companyScope, $or: [{ accountId: { $exists: false } }, { accountId: null }] }),
    db.booksCrm.collection('quotes').countDocuments({ ...companyScope, bankId: { $exists: true, $ne: null } }),
    db.booksCrm.collection('salesorders').countDocuments({ ...companyScope, bankId: { $exists: true, $ne: null } }),
    db.booksCrm.collection('quotes').countDocuments({
      ...companyScope,
      bankAccountId: { $exists: true, $ne: null },
      bankId: { $exists: false },
    }),
    db.booksCrm.collection('salesorders').countDocuments({
      ...companyScope,
      bankAccountId: { $exists: true, $ne: null },
      bankId: { $exists: false },
    }),
    db.booksCrm.collection('banktransferlogs').countDocuments({
      ...companyScope,
      $or: [{ fromBankId: { $exists: true, $ne: null } }, { toBankId: { $exists: true, $ne: null } }],
    }),
    db.booksCrm.collection('banktransferlogs').countDocuments({
      ...companyScope,
      $or: [{ fromAccountId: { $exists: true, $ne: null } }, { toAccountId: { $exists: true, $ne: null } }],
      fromBankId: { $exists: false },
      toBankId: { $exists: false },
    }),
  ]);

  const accountIdByBankId = await buildBankToAccountMap(db, companyScope);

  return {
    companyId: companyId ? companyId.toString() : 'ALL',
    legacyBanks: bankCount,
    banksNeedingLink: banksWithoutAccountId,
    bankAccountLinks: accountIdByBankId.size,
    quotesWithLegacyBankId: quotesWithBankId,
    salesOrdersWithLegacyBankId: salesOrdersWithBankId,
    quotesAlreadyMigrated: quotesWithBankAccountIdOnly,
    salesOrdersAlreadyMigrated: salesOrdersWithBankAccountIdOnly,
    transferLogsWithLegacyBankId,
    transferLogsAlreadyMigrated,
  };
}

async function run() {
  const { apply, companyId } = parseArgs();

  if (companyId && isCompanyExcluded(companyId)) {
    console.log(`Company ${companyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
    return;
  }

  if (!companyId && excludedObjectIds.length) {
    console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}\n`);
  }

  if (!apply) {
    const db = await getConnection();
    try {
      console.log('=== CRM legacy bank migration — dry run ===\n');
      const report = await buildReport(db, companyId, excludedObjectIds);
      console.table([report]);
      console.log('\nDry run only. Pass --apply to run the migration chain.');
      console.log('Optional single company: node migrations/migrateCrmLegacyBanks.js --apply <companyId>');
      console.log('\nRecommended order for a fresh CRM-only company:');
      console.log('  1. abss-account-backend: node migrations/seedCoaForCrmCompanies.js --apply');
      console.log('  2. abss-books-backend:   node migrations/migrateCrmLegacyBanks.js --apply');
    } finally {
      await db.client.close();
    }
    return;
  }

  console.log('=== Step 1/4: Merge legacy banks into accounts ===');
  await runMergeBanksIntoAccounts(companyId, excludedObjectIds);

  console.log('\n=== Step 2/4: Migrate document bankId -> bankAccountId ===');
  await runMigrateDocumentBankAccountId(companyId, excludedObjectIds);

  console.log('\n=== Step 3/4: Remap expense / payment / accountant bank references ===');
  await runRenameAccountantModuleBankIds(companyId, excludedObjectIds);

  console.log('\n=== Step 4/4: Migrate bank transfer log from/to bank -> account ===');
  await runMigrateBankTransferLogAccountIds(companyId, excludedObjectIds);

  console.log('\nCRM legacy bank migration completed successfully.');
}

run()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
