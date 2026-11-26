/**
 * Migration script: Backfill OpeningBalanceTransaction from existing customer/vendor branch opening balances.
 *
 * Logic MUST match `customerMaster.service.js` → `createOpeningBalanceTransactions` (and update-customer OB rules):
 *
 * - For each branch, read `branch.openingBalance` (number on customer.branch[]).
 * - Skip if parsed value is exactly zero (no transaction row for "no opening balance").
 * - Positive balance:
 *   - Customer → `opening_receivable`
 *   - Vendor   → `opening_payable`
 * - Negative balance (credit owed to contact / by contact per product conventions):
 *   - Customer → `customer_credit`
 *   - Vendor   → `vendor_credit`
 * - Stored `amount` and `remainingAmount` are always **absolute** values: `Math.abs(openingBalance)`.
 *
 * Contact role: `Role.isCustomer` takes precedence over vendor when both are true (same as app).
 *
 * Creates documents in `openingbalancetransactions` only where no row exists for `(contactId, branchId)`.
 * Does not modify existing OB rows (no double-counting; safe to re-run).
 *
 * Usage:
 *   NODE_ENV=development node scripts/migrate-opening-balance-transactions.js
 *   NODE_ENV=development node scripts/migrate-opening-balance-transactions.js --dry-run
 *   NODE_ENV=development node scripts/migrate-opening-balance-transactions.js --companyId=xxx
 *   NODE_ENV=development node scripts/migrate-opening-balance-transactions.js --companyId=xxx --dry-run
 *
 * Requires: NODE_ENV and .env (e.g. .env.development) with cluster URI and db names.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const { getConnection } = require('../config/db');
const { TRANSACTION_TYPE, CONTACT_TYPE } = require('../utils/enum');

/**
 * Same mapping as createOpeningBalanceTransactions in customerMaster.service.js
 * @returns {{ type: string, amount: number } | null} null → skip branch (zero balance)
 */
function resolveOpeningBalanceTxnMeta(isCustomer, rawOpeningBalance) {
  const ob = parseFloat(rawOpeningBalance) || 0;
  if (!ob) {
    return null;
  }
  const isCredit = ob < 0;
  const type = isCustomer
    ? isCredit
      ? TRANSACTION_TYPE.CUSTOMER_CREDIT
      : TRANSACTION_TYPE.OPENING_RECEIVABLE
    : isCredit
      ? TRANSACTION_TYPE.VENDOR_CREDIT
      : TRANSACTION_TYPE.OPENING_PAYABLE;
  const amount = Math.abs(ob);
  return { type, amount };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  let dryRun = false;
  for (const a of args) {
    if (a.startsWith('--companyId=')) companyId = a.split('=')[1].trim();
    else if (a === '--dry-run') dryRun = true;
  }
  return { companyId, dryRun };
}

async function migrate() {
  const { companyId, dryRun } = parseArgs();

  console.log('[Migrate OB] Starting (non-zero balances: receivable / payable / customer_credit / vendor_credit)...');
  if (dryRun) console.log('[Migrate OB] DRY RUN - no changes will be made');
  if (companyId) console.log('[Migrate OB] Filtering by companyId:', companyId);

  let client;
  let created = 0;
  let skippedZero = 0;
  let skippedExisting = 0;
  let skippedNoBranch = 0;
  let skippedNoCompany = 0;
  let errors = 0;

  try {
    const db = await getConnection();
    client = db.client;
    const bookCrmDb = db.booksCrm;

    const customersColl = bookCrmDb.collection('customers');
    const obColl = bookCrmDb.collection('openingbalancetransactions');

    const customerFilter = {
      $or: [{ 'Role.isCustomer': true }, { 'Role.isVendor': true }],
      'branch.0': { $exists: true },
    };
    if (companyId) {
      customerFilter.companyId = mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : companyId;
    }

    const customers = await customersColl.find(customerFilter).project({ _id: 1, companyId: 1, Role: 1, branch: 1 }).toArray();

    console.log(`[Migrate OB] Found ${customers.length} customers/vendors with branch data`);

    const existingOBFilter = companyId
      ? {
          companyId: mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : companyId,
        }
      : {};

    const existingOB = await obColl.find(existingOBFilter).project({ contactId: 1, branchId: 1 }).toArray();

    const existingKeys = new Set(existingOB.map(o => `${(o.contactId || '').toString()}_${(o.branchId || '').toString()}`));

    const toCreate = [];

    for (const customer of customers) {
      const branches = customer.branch || [];
      const isCustomer = customer.Role?.isCustomer;
      const contactType = isCustomer ? CONTACT_TYPE.CUSTOMER : CONTACT_TYPE.VENDOR;

      for (const b of branches) {
        const meta = resolveOpeningBalanceTxnMeta(isCustomer, b.openingBalance);
        if (!meta) {
          skippedZero++;
          continue;
        }

        const branchId = b.branchId;
        if (!branchId) {
          console.warn(`[Migrate OB] Skipping contact ${customer._id} - branch has no branchId`);
          skippedNoBranch++;
          continue;
        }

        if (!customer.companyId) {
          console.warn(`[Migrate OB] Skipping contact ${customer._id} - no companyId`);
          skippedNoCompany++;
          continue;
        }

        const key = `${customer._id.toString()}_${branchId.toString()}`;
        if (existingKeys.has(key)) {
          skippedExisting++;
          continue;
        }

        const suffix = `${customer._id.toString().slice(-6)}-${branchId.toString().slice(-4)}`;
        const { type, amount } = meta;

        toCreate.push({
          contactId: customer._id,
          contactType,
          type,
          amount,
          remainingAmount: amount,
          date: new Date(),
          branchId,
          companyId: customer.companyId,
          transactionNo: `OB-${suffix}`,
        });
        existingKeys.add(key);
      }
    }

    const byType = toCreate.reduce((acc, row) => {
      acc[row.type] = (acc[row.type] || 0) + 1;
      return acc;
    }, {});

    console.log(
      `[Migrate OB] To create: ${toCreate.length} (by type: ${JSON.stringify(byType)}), skipped — zero balance: ${skippedZero}, existing OB: ${skippedExisting}, no branchId: ${skippedNoBranch}, no companyId: ${skippedNoCompany}`,
    );

    if (toCreate.length > 0 && !dryRun) {
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const result = await obColl.insertMany(toCreate, { session });
          created = result.insertedCount ?? Object.keys(result.insertedIds || {}).length;
        });
      } finally {
        await session.endSession();
      }
      console.log(`[Migrate OB] Created ${created} OpeningBalanceTransaction records`);
    } else if (dryRun && toCreate.length > 0) {
      console.log('[Migrate OB] Would create:');
      toCreate.slice(0, 15).forEach((t, i) => {
        console.log(
          `  ${i + 1}. contactId=${t.contactId} branchId=${t.branchId} amount=${t.amount} type=${t.type} contactType=${t.contactType} txn=${t.transactionNo}`,
        );
      });
      if (toCreate.length > 15) {
        console.log(`  ... and ${toCreate.length - 15} more`);
      }
    }
  } catch (err) {
    console.error('[Migrate OB] Error:', err.message);
    errors++;
  } finally {
    if (client) {
      await client.close();
    }
  }

  console.log(
    `[Migrate OB] Done. Created: ${created}, Skipped (zero): ${skippedZero}, (existing OB): ${skippedExisting}, (no branch): ${skippedNoBranch}, (no company): ${skippedNoCompany}, Errors: ${errors}`,
  );
  process.exit(errors > 0 ? 1 : 0);
}

migrate();
