/**
 * Bank ledger entries for deposits/withdrawals were posted under the generic
 * BANK_TRANSFER source module before bank.service.js#getBankSourceModule started
 * splitting them out into BANK_DEPOSIT / BANK_WITHDRAWAL (BOOKS-1321). Those old rows
 * no longer match what deleteJournal and the ledger UI look up for the same
 * BankTransferLog, so they're re-stamped here to the module their BankTransferLog's
 * transactionType actually is.
 *
 * Transfers (transactionType TRANSFER) already belong on BANK_TRANSFER and are left alone.
 *
 * An interim build of this branch briefly stamped deposits under a misspelled
 * BANK_DEPOSITE module; those rows are re-stamped to BANK_DEPOSIT here as well.
 *
 * Idempotent: only ledger rows still stamped BANK_TRANSFER (or the transitional
 * misspelled BANK_DEPOSITE) are matched, so a second run finds nothing left to do.
 *
 * Usage:
 *   node migrations/restampBankLedgerSourceModule-remove.js                  # dry run, all companies
 *   node migrations/restampBankLedgerSourceModule-remove.js <companyId>      # dry run, one company
 *   node migrations/restampBankLedgerSourceModule-remove.js --apply          # apply, all companies
 *   node migrations/restampBankLedgerSourceModule-remove.js --apply <companyId>  # apply, one company
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');
const { LEDGER_SOURCE_MODULES, TRANSACTION_TYPES } = require('../utils/enum');

const LEGACY_MISSPELLED_DEPOSIT_MODULE = 'BANK_DEPOSITE';

const RETARGET = [
  {
    transactionType: TRANSACTION_TYPES.DEPOSIT,
    sourceModule: LEDGER_SOURCE_MODULES.BANK_DEPOSIT,
    fromModules: [LEDGER_SOURCE_MODULES.BANK_TRANSFER, LEGACY_MISSPELLED_DEPOSIT_MODULE],
  },
  {
    transactionType: TRANSACTION_TYPES.WITHDRAWAL,
    sourceModule: LEDGER_SOURCE_MODULES.BANK_WITHDRAWAL,
    fromModules: [LEDGER_SOURCE_MODULES.BANK_TRANSFER],
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const companyArg = args.find(arg => arg !== '--apply' && ObjectId.isValid(arg));
  return {
    apply,
    companyId: companyArg ? new ObjectId(companyArg) : null,
  };
}

const migrate = async () => {
  const { apply, companyId } = parseArgs();
  const companyScope = companyId ? { companyId } : {};

  let client;
  try {
    const db = await getConnection();
    client = db.client;
    console.log('Connected to MongoDB');
    console.log(
      apply ? '=== Bank ledger source module re-stamp — APPLY ===' : '=== Bank ledger source module re-stamp — dry run ===',
    );
    console.log(`Scope: ${companyId ? companyId.toString() : 'ALL companies'}\n`);

    const bankTransferLogs = db.booksCrm.collection('banktransferlogs');
    const ledgerEntries = db.books.collection('ledgerentries');

    for (const { transactionType, sourceModule, fromModules } of RETARGET) {
      const logs = await bankTransferLogs
        .find({ ...companyScope, transactionType })
        .project({ _id: 1 })
        .toArray();
      const logIds = logs.map(log => log._id);

      if (!logIds.length) {
        console.log(`${transactionType}: 0 BankTransferLog(s) found — skipping`);
        continue;
      }

      const filter = {
        ...companyScope,
        sourceModule: { $in: fromModules },
        sourceId: { $in: logIds },
      };

      if (apply) {
        const result = await ledgerEntries.updateMany(filter, { $set: { sourceModule } });
        console.log(`${transactionType}: ${result.modifiedCount} ledger row(s) re-stamped to ${sourceModule}`);
      } else {
        const count = await ledgerEntries.countDocuments(filter);
        console.log(
          `${transactionType}: ${count} ledger row(s) to re-stamp to ${sourceModule} (${logIds.length} matching BankTransferLog(s))`,
        );
      }
    }

    if (apply) {
      console.log('\nBank ledger source module migration completed successfully!');
    } else {
      console.log('\nDry run only. Pass --apply to run the migration.');
      console.log('Scope to one company: node migrations/restampBankLedgerSourceModule-remove.js <companyId>');
      console.log('Apply for one company: node migrations/restampBankLedgerSourceModule-remove.js --apply <companyId>');
    }
  } catch (error) {
    console.error('Migration failed:', error);
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
