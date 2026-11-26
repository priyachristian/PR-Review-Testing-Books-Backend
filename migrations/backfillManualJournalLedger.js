/**
 * Posts ledger entries for manual journals created before the ledger wiring existed.
 *
 * A manual journal now writes LedgerEntry rows when it is saved, the same way an invoice or a
 * bill does. Journals from before that change live only as documents, so the moment reports
 * start reading the ledger they would vanish from the Trial Balance. This writes the missing
 * rows, one balanced journal per document, exactly as the service posts them today.
 *
 * A journal that already has ledger rows is skipped, so it can be re-run safely. A journal
 * whose lines do not balance is reported and skipped, never guessed at. Reports by default
 * and writes only with --apply.
 *
 * Run: node migrations/backfillManualJournalLedger.js                      (report, all companies)
 *      node migrations/backfillManualJournalLedger.js <companyId>           (report, one company)
 *      node migrations/backfillManualJournalLedger.js <companyId> --apply   (write)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PARTY_CATEGORIES = ['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE'];
const toPaise = value => Math.round((Number(value) || 0) * 100);

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;
    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};

    console.log(`\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(`Cluster: ${(process.env.ABSS_CLUSTER || '').replace(/\/\/.*@/, '//***@').split('/?')[0]}`);
    console.log(apply ? 'Mode: APPLYING CHANGES\n' : 'Mode: report only — pass --apply to write\n');

    const manualJournals = db.books.collection('manualjournals');
    const ledgerEntries = db.books.collection('ledgerentries');
    const accounts = db.books.collection('accounts');

    const journals = await manualJournals.find(scope).toArray();

    // Category per account, to tag the party on receivable/payable lines.
    const accountIds = [
      ...new Set(journals.flatMap(journal => (journal.journalEntries || []).map(entry => entry.accountId?.toString()))),
    ].filter(Boolean);
    const accountDocs = accountIds.length
      ? await accounts
          .find({ _id: { $in: accountIds.map(id => new ObjectId(id)) } })
          .project({ category: 1 })
          .toArray()
      : [];
    const categoryById = new Map(accountDocs.map(account => [account._id.toString(), account.category]));

    let posted = 0;
    let alreadyPosted = 0;
    const unbalanced = [];
    const missingAccount = [];

    for (const journal of journals) {
      const existing = await ledgerEntries.countDocuments({
        companyId: journal.companyId,
        sourceModule: 'MANUAL_JOURNAL',
        sourceId: journal._id,
      });
      if (existing > 0) {
        alreadyPosted += 1;
        continue;
      }

      const entries = journal.journalEntries || [];
      if (entries.length < 2) continue;

      let debits = 0;
      let credits = 0;
      let accountMissing = false;
      for (const entry of entries) {
        if (!entry.accountId) accountMissing = true;
        debits += toPaise(entry.debits);
        credits += toPaise(entry.credits);
      }
      if (accountMissing) {
        missingAccount.push(journal.manualJournalId);
        continue;
      }
      if (debits !== credits) {
        unbalanced.push({ id: journal.manualJournalId, debits: debits / 100, credits: credits / 100 });
        continue;
      }

      if (!apply) {
        posted += 1;
        continue;
      }

      const journalId = new ObjectId();
      const rows = entries.map(entry => {
        const category = categoryById.get(entry.accountId.toString());
        const party = PARTY_CATEGORIES.includes(category) && entry.businessAccountLedgerMasterId;
        return {
          companyId: journal.companyId,
          journalId,
          accountId: entry.accountId,
          postingDate: journal.date,
          debit: Number(entry.debits) || 0,
          credit: Number(entry.credits) || 0,
          sourceModule: 'MANUAL_JOURNAL',
          sourceId: journal._id,
          partyId: party ? entry.businessAccountLedgerMasterId : null,
          partyType: party ? (category === 'ACCOUNTS_RECEIVABLE' ? 'CUSTOMER' : 'VENDOR') : null,
          status: 'POSTED',
          narration: `Manual Journal ${journal.manualJournalId}`,
          addedBy: journal.addedBy || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });
      await ledgerEntries.insertMany(rows);
      posted += 1;
    }

    console.log('MANUAL JOURNALS');
    console.log(`   found                 : ${journals.length}`);
    console.log(`   ${apply ? 'posted to the ledger  ' : 'would post to ledger  '}: ${posted}`);
    console.log(`   already in the ledger : ${alreadyPosted}`);
    console.log(`   skipped, unbalanced   : ${unbalanced.length}`);
    console.log(`   skipped, no account   : ${missingAccount.length}`);
    unbalanced.slice(0, 10).forEach(row => console.log(`     ${row.id}  Dr ${row.debits} vs Cr ${row.credits}`));
    missingAccount.slice(0, 10).forEach(id => console.log(`     ${id}  has a line without an account`));

    if (!apply) console.log('\nNothing was written. Re-run with --apply to backfill.\n');
  } catch (error) {
    console.error('Manual journal ledger backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
