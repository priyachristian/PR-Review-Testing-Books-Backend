/**
 * Adds a COMPLAINTS ModuleSettings row (booksCrm.modulesettings) for Books companies
 * that don't have one yet, so complaint numbers can be generated from module settings.
 *
 * - With <companyId>: runs for that one company only
 * - Without <companyId>: all companies that have a books.userroles record
 * - Idempotent: skips companies that already have a COMPLAINTS row
 *
 * Run: node migrations/addComplaintsModuleSettings-remove.js                      (report, all eligible)
 *      node migrations/addComplaintsModuleSettings-remove.js <companyId>           (report, one company)
 *      node migrations/addComplaintsModuleSettings-remove.js --apply               (write, all eligible)
 *      node migrations/addComplaintsModuleSettings-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection, closeConnection } = require('../config/db');

const MODULE_NAME = 'COMPLAINTS';
const PREFIX = 'CMP-';
const STARTING_SEQUENCE = '0001';

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));

    if (companyArg && !ObjectId.isValid(companyArg)) {
      throw new Error(`Invalid companyId: ${companyArg}`);
    }
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL ELIGIBLE BOOKS COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    const moduleSettings = db.booksCrm.collection('modulesettings');

    const eligibleCompanyIds = targetCompanyId
      ? [targetCompanyId]
      : await db.books.collection('userroles').distinct('companyId', { companyId: { $ne: null } });

    const existing = await moduleSettings
      .find({ moduleName: MODULE_NAME, companyId: { $in: eligibleCompanyIds } })
      .project({ companyId: 1 })
      .toArray();
    const existingCompanyIds = new Set(existing.map(doc => doc.companyId.toString()));

    const missingCompanyIds = eligibleCompanyIds.filter(id => !existingCompanyIds.has(id.toString()));

    console.log(`Eligible companies            : ${eligibleCompanyIds.length}`);
    console.log(`Already have ${MODULE_NAME}    : ${existingCompanyIds.size}`);
    console.log(`Missing (would insert)        : ${missingCompanyIds.length}\n`);
    missingCompanyIds.forEach(id => console.log(`  ${id.toString()}  insert ${MODULE_NAME} (${PREFIX}${STARTING_SEQUENCE})`));

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to seed.\n');
      return;
    }

    if (!missingCompanyIds.length) {
      console.log('\nNothing to insert.\n');
      return;
    }

    const now = new Date();
    const result = await moduleSettings.insertMany(
      missingCompanyIds.map(companyId => ({
        useCustomPrefix: true,
        startingSequence: STARTING_SEQUENCE,
        nextSequence: STARTING_SEQUENCE,
        companyId,
        moduleName: MODULE_NAME,
        prefix: PREFIX,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      })),
      { ordered: false },
    );

    console.log(`\nInserted ${result.insertedCount} ${MODULE_NAME} module setting(s).\n`);
  } catch (error) {
    console.error('Complaints module settings seed failed:', error);
    process.exitCode = 1;
  } finally {
    await closeConnection(client);
  }
};

migrate();
