/**
 * Payment mode value migration — the stored value for petty cash payments
 * changes from 'Petty Cash' to 'PETTY_CASH' (consistent with CHEQUE,
 * BANK_TRANSFER, UPI, OTHER). Bank accountType 'Petty Cash' is a different
 * field and is intentionally NOT touched.
 *
 * Idempotent: safe to re-run (only documents still holding the old value match).
 *
 * Usage:
 *   node migrations/migratePettyCashPaymentMode.js                  # dry run report
 *   node migrations/migratePettyCashPaymentMode.js --apply          # all companies
 *   node migrations/migratePettyCashPaymentMode.js --apply <companyId>
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const OLD_VALUE = 'Petty Cash';
const NEW_VALUE = 'PETTY_CASH';

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

// Every collection that stores a payment mode, with its field(s).
const TARGETS = [
  { db: 'booksCrm', collection: 'paymentreceiveds', fields: ['paymentMode'], refundsField: 'refunds' },
  { db: 'books', collection: 'paymentmades', fields: ['paymentMode'], refundsField: 'refunds' },
  { db: 'books', collection: 'expenses', fields: ['paidThrough'] },
  { db: 'books', collection: 'recurringexpenses', fields: ['paidThrough'] },
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

  if (companyId && isCompanyExcluded(companyId)) {
    console.log(`Company ${companyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
    return;
  }

  const companyScope = companyId ? { companyId } : excludedObjectIds.length ? { companyId: { $nin: excludedObjectIds } } : {};

  let client;
  try {
    const db = await getConnection();
    client = db.client;
    console.log('Connected to MongoDB');
    console.log(
      apply ? '=== Petty cash payment mode migration — APPLY ===' : '=== Petty cash payment mode migration — dry run ===',
    );
    console.log(`Scope: ${companyId ? companyId.toString() : 'ALL companies'}\n`);
    if (!companyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}\n`);
    }

    for (const target of TARGETS) {
      const collection = db[target.db].collection(target.collection);

      for (const field of target.fields) {
        const filter = { ...companyScope, [field]: OLD_VALUE };
        if (apply) {
          const result = await collection.updateMany(filter, { $set: { [field]: NEW_VALUE } });
          console.log(`${target.collection}.${field}: ${result.modifiedCount} updated`);
        } else {
          const count = await collection.countDocuments(filter);
          console.log(`${target.collection}.${field}: ${count} to update`);
        }
      }

      if (target.refundsField) {
        const path = `${target.refundsField}.paymentMode`;
        const filter = { ...companyScope, [path]: OLD_VALUE };
        if (apply) {
          const result = await collection.updateMany(
            filter,
            { $set: { [`${target.refundsField}.$[refund].paymentMode`]: NEW_VALUE } },
            { arrayFilters: [{ 'refund.paymentMode': OLD_VALUE }] },
          );
          console.log(`${target.collection}.${path}: ${result.modifiedCount} updated`);
        } else {
          const count = await collection.countDocuments(filter);
          console.log(`${target.collection}.${path}: ${count} to update`);
        }
      }
    }

    if (apply) {
      console.log('\nPayment mode migration completed successfully!');
    } else {
      console.log('\nDry run only. Pass --apply to run the migration.');
      console.log('Optional single company: node migrations/migratePettyCashPaymentMode.js --apply <companyId>');
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
