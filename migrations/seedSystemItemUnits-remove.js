/**
 * Seeds the standard item units (isSystemGenerated: true) for every company that is actually
 * onboarded — meaning it already has at least one userRole record in EITHER the crm or the books
 * database. A company that only exists in `common.companies` is left untouched.
 *
 * The unit name is the same code stored on `items.itemUnit` (NOS, PCS, KGS, ...), so existing
 * items line up with their unit.
 *
 * Re-running is safe: units are matched by name (case-insensitive) per company. A missing unit is
 * inserted; a unit that already exists (even a user created "pcs") is skipped and left untouched.
 *
 * Run: node migrations/seedSystemItemUnits-remove.js                      (report, all eligible companies)
 *      node migrations/seedSystemItemUnits-remove.js <companyId>           (report, one company)
 *      node migrations/seedSystemItemUnits-remove.js --apply               (write, all eligible companies)
 *      node migrations/seedSystemItemUnits-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const SYSTEM_ITEM_UNITS = [
  'NOS',
  'PCS',
  'BOX',
  'KGS',
  'GMS',
  'MTR',
  'FT',
  'LTR',
  'MLT',
  'OTH',
  'BTL',
  'CAN',
  'CMS',
  'DOZ',
  'CTN',
  'MTS',
  'PAS',
  'PRS',
  'QTL',
  'ROL',
  'SET',
  'TBS',
  'TON',
  'TUB',
  'UNT',
  'YDS',
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
    const itemUnits = db.booksCrm.collection('itemunits');

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

    const companiesPending = new Set();
    let unitsToInsert = 0;
    let unitsSkipped = 0;
    let unitsInserted = 0;

    for (const companyId of eligibleCompanyIds) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await itemUnits.find({ companyId }).project({ name: 1 }).toArray();
      const existingByName = new Map(existing.map(unit => [unit.name.trim().toUpperCase(), unit]));

      // Units that already exist for the company (same name, any flags) are skipped untouched.
      const missing = SYSTEM_ITEM_UNITS.filter(name => !existingByName.has(name));
      unitsSkipped += SYSTEM_ITEM_UNITS.length - missing.length;
      if (!missing.length) continue;

      companiesPending.add(companyId.toString());
      unitsToInsert += missing.length;

      if (!apply) continue;

      const now = new Date();
      // eslint-disable-next-line no-await-in-loop
      const result = await itemUnits.insertMany(
        missing.map(name => ({
          companyId,
          name,
          addedBy: new ObjectId('6a68481d2b62fdf1296b7ea6'), // system user
          isSystemGenerated: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })),
        { ordered: false },
      );
      unitsInserted += result.insertedCount;
    }

    console.log('COMPANIES MISSING ONE OR MORE SYSTEM UNITS');
    console.log(`   companies       : ${companiesPending.size}`);
    console.log(`   units to insert : ${unitsToInsert}`);
    console.log(`   units skipped   : ${unitsSkipped}  (already exist, left untouched)`);

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to seed.\n');
      return;
    }

    console.log('\nWRITTEN');
    console.log(`   units inserted : ${unitsInserted}`);
    console.log('\nSystem item units seeded.\n');
  } catch (error) {
    console.error('System item unit seed failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
