/**
 * Points every customer and vendor at their own company's receivable or payable account.
 *
 * The account field on a customer is filled in and locked on screen, so anyone created or edited
 * from now on already carries the right one. Older rows were written before that: they either
 * carry nothing, or they point at a legacy account that belongs to no company at all. Either way
 * the ledger cannot resolve them, and every invoice or bill for that partner refuses to post.
 *
 *   a customer  -> the company's ACCOUNTS_RECEIVABLE account
 *   a vendor    -> the company's ACCOUNTS_PAYABLE account
 *
 * A partner that is both is treated as a customer, matching what the screen fills in when the
 * record is opened from the customer side. They are counted separately below so the choice is
 * visible rather than silent.
 *
 * Only a row that is not already on the right account is written, so re-running changes nothing.
 * A company whose system accounts have not been seeded is reported and skipped, never guessed at.
 *
 * Run AFTER seedMissingSystemAccounts.js, which creates the accounts this points at.
 *
 * Run: node migrations/backfillPartyControlAccounts.js                      (report, all companies)
 *      node migrations/backfillPartyControlAccounts.js <companyId>           (report, one company)
 *      node migrations/backfillPartyControlAccounts.js --apply               (write, all companies)
 *      node migrations/backfillPartyControlAccounts.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    if (targetCompanyId && isCompanyExcluded(targetCompanyId)) {
      console.log(`Company ${targetCompanyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
      return;
    }

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(`Cluster: ${(process.env.ABSS_CLUSTER || '').replace(/\/\/.*@/, '//***@').split('/?')[0]}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');
    if (!targetCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}\n`);
    }

    const customers = db.booksCrm.collection('customers');
    const accounts = db.books.collection('accounts');
    const companyMatch = targetCompanyId
      ? { _id: targetCompanyId }
      : excludedObjectIds.length
        ? { _id: { $nin: excludedObjectIds } }
        : {};
    const companies = await db.common.collection('companies').find(companyMatch).project({ name: 1, companyName: 1 }).toArray();

    let customersPending = 0;
    let vendorsPending = 0;
    let customersWritten = 0;
    let vendorsWritten = 0;
    let bothRoles = 0;
    let alreadyCorrect = 0;
    const skipped = [];

    for (const company of companies) {
      const companyId = company._id;
      const total = await customers.countDocuments({ companyId });
      if (!total) continue;

      const [receivable, payable] = await Promise.all([
        accounts.findOne({ companyId, systemAccountKey: 'ACCOUNTS_RECEIVABLE', isActive: true }),
        accounts.findOne({ companyId, systemAccountKey: 'ACCOUNTS_PAYABLE', isActive: true }),
      ]);

      if (!receivable || !payable) {
        skipped.push({
          name: company.name || company.companyName || '(unnamed)',
          id: companyId,
          missing: [!receivable ? 'ACCOUNTS_RECEIVABLE' : null, !payable ? 'ACCOUNTS_PAYABLE' : null].filter(Boolean).join(', '),
        });
        continue;
      }

      // Both roles on one record settle through receivables, the same as the screen does.
      const customerFilter = { companyId, 'Role.isCustomer': true, accountId: { $ne: receivable._id } };
      const vendorFilter = { companyId, 'Role.isCustomer': { $ne: true }, accountId: { $ne: payable._id } };

      const [needCustomer, needVendor, both, correct] = await Promise.all([
        customers.countDocuments(customerFilter),
        customers.countDocuments(vendorFilter),
        customers.countDocuments({ companyId, 'Role.isCustomer': true, 'Role.isVendor': true }),
        customers.countDocuments({
          companyId,
          $or: [
            { 'Role.isCustomer': true, accountId: receivable._id },
            { 'Role.isCustomer': { $ne: true }, accountId: payable._id },
          ],
        }),
      ]);

      customersPending += needCustomer;
      vendorsPending += needVendor;
      bothRoles += both;
      alreadyCorrect += correct;

      if (!apply) continue;

      if (needCustomer) {
        const result = await customers.updateMany(customerFilter, { $set: { accountId: receivable._id } });
        customersWritten += result.modifiedCount;
      }
      if (needVendor) {
        const result = await customers.updateMany(vendorFilter, { $set: { accountId: payable._id } });
        vendorsWritten += result.modifiedCount;
      }
    }

    console.log('PARTIES POINTING AT THE WRONG ACCOUNT, OR NONE');
    console.log(`   customers -> receivable : ${customersPending}`);
    console.log(`   vendors   -> payable    : ${vendorsPending}`);
    console.log(`   already correct         : ${alreadyCorrect}`);
    console.log(`   customer and vendor both: ${bothRoles}  (settled through receivables)`);

    if (skipped.length) {
      console.log(`\nCOMPANIES SKIPPED — system accounts not seeded yet (${skipped.length})`);
      skipped
        .slice(0, 20)
        .forEach(row => console.log(`   ${row.name.slice(0, 40).padEnd(42)} [${row.id}]  missing ${row.missing}`));
      if (skipped.length > 20) console.log(`   ... and ${skipped.length - 20} more`);
      console.log('\n   Run migrations/seedMissingSystemAccounts.js <companyId> --apply for these, then re-run.');
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    console.log('\nWRITTEN');
    console.log(`   customers set to receivable : ${customersWritten}`);
    console.log(`   vendors set to payable      : ${vendorsWritten}`);
    console.log('\nParty control accounts backfilled.\n');
  } catch (error) {
    console.error('Party control account backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
