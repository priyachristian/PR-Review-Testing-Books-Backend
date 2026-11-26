/**
 * Seeds the standard set of payment terms for every company that is actually onboarded —
 * meaning it already has at least one userRole record in EITHER the crm or the books database.
 * A company that only exists in `common.companies` but was never provisioned with a user in
 * either product database is left untouched.
 *
 * Terms seeded (name -> days):
 *   Net 15 / Net 30 / Net 45 / Net 60 / Net 75  -> 15 / 30 / 45 / 60 / 75
 *   Due end of the month / Due end of next month -> 0 (the due date is computed from the
 *     calendar, not a day offset — see services/calculateDiscount.service.js) + isSystemGenerated
 *   Advance / After Dispatch / Due on Receipt -> 0 (due immediately, no offset)
 *   Due on Receipt is also marked isDefault.
 *
 * Only terms missing by name are inserted per company, so re-running is safe. If a company
 * already has a different payment term marked isDefault, the new "Due on Receipt" is inserted
 * as non-default instead, to avoid two defaults existing at once.
 *
 * Run: node migrations/seedDefaultPaymentTerms-remove.js                      (report, all eligible companies)
 *      node migrations/seedDefaultPaymentTerms-remove.js <companyId>           (report, one company)
 *      node migrations/seedDefaultPaymentTerms-remove.js --apply               (write, all eligible companies)
 *      node migrations/seedDefaultPaymentTerms-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PAYMENT_TERMS = [
  { name: 'Net 15', days: 15 },
  { name: 'Net 30', days: 30 },
  { name: 'Net 45', days: 45 },
  { name: 'Net 60', days: 60 },
  { name: 'Net 75', days: 75 },
  { name: 'Due end of the month', days: 0, isSystemGenerated: true },
  { name: 'Due end of next month', days: 0, isSystemGenerated: true },
  { name: 'Advance', days: 0, isSystemGenerated: true },
  { name: 'After Dispatch', days: 0, isSystemGenerated: true },
  { name: 'Due On Receipt', days: 0, isDefault: true, isSystemGenerated: true },
];

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL ELIGIBLE COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    const crmUserRoles = db.crm.collection('userroles');
    const booksUserRoles = db.books.collection('userroles');
    const paymentTerms = db.booksCrm.collection('paymentterms');

    const scopeMatch = targetCompanyId ? { companyId: targetCompanyId } : {};
    const [crmCompanyIds, booksCompanyIds] = await Promise.all([
      crmUserRoles.distinct('companyId', scopeMatch),
      booksUserRoles.distinct('companyId', scopeMatch),
    ]);
    const eligibleById = new Map([...crmCompanyIds, ...booksCompanyIds].map(id => [id.toString(), id]));
    const eligibleCompanyIds = [...eligibleById.values()];

    if (targetCompanyId && !eligibleCompanyIds.length) {
      console.log('This company has no userRole record in crm or books — nothing to do.\n');
      return;
    }

    console.log(`Eligible companies (userRole in crm or books): ${eligibleCompanyIds.length}\n`);

    let companiesPending = 0;
    let companiesWritten = 0;
    let termsPending = 0;
    let termsWritten = 0;
    const skippedDefault = [];
    const missingCreator = [];

    for (const companyId of eligibleCompanyIds) {
      const existing = await paymentTerms.find({ companyId }).project({ name: 1, isDefault: 1 }).toArray();
      const existingNames = new Set(existing.map(term => term.name));
      const missing = PAYMENT_TERMS.filter(term => !existingNames.has(term.name));
      if (!missing.length) continue;

      const hasDefault = existing.some(term => term.isDefault);
      const wantsDefault = missing.some(term => term.isDefault);
      if (wantsDefault && hasDefault) skippedDefault.push(companyId.toString());

      // Credited to whoever already has access to the company, the same way seeded test
      // documents borrow an existing "addedBy" instead of inventing a user. A company may only
      // have a userRole in one of the two databases, so fall back from crm to books.
      // eslint-disable-next-line no-await-in-loop
      const creator =
        (await crmUserRoles.findOne({ companyId }, { projection: { userId: 1 } })) ||
        // eslint-disable-next-line no-await-in-loop
        (await booksUserRoles.findOne({ companyId }, { projection: { userId: 1 } }));
      const createdBy = creator ? creator.userId : null;
      if (!createdBy) missingCreator.push(companyId.toString());

      const now = new Date();
      const docs = missing.map(term => ({
        companyId,
        name: term.name,
        days: term.days,
        isDefault: Boolean(term.isDefault) && !hasDefault,
        isActive: true,
        isSystemGenerated: Boolean(term.isSystemGenerated),
        createdBy,
        createdAt: now,
        updatedAt: now,
      }));

      termsPending += docs.length;
      companiesPending += 1;

      if (!apply) continue;

      // eslint-disable-next-line no-await-in-loop
      const result = await paymentTerms.insertMany(docs, { ordered: false });
      termsWritten += result.insertedCount;
      companiesWritten += 1;
    }

    console.log('COMPANIES MISSING ONE OR MORE PAYMENT TERMS');
    console.log(`   companies : ${companiesPending}`);
    console.log(`   terms     : ${termsPending}`);

    if (skippedDefault.length) {
      console.log(`\nALREADY HAS A DIFFERENT DEFAULT — "Due on Receipt" inserted as non-default (${skippedDefault.length})`);
      skippedDefault.slice(0, 20).forEach(id => console.log(`   ${id}`));
      if (skippedDefault.length > 20) console.log(`   ... and ${skippedDefault.length - 20} more`);
    }

    if (missingCreator.length) {
      console.log(`\nNO USERROLE FOUND TO CREDIT AS createdBy — inserted with createdBy: null (${missingCreator.length})`);
      missingCreator.slice(0, 20).forEach(id => console.log(`   ${id}`));
      if (missingCreator.length > 20) console.log(`   ... and ${missingCreator.length - 20} more`);
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to seed.\n');
      return;
    }

    console.log('\nWRITTEN');
    console.log(`   companies seeded : ${companiesWritten}`);
    console.log(`   terms inserted   : ${termsWritten}`);
    console.log('\nDefault payment terms seeded.\n');
  } catch (error) {
    console.error('Payment terms seed failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
