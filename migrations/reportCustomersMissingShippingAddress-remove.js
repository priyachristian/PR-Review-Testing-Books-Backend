/**
 * Report — and optionally fix — customers/vendors whose billing address is
 * filled in but whose shipping address has nothing set.
 *
 * "Filled in" means at least one address field (country, state, city, pinCode,
 * street1/street2, attention, phone, faxNumber) is non-empty. A bare $exists
 * check on `address.shipping` would under-report — the sub-document can be
 * present on a record (e.g. carrying just its own _id) while every field on
 * it is empty, which is functionally "no shipping address".
 *
 * By default this only reports. Pass --apply to also copy the billing address
 * onto the shipping address for every match — a fresh sub-document _id is
 * generated for the copy, mirroring how customerMaster.service.js assigns a
 * new _id whenever it sets address.shipping.
 *
 * Run: node migrations/reportCustomersMissingShippingAddress-remove.js                      (report, all companies)
 *      node migrations/reportCustomersMissingShippingAddress-remove.js <companyId>          (report, one company)
 *      node migrations/reportCustomersMissingShippingAddress-remove.js --apply              (report + apply, all companies)
 *      node migrations/reportCustomersMissingShippingAddress-remove.js <companyId> --apply  (report + apply, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const ADDRESS_FIELDS = ['attention', 'country', 'city', 'state', 'pinCode', 'faxNumber', 'phone'];

const hasMeaningfulAddress = addr => {
  if (!addr) return false;
  if (ADDRESS_FIELDS.some(field => String(addr[field] ?? '').trim() !== '')) return true;
  return String(addr.address?.street1 ?? '').trim() !== '' || String(addr.address?.street2 ?? '').trim() !== '';
};

const formatAddress = addr =>
  [addr.address?.street1, addr.address?.street2, addr.city, addr.state, addr.country, addr.pinCode].filter(Boolean).join(', ');

const buildShippingFromBilling = billing => ({
  _id: new ObjectId(),
  attention: billing.attention,
  country: billing.country,
  address: {
    street1: billing.address?.street1,
    street2: billing.address?.street2,
  },
  city: billing.city,
  state: billing.state,
  pinCode: billing.pinCode,
  faxNumber: billing.faxNumber,
  phone: billing.phone,
});

const report = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const shouldApply = args.includes('--apply');
    const companyArg = args.find(arg => arg !== '--apply');
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;
    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};
    console.log(
      `\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}   mode: ${shouldApply ? 'REPORT + APPLY' : 'REPORT ONLY'}\n`,
    );

    // Coarse filter in Mongo (billing sub-document present at all), then refine
    // in JS since "meaningful" vs. "empty-but-present" can't be expressed cleanly
    // as a single query across every address field.
    const candidates = await db.booksCrm
      .collection('customers')
      .find({ ...scope, 'address.billing': { $exists: true, $ne: null } })
      .project({
        customerNumber: 1,
        customerDisplayName: 1,
        companyId: 1,
        Role: 1,
        'address.billing': 1,
        'address.shipping': 1,
      })
      .toArray();

    const matches = candidates.filter(
      customer => hasMeaningfulAddress(customer.address?.billing) && !hasMeaningfulAddress(customer.address?.shipping),
    );

    if (!matches.length) {
      console.log('No records found: every customer with a billing address also has a shipping address.\n');
      return;
    }

    const companies = await db.common
      .collection('companies')
      .find({
        _id: {
          $in: [...new Set(matches.map(customer => customer.companyId?.toString()))].filter(Boolean).map(id => new ObjectId(id)),
        },
      })
      .project({ name: 1 })
      .toArray();
    const companyNameById = new Map(companies.map(company => [company._id.toString(), company.name]));

    matches.forEach((customer, index) => {
      const role = `${customer.Role?.isCustomer ? 'customer' : ''} ${customer.Role?.isVendor ? 'vendor' : ''}`.trim() || '-';
      console.log(`${index + 1}. ${customer.customerNumber || '(no number)'}  —  ${customer.customerDisplayName || '(no name)'}`);
      console.log(`   _id     : ${customer._id.toString()}`);
      console.log(`   company : ${companyNameById.get(customer.companyId?.toString()) || customer.companyId}`);
      console.log(`   role    : ${role}`);
      console.log(`   billing : ${formatAddress(customer.address.billing) || '(no readable fields)'}`);
      console.log('');
    });

    console.log('SUMMARY');
    console.log(`   billing present, shipping missing : ${matches.length}`);

    if (shouldApply) {
      const bulkOps = matches.map(customer => ({
        updateOne: {
          filter: { _id: customer._id },
          update: { $set: { 'address.shipping': buildShippingFromBilling(customer.address.billing) } },
        },
      }));
      const result = await db.booksCrm.collection('customers').bulkWrite(bulkOps);
      console.log(`   shipping addresses copied         : ${result.modifiedCount}`);
    } else {
      console.log('   Nothing was written. Pass --apply to copy billing onto shipping for these records.');
    }
    console.log('');
  } catch (error) {
    console.error('Report failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

report();
