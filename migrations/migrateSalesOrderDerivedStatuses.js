/**
 * Migration: remap SalesOrder.deliveryChallanStatus, invoiceStatus, and paymentStatus
 * to the new model enums. Delivery Challan / Invoice / Payment documents are not touched.
 *
 * Legacy → New:
 *   deliveryChallanStatus: NOT_DELIVERED → DRAFT, PARTIALLY_DELIVERED → SENT, DELIVERED → DELIVERED
 *   invoiceStatus:         NOT_INVOICED → DRAFT, PARTIALLY_INVOICED → PARTIALLY_PAID, INVOICED → SENT
 *   paymentStatus:         NOT_PAID → PENDING, PARTIALLY_PAID → APPROVED, PAID → COMPLETED
 *
 * Idempotent: only documents still holding a legacy value are updated.
 *
 * Usage:
 *   node migrations/migrateSalesOrderDerivedStatuses.js                  # apply (all sales orders)
 *   node migrations/migrateSalesOrderDerivedStatuses.js --dry            # dry run
 *   node migrations/migrateSalesOrderDerivedStatuses.js <mongoId>        # apply one sales order
 *   node migrations/migrateSalesOrderDerivedStatuses.js <mongoId> --dry
 *   node migrations/migrateSalesOrderDerivedStatuses.js down             # rollback
 *   node migrations/migrateSalesOrderDerivedStatuses.js down --dry
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const COLLECTION = 'salesorders';
const DB = 'booksCrm';

const reverseMap = map => Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));

const FIELD_MIGRATIONS = [
  {
    field: 'deliveryChallanStatus',
    forwardMap: {
      NOT_DELIVERED: 'DRAFT',
      PARTIALLY_DELIVERED: 'SENT',
      DELIVERED: 'DELIVERED',
    },
  },
  {
    field: 'invoiceStatus',
    forwardMap: {
      NOT_INVOICED: 'DRAFT',
      PARTIALLY_INVOICED: 'PARTIALLY_PAID',
      INVOICED: 'SENT',
    },
  },
  {
    field: 'paymentStatus',
    forwardMap: {
      NOT_PAID: 'PENDING',
      PARTIALLY_PAID: 'APPROVED',
      PAID: 'COMPLETED',
    },
  },
];

FIELD_MIGRATIONS.forEach(migration => {
  migration.reverseMap = reverseMap(migration.forwardMap);
  migration.legacyValues = Object.keys(migration.forwardMap);
});

function parseArgs() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const direction = args.includes('down') ? 'down' : 'up';
  const mongoIdArg = args.find(arg => !['--dry', 'up', 'down'].includes(arg) && ObjectId.isValid(arg));
  return {
    apply: !dry,
    direction,
    mongoId: mongoIdArg ? new ObjectId(mongoIdArg) : null,
  };
}

async function countByStatus(collection, field, values, scope) {
  const counts = {};
  for (const value of values) {
    counts[value] = await collection.countDocuments({ ...scope, [field]: value });
  }
  return counts;
}

async function migrateField({ collection, field, statusMap, legacyValues, scope, apply }) {
  let modified = 0;

  for (const [fromStatus, toStatus] of Object.entries(statusMap)) {
    const filter = { ...scope, [field]: fromStatus };
    if (apply) {
      const result = await collection.updateMany(filter, { $set: { [field]: toStatus } });
      modified += result.modifiedCount;
    } else {
      modified += await collection.countDocuments(filter);
    }
  }

  const beforeCounts = await countByStatus(collection, field, legacyValues, scope);
  const remainingLegacy = Object.values(beforeCounts).reduce((sum, count) => sum + count, 0);

  return { modified, beforeCounts, remainingLegacy: apply ? remainingLegacy : null };
}

const migrate = async () => {
  const { apply, direction, mongoId } = parseArgs();
  const scope = mongoId ? { _id: mongoId } : {};
  const isDown = direction === 'down';

  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const collection = db[DB].collection(COLLECTION);

    console.log('Connected to MongoDB');
    console.log(
      apply
        ? `=== SalesOrder derived status migration — ${isDown ? 'DOWN APPLY' : 'UP APPLY'} ===`
        : `=== SalesOrder derived status migration — ${isDown ? 'DOWN dry run' : 'UP dry run'} ===`,
    );
    console.log(`Scope: ${mongoId ? `sales order ${mongoId.toString()}` : 'ALL sales orders'}\n`);

    if (mongoId) {
      const salesOrder = await collection.findOne(
        { _id: mongoId },
        { projection: { orderId: 1, deliveryChallanStatus: 1, invoiceStatus: 1, paymentStatus: 1 } },
      );
      if (!salesOrder) {
        throw new Error(`SalesOrder ${mongoId} not found`);
      }
      console.log(`Document: ${JSON.stringify(salesOrder)}\n`);
    }

    for (const migration of FIELD_MIGRATIONS) {
      const statusMap = isDown ? migration.reverseMap : migration.forwardMap;
      const { modified, beforeCounts, remainingLegacy } = await migrateField({
        collection,
        field: migration.field,
        statusMap,
        legacyValues: migration.legacyValues,
        scope,
        apply,
      });

      console.log(`${migration.field}:`);
      console.log(`  legacy counts: ${JSON.stringify(beforeCounts)}`);
      console.log(`  ${apply ? 'updated' : 'to update'}: ${modified}`);
      if (apply && !isDown) {
        console.log(`  remaining legacy after run: ${remainingLegacy}`);
      }
      console.log('');
    }

    if (apply) {
      console.log('Migration completed successfully!');
    } else {
      console.log('Dry run only. Re-run without --dry to apply.');
      console.log('Optional single document: node migrations/migrateSalesOrderDerivedStatuses.js <mongoId>');
      console.log('Rollback: node migrations/migrateSalesOrderDerivedStatuses.js down');
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

module.exports = {
  up: () => migrate(),
  down: () => migrate(),
};

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
