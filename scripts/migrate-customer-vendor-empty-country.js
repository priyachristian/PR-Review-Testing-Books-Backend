/**
 * Effect: On booksCrm `customers` (customer + vendor master records), sets empty `country` to India on
 * billing address, shipping address, and each additional shipping address. Does not change
 * addresses stored on invoices, bills, or other transactions. Dry-run by default; use --apply.
 *
 *   node scripts/migrate-customer-vendor-empty-country.js
 *   node scripts/migrate-customer-vendor-empty-country.js --apply
 *   node scripts/migrate-customer-vendor-empty-country.js --apply --verbose
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const { getConnection } = require('../config/db');
const INDIA = 'India';
const BULK_CHUNK_SIZE = 250;

function parseArgs() {
  const args = process.argv.slice(2);
  let apply = false;
  let verbose = false;

  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--verbose' || arg === '-v') verbose = true;
  }

  return { apply, verbose };
}

function isCountryEmpty(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return true;

  return value.trim() === '';
}

function emptyCountryElemMatch() {
  return {
    $or: [{ country: { $exists: false } }, { country: null }, { country: '' }, { country: { $regex: /^[\s]*$/ } }],
  };
}

function emptyCountryFieldConditions(fieldPath) {
  return [
    { [fieldPath]: { $exists: false } },
    { [fieldPath]: null },
    { [fieldPath]: '' },
    { [fieldPath]: { $regex: /^[\s]*$/ } },
  ];
}

function buildUpdateFields(doc) {
  const $set = {};

  if (isCountryEmpty(doc?.address?.billing?.country)) {
    $set['address.billing.country'] = INDIA;
  }

  if (isCountryEmpty(doc?.address?.shipping?.country)) {
    $set['address.shipping.country'] = INDIA;
  }

  const additional = Array.isArray(doc?.address?.additionalShippingAddresses) ? doc.address.additionalShippingAddresses : [];

  additional.forEach((addr, idx) => {
    if (isCountryEmpty(addr?.country)) {
      $set[`address.additionalShippingAddresses.${idx}.country`] = INDIA;
    }
  });

  return $set;
}

function baseMatchFilter() {
  return {
    $and: [
      {
        $or: [{ 'Role.isCustomer': true }, { 'Role.isVendor': true }],
      },
      {
        $or: [
          ...emptyCountryFieldConditions('address.billing.country'),
          ...emptyCountryFieldConditions('address.shipping.country'),
          { 'address.additionalShippingAddresses': { $elemMatch: emptyCountryElemMatch() } },
        ],
      },
    ],
  };
}

async function run() {
  const { apply, verbose } = parseArgs();
  let db;

  try {
    db = await getConnection();
    const customersColl = db.booksCrm.collection('customers');
    const candidates = await customersColl
      .find(baseMatchFilter())
      .project({
        _id: 1,
        companyId: 1,
        customerDisplayName: 1,
        companyName: 1,
        Role: 1,
        address: 1,
      })
      .toArray();

    const toUpdate = [];

    for (const doc of candidates) {
      const $set = buildUpdateFields(doc);
      if (Object.keys($set).length === 0) continue;
      toUpdate.push({ doc, $set });
    }

    const docCount = toUpdate.length;
    const fieldWrites = toUpdate.reduce((sum, row) => sum + Object.keys(row.$set).length, 0);

    console.log('--- Customer / vendor master address: empty country → India ---');
    console.log(`Documents matched by query: ${candidates.length}`);
    console.log(`Documents to update: ${docCount}`);
    console.log(`Total country fields to set (billing / shipping / additional): ${fieldWrites}`);

    if (verbose && toUpdate.length > 0) {
      console.log('\nSample (first 50):');

      toUpdate.slice(0, 50).forEach((row, i) => {
        const d = row.doc;
        const keys = Object.keys(row.$set).join(', ');
        console.log(
          `${i + 1}. _id=${d._id} companyId=${d.companyId ?? '-'} name=${d.customerDisplayName ?? d.companyName ?? '-'} customer=${!!d.Role?.isCustomer} vendor=${!!d.Role?.isVendor} set=[${keys}]`,
        );
      });
    }

    if (!apply) {
      console.log('\nDry-run only. Re-run with --apply to write changes.');
      return;
    }

    if (toUpdate.length === 0) {
      console.log('\n--apply set, but nothing to update.');
      return;
    }

    let modified = 0;

    for (let i = 0; i < toUpdate.length; i += BULK_CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + BULK_CHUNK_SIZE);
      const ops = chunk.map(({ doc, $set }) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set },
        },
      }));

      const res = await customersColl.bulkWrite(ops, { ordered: false });
      modified += res.modifiedCount ?? 0;
    }

    console.log(`\nBulk updates completed. modifiedCount (reported): ${modified}`);
    console.log('Done.');
  } finally {
    if (db?.client) {
      await db.client.close();
    }
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
