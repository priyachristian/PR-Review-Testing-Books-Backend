/**
 * Remaps Expenses.expenseAccount when the COA row was deleted.
 *
 * Ledger posting / backfillLedgerEntries uses document.expenseAccount as the
 * debit side. If that Account no longer exists, reconcile shows bare ObjectIds
 * and the expense P&L posts to a ghost account.
 *
 * Fix strategy (per expense):
 *   1. If expenseAccount still exists in that company's accounts → leave it.
 *   2. Else use the first line item's purchaseInformation.purchaseAccountId
 *      (same accounts set by setServiceItemPurchaseAccounts.js).
 *   3. Else fall back to the company "Other Expenses" account.
 *
 * Run AFTER setServiceItemPurchaseAccounts.js for the company (so item purchase
 * accounts are already correct).
 *
 * Run: node migrations/fixOrphanExpenseAccounts.js                      (report, all companies)
 *      node migrations/fixOrphanExpenseAccounts.js --apply              (write, all companies)
 *      node migrations/fixOrphanExpenseAccounts.js <companyId>          (report, one company)
 *      node migrations/fixOrphanExpenseAccounts.js <companyId> --apply  (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PURCHASE_ACCOUNT_CATEGORIES = ['EXPENSE', 'COGS', 'OTHER_EXPENSE', 'FIXED_ASSET'];

const processCompany = async (db, companyId, apply) => {
  const accounts = await db.books.collection('accounts').find({ companyId }).project({ accountName: 1, category: 1 }).toArray();
  const accountById = new Map(accounts.map(a => [String(a._id), a]));

  const otherExpenses = accounts.find(
    a => a.accountName === 'Other Expenses' && PURCHASE_ACCOUNT_CATEGORIES.includes(a.category),
  );

  const expenses = await db.books.collection('expenses').find({ companyId }).toArray();

  const itemIds = [
    ...new Set(
      expenses.flatMap(exp =>
        (exp.items || [])
          .map(line => line.itemId)
          .filter(Boolean)
          .map(String),
      ),
    ),
  ].map(id => new ObjectId(id));

  const items = itemIds.length
    ? await db.booksCrm
        .collection('items')
        .find({ _id: { $in: itemIds } })
        .project({ name: 1, itemName: 1, purchaseInformation: 1 })
        .toArray()
    : [];
  const itemById = new Map(items.map(item => [String(item._id), item]));

  const rows = [];
  let wouldFix = 0;
  let alreadyOk = 0;
  let cannotFix = 0;
  let skippedNoFallback = 0;

  for (const expense of expenses) {
    const currentId = expense.expenseAccount ? String(expense.expenseAccount) : null;
    const currentAccount = currentId ? accountById.get(currentId) : null;

    if (currentId && currentAccount) {
      alreadyOk += 1;
      continue;
    }

    const firstLine = (expense.items || [])[0];
    const item = firstLine?.itemId ? itemById.get(String(firstLine.itemId)) : null;
    const fromItemId = item?.purchaseInformation?.purchaseAccountId ? String(item.purchaseInformation.purchaseAccountId) : null;
    const fromItemAccount = fromItemId ? accountById.get(fromItemId) : null;

    let nextId = null;
    let nextName = null;
    let via = null;

    if (fromItemAccount && PURCHASE_ACCOUNT_CATEGORIES.includes(fromItemAccount.category)) {
      nextId = fromItemId;
      nextName = fromItemAccount.accountName;
      via = 'item.purchaseAccountId';
    } else if (otherExpenses) {
      nextId = String(otherExpenses._id);
      nextName = otherExpenses.accountName;
      via = 'fallback Other Expenses';
    }

    if (!nextId) {
      cannotFix += 1;
      if (!otherExpenses) skippedNoFallback += 1;
      rows.push({
        expenseId: expense.expenseId || String(expense._id),
        date: expense.date,
        amount: expense.amount,
        itemName: firstLine?.itemName || item?.name || item?.itemName || '—',
        from: currentId || '(null)',
        to: '—',
        via: otherExpenses ? 'CANNOT FIX' : 'NO Other Expenses account — seed system accounts',
      });
      continue;
    }

    wouldFix += 1;
    rows.push({
      expenseId: expense.expenseId || String(expense._id),
      date: expense.date,
      amount: expense.amount,
      itemName: firstLine?.itemName || item?.name || item?.itemName || '—',
      from: currentId || '(null)',
      to: `${nextName} (${nextId})`,
      via,
    });

    if (apply) {
      await db.books
        .collection('expenses')
        .updateOne({ _id: expense._id }, { $set: { expenseAccount: new ObjectId(nextId), updatedAt: new Date() } });
    }
  }

  return { expenses: expenses.length, alreadyOk, wouldFix, cannotFix, skippedNoFallback, rows };
};

const migrate = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));

    const db = await getConnection();
    client = db.client;

    console.log(apply ? 'Mode: APPLYING CHANGES\n' : 'Mode: report only — pass --apply to write\n');

    let companyIds;
    if (companyArg) {
      companyIds = [new ObjectId(companyArg.trim())];
      console.log(`Scope: one company ${companyIds[0]}\n`);
    } else {
      companyIds = (await db.books.collection('expenses').distinct('companyId', { companyId: { $ne: null } })).map(id =>
        id instanceof ObjectId ? id : new ObjectId(String(id)),
      );
      console.log(`Scope: all companies with expenses (${companyIds.length})\n`);
    }

    const totals = { companies: 0, expenses: 0, alreadyOk: 0, wouldFix: 0, cannotFix: 0 };

    for (const companyId of companyIds) {
      const result = await processCompany(db, companyId, apply);
      totals.companies += 1;
      totals.expenses += result.expenses;
      totals.alreadyOk += result.alreadyOk;
      totals.wouldFix += result.wouldFix;
      totals.cannotFix += result.cannotFix;

      if (!result.wouldFix && !result.cannotFix) continue;

      console.log(`\n======== company ${companyId} — expenses ${result.expenses} ========`);
      if (result.rows.length) {
        console.log(
          `${'EXPENSE'.padEnd(18)}${'DATE'.padEnd(12)}${'AMOUNT'.padStart(10)}  ${'ITEM'.padEnd(32)}${'FROM'.padEnd(26)} → TO`,
        );
        for (const row of result.rows) {
          const dateLabel = row.date ? new Date(row.date).toISOString().slice(0, 10) : '—';
          console.log(
            `${String(row.expenseId).slice(0, 17).padEnd(18)}${dateLabel.padEnd(12)}${String(row.amount ?? '').padStart(10)}  ${String(row.itemName).slice(0, 31).padEnd(32)}${String(row.from).slice(0, 25).padEnd(26)} → ${row.to} [${row.via}]`,
          );
        }
      }
      console.log(
        `  OK ${result.alreadyOk}  remap ${result.wouldFix}  cannot ${result.cannotFix}` +
          (result.skippedNoFallback ? ` (missing Other Expenses: ${result.skippedNoFallback})` : ''),
      );
    }

    console.log('\n======== TOTAL ========');
    console.log(`Companies scanned:               ${totals.companies}`);
    console.log(`Expenses scanned:                ${totals.expenses}`);
    console.log(`Already OK (live expenseAccount): ${totals.alreadyOk}`);
    console.log(`Would remap / remapped:           ${totals.wouldFix}`);
    console.log(`Cannot fix:                       ${totals.cannotFix}`);

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to update expenseAccount.');
      console.log(
        companyArg
          ? 'Then re-check: NODE_ENV=production node migrations/backfillLedgerEntries.js <companyId> --reconcile --only=EXPENSE\n'
          : 'Then re-check per company with backfillLedgerEntries.js <companyId> --reconcile --only=EXPENSE\n',
      );
    } else {
      console.log('\nUpdates written. Re-run ledger --reconcile --only=EXPENSE to confirm names appear.\n');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
  }
};

migrate();
