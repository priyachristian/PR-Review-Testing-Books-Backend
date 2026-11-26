// Gives every expense saved before the line rebuild the current fields, as a normal expense:
// one line from `expenseAccount` and `total`, no tax, not billable. Old journals already post `total` to that account.
// Run after renameExpenseFields.js (needs `party` and `total`).
// dry-run (all):     node migrations/migrateOldExpenses.js
// dry-run (company): node migrations/migrateOldExpenses.js --companyId=<id>
// apply (all):       node migrations/migrateOldExpenses.js --apply
// apply (company):   node migrations/migrateOldExpenses.js --companyId=<id> --apply
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const OLD_EXPENSE_QUERY = { $or: [{ lines: { $exists: false } }, { lines: { $size: 0 } }] };
const BATCH_SIZE = 500;
const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const parseArgs = argv => {
  const apply = argv.includes('--apply');
  const companyArg = argv.find(arg => arg.startsWith('--companyId='))?.slice('--companyId='.length);
  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }
  return { apply, companyId: companyArg ? new ObjectId(companyArg) : null };
};

const migrate = async () => {
  let client;
  try {
    const { apply, companyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;
    const companyFilter = companyId ? { companyId } : {};
    console.log(`Scope: ${companyId ? companyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode: APPLYING CHANGES' : 'Mode: dry run — pass --apply to write');

    const expenses = db.books.collection('expenses');
    const notRenamed = await expenses.countDocuments({
      ...companyFilter,
      $or: [{ customer: { $exists: true } }, { amount: { $exists: true } }],
    });
    if (notRenamed) {
      throw new Error(
        `${notRenamed} expenses still have customer/amount. Run renameExpenseFields.js --apply first. Nothing was written.`,
      );
    }

    const oldQuery = { ...companyFilter, ...OLD_EXPENSE_QUERY };
    const rows = await expenses
      .find(oldQuery)
      .project({
        companyId: 1,
        expenseId: 1,
        expenseAccount: 1,
        total: 1,
        party: 1,
        isRoundOff: 1,
        roundOffAmount: 1,
        divisionId: 1,
        branchId: 1,
        warehouseId: 1,
        date: 1,
        paidThroughAccountId: 1,
      })
      .toArray();
    console.log(`Expenses: ${await expenses.countDocuments(companyFilter)}, old (no lines): ${rows.length}`);

    // A party is a customer/vendor record, an Account Ledger (no party type), or empty.
    const partyIds = [...new Set(rows.filter(row => row.party instanceof ObjectId).map(row => String(row.party)))].map(
      id => new ObjectId(id),
    );
    const parties = await db.booksCrm
      .collection('customers')
      .find({ _id: { $in: partyIds } })
      .project({ Role: 1 })
      .toArray();
    const partyTypeById = new Map(
      parties.map(party => [String(party._id), party.Role?.isCustomer ? 'CUSTOMER' : party.Role?.isVendor ? 'VENDOR' : null]),
    );

    const companyIds = [...new Set(rows.map(row => String(row.companyId)))].map(id => new ObjectId(id));
    const companies = await db.common
      .collection('companies')
      .find({ _id: { $in: companyIds } })
      .project({ companyName: 1, name: 1 })
      .toArray();
    const companyNameById = new Map(companies.map(company => [String(company._id), company.companyName || company.name]));

    const updates = [];
    const skipped = [];
    const missingForEdit = [];
    const summary = new Map();

    for (const row of rows) {
      const label = `${companyNameById.get(String(row.companyId)) || row.companyId} ${row.expenseId || row._id}`;
      if (!(row.expenseAccount instanceof ObjectId)) {
        skipped.push(
          `${label}: expenseAccount is ${row.expenseAccount === undefined ? 'missing' : JSON.stringify(row.expenseAccount)}`,
        );
        continue;
      }
      if (typeof row.total !== 'number') {
        skipped.push(`${label}: total is ${row.total === undefined ? 'missing' : JSON.stringify(row.total)}`);
        continue;
      }

      const missing = ['divisionId', 'branchId', 'warehouseId', 'date', 'paidThroughAccountId'].filter(field => !row[field]);
      if (missing.length) missingForEdit.push(`${label}: ${missing.join(', ')}`);

      const total = round2(row.total);
      const set = {
        lines: [
          {
            accountId: row.expenseAccount,
            description: '',
            amount: total,
            baseAmount: total,
            gst: 'none',
            taxAmount: 0,
            supplyType: 'GOODS',
            hsnCode: '',
            isItcEligible: false,
            cost: total,
          },
        ],
        subTotal: total,
        cgst: 0,
        sgst: 0,
        igst: 0,
        totalTax: 0,
        eligibleTax: 0,
        expenseCost: total,
        isTaxInclusive: false,
        taxSplit: 'CGST_SGST',
        invoiceNo: null,
        invoiceDate: null,
        supplierGstin: null,
        tax: null,
        isRoundOff: row.isRoundOff === true,
        // The old journal posted the whole total to the expense account, so no separate rounding remains.
        roundOffAmount: 0,
        partyType: row.party instanceof ObjectId ? partyTypeById.get(String(row.party)) || null : null,
        isBillable: false,
        billableStatus: null,
        paidAmount: null,
        balanceAmount: null,
      };
      if (row.party === undefined) set.party = null;

      updates.push({ updateOne: { filter: { _id: row._id, ...oldQuery }, update: { $set: set } } });

      const companyName = companyNameById.get(String(row.companyId)) || String(row.companyId);
      const companySummary = summary.get(companyName) || {
        rows: 0,
        total: 0,
        roundOffCleared: 0,
        customer: 0,
        vendor: 0,
        noPartyType: 0,
      };
      companySummary.rows += 1;
      companySummary.total = round2(companySummary.total + total);
      if (Number(row.roundOffAmount)) companySummary.roundOffCleared += 1;
      if (set.partyType === 'CUSTOMER') companySummary.customer += 1;
      else if (set.partyType === 'VENDOR') companySummary.vendor += 1;
      else companySummary.noPartyType += 1;
      summary.set(companyName, companySummary);
    }

    console.log(
      '\nPer company (rows to update · sum of total = sum of expenseCost after · party type split · rows whose old roundOffAmount becomes 0):',
    );
    for (const [companyName, s] of [...summary.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
      console.log(
        `  ${companyName}: ${s.rows} rows · ${s.total} · customer ${s.customer}, vendor ${s.vendor}, ledger/none ${s.noPartyType} · roundOff cleared ${s.roundOffCleared}`,
      );
    }
    console.log(`\nTo update: ${updates.length}`);
    console.log(`Skipped (not changed): ${skipped.length}`);
    skipped.forEach(line => console.log(`  ${line}`));
    console.log(`Updated but missing a field Edit requires (user must fill it on edit): ${missingForEdit.length}`);
    missingForEdit.forEach(line => console.log(`  ${line}`));

    // Older code saved comments as 'EXPENSE', which the schema rejects, so Edit could not save those expenses.
    const badCommentQuery = { ...companyFilter, 'commentHistory.referenceType': 'EXPENSE' };
    console.log(
      `Expenses with comment referenceType 'EXPENSE' (set to 'Expense'): ${await expenses.countDocuments(badCommentQuery)}`,
    );

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply.');
      return;
    }

    let modified = 0;
    for (let start = 0; start < updates.length; start += BATCH_SIZE) {
      const result = await expenses.bulkWrite(updates.slice(start, start + BATCH_SIZE), { ordered: false });
      modified += result.modifiedCount;
    }
    console.log(`\nUpdated ${modified} expenses`);

    const comments = await expenses.updateMany(
      badCommentQuery,
      { $set: { 'commentHistory.$[comment].referenceType': 'Expense' } },
      { arrayFilters: [{ 'comment.referenceType': 'EXPENSE' }] },
    );
    console.log(`Fixed comment referenceType on ${comments.modifiedCount} expenses`);

    const leftOld = await expenses.countDocuments(oldQuery);
    const costCheck = await expenses
      .aggregate([
        { $match: { _id: { $in: updates.map(update => update.updateOne.filter._id) } } },
        { $group: { _id: null, total: { $sum: '$total' }, expenseCost: { $sum: '$expenseCost' } } },
      ])
      .toArray();
    console.log(`Left without lines: ${leftOld} (should equal skipped: ${skipped.length})`);
    console.log(
      `Updated rows: sum of total ${round2(costCheck[0]?.total)}, sum of expenseCost ${round2(costCheck[0]?.expenseCost)}`,
    );
  } finally {
    if (client) await client.close();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
