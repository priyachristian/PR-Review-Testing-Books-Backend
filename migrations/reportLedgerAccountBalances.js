/**
 * Daily ledger health: every chart-of-accounts account, CURRENT vs EXPECTED, and a reason
 * for every paisa of DIFF.
 *
 * CURRENT   live LedgerEntry balances (isSplit: false — same as getAccountBalances)
 * EXPECTED  every document that should post today, rebuilt with the same post*Journal
 *           functions the app uses, then rolled back. Manual journals and other modules
 *           this runner does not rebuild are taken from the stored ledger, so they do not
 *           look like a mismatch.
 * DIFF      CURRENT minus EXPECTED. + is more debit (or less credit) in the live books
 *           than today's posting would leave.
 *
 * This never writes. Posting, deleting leftover journals, and other database fixes stay on
 * backfillLedgerEntries.js and the dedicated -remove scripts.
 *
 * Omitting <companyId> prints every company by name.
 *
 * Run: node migrations/reportLedgerAccountBalances.js
 *      node migrations/reportLedgerAccountBalances.js <companyId>
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const mongoose = require('mongoose');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `reportLedgerAccountBalances_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);

const stringifyLogArg = arg => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 4 }));
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
console.log = (...args) => {
  originalConsoleLog(...args);
  try {
    fs.appendFileSync(LOG_FILE, `${args.map(stringifyLogArg).join(' ')}\n`);
  } catch {
    // Logging to disk must never break the report itself.
  }
};
console.error = (...args) => {
  originalConsoleError(...args);
  try {
    fs.appendFileSync(LOG_FILE, `[ERROR] ${args.map(stringifyLogArg).join(' ')}\n`);
  } catch {
    // same as above
  }
};

const {
  bootstrap,
  buildModules,
  runModulesForCompany,
  addExpectedSource,
  netBalance,
  formatAmount,
  round2,
  printModuleSummary,
} = require('./backfillLedgerEntries');

const ADVANCE_NARRATION = /applied to|application removed/i;

const sourceKey = (sourceModule, sourceId) => `${sourceModule}|${String(sourceId)}`;

const parseSourceKey = key => {
  const cut = key.indexOf('|');
  return { sourceModule: key.slice(0, cut), sourceId: key.slice(cut + 1) };
};

const getByPath = (document, field) => {
  let value = document;
  for (const part of field.split('.')) {
    value = value?.[part];
  }
  return value;
};

const linesAt = (document, field) => {
  const value = getByPath(document, field);
  return Array.isArray(value) ? value : [];
};

const clauseMatches = (value, clause) => {
  if (clause && typeof clause === 'object' && !Array.isArray(clause) && !(clause instanceof Date) && !clause._bsontype) {
    if ('$in' in clause) return clause.$in.some(option => String(option) === String(value));
    if ('$ne' in clause) {
      if (clause.$ne === null) return value != null;
      if (Array.isArray(clause.$ne) && clause.$ne.length === 0) return Array.isArray(value) ? value.length > 0 : Boolean(value);
      return String(value) !== String(clause.$ne);
    }
    if ('$exists' in clause) {
      const exists = value !== undefined && value !== null;
      return clause.$exists ? exists : !exists;
    }
  }
  return value === clause || String(value) === String(clause);
};

const matchesFilter = (document, filter) => {
  if (!filter || !Object.keys(filter).length) return true;
  return Object.entries(filter).every(([field, clause]) => clauseMatches(getByPath(document, field), clause));
};

const netOnAccount = (bySource, key, accountId) => netBalance(bySource.get(key)?.get(accountId));

const ownerSpecsFor = models => ({
  INVOICE: [{ Model: models.books.Invoice, select: 'invoiceId status customerId', lineArrays: [] }],
  BILL: [{ Model: models.books.Bill, select: 'billId status vendor', lineArrays: [] }],
  GRPO: [{ Model: models.books.GrpoOrder, select: 'grpoOrderId status', lineArrays: [] }],
  CREDIT_NOTE: [
    { Model: models.books.CreditNote, select: 'creditNoteId status customerId refunds._id', lineArrays: ['refunds'] },
  ],
  DEBIT_NOTE: [{ Model: models.books.DebitNote, select: 'debitNoteId status vendorId refunds._id', lineArrays: ['refunds'] }],
  EXPENSE: [{ Model: models.books.Expenses, select: 'expenseId', lineArrays: [] }],
  PRODUCTION: [
    {
      Model: models.books.ProductionOrder,
      select: 'productionOrderCode status submissionHistory._id processBased.processes._id',
      lineArrays: ['submissionHistory', 'processBased.processes'],
    },
  ],
  MANUAL_JOURNAL: [{ Model: models.books.ManualJournal, select: 'manualJournalId', lineArrays: ['journalEntries'] }],
  INVENTORY_ADJUSTMENT: [{ Model: models.books.InventoryAdjustment, select: 'inventoryAdjustmentNumber status', lineArrays: [] }],
  BANK_TRANSFER: [
    { Model: models['books-crm'].BankTransferLog, select: 'transactionStatus transactionDescription date', lineArrays: [] },
  ],
  PAYMENT_RECEIVED: [
    {
      Model: models['books-crm'].PaymentReceived,
      select:
        'paymentReceivedId status customerId depositToAccountId bankId invoices._id openingBalanceTransactions._id refunds._id',
      lineArrays: ['invoices', 'openingBalanceTransactions', 'refunds'],
    },
  ],
  PAYMENT_MADE: [
    {
      Model: models.books.PaymentMade,
      select: 'paymentMadeId status vendorId paidThroughAccountId bankId bills._id openingBalanceTransactions._id refunds._id',
      lineArrays: ['bills', 'openingBalanceTransactions', 'refunds'],
    },
  ],
  OPENING_BALANCE: [
    { Model: models.books.AccountOpeningBalance, select: 'accountId isActive openingBalanceDate', lineArrays: [] },
  ],
  OPENING_BALANCE_PARTY: [
    { Model: models['books-crm'].OpeningBalanceTransaction, select: 'transactionNo type contactId', lineArrays: [] },
  ],
  OPENING_STOCK: [{ Model: models['books-crm'].Item, select: 'itemNo itemName inventoryAccountId', lineArrays: [] }],
  DELIVERY_CHALLAN: [
    { Model: models.books.DeliveryChallan, select: 'challanId status customerId items.batches', lineArrays: [] },
  ],
});

const documentLabel = (sourceModule, document) => {
  if (!document) return sourceModule;
  return (
    document.invoiceId ||
    document.billId ||
    document.grpoOrderId ||
    document.creditNoteId ||
    document.debitNoteId ||
    document.expenseId ||
    document.productionOrderCode ||
    document.manualJournalId ||
    document.inventoryAdjustmentNumber ||
    document.paymentReceivedId ||
    document.paymentMadeId ||
    document.transactionNo ||
    document.itemNo ||
    document.challanId ||
    document.transactionDescription ||
    String(document._id).slice(-8)
  );
};

const nestKindForArray = (sourceModule, array) => {
  if (array === 'refunds') return 'refund';
  if (array === 'submissionHistory') return 'production_submission';
  if (array === 'processBased.processes') return 'production_process';
  if (sourceModule === 'PAYMENT_RECEIVED' || sourceModule === 'PAYMENT_MADE') return 'advance_line';
  return 'line';
};

const loadCurrentBySource = async (LedgerEntry, companyId) => {
  const rows = await LedgerEntry.aggregate([
    { $match: { companyId, isSplit: false } },
    {
      $group: {
        _id: { sourceModule: '$sourceModule', sourceId: '$sourceId', accountId: '$accountId' },
        debit: { $sum: '$debit' },
        credit: { $sum: '$credit' },
        narration: { $first: '$narration' },
      },
    },
  ]).allowDiskUse(true);

  const bySource = new Map();
  const narrations = new Map();
  for (const row of rows) {
    addExpectedSource(bySource, row._id.sourceModule, row._id.sourceId, row._id.accountId, row.debit, row.credit);
    const key = sourceKey(row._id.sourceModule, row._id.sourceId);
    if (!narrations.has(key) && row.narration) narrations.set(key, row.narration);
  }
  return { bySource, narrations };
};

const PAYMENT_LINE_ARRAYS = ['invoices', 'bills', 'openingBalanceTransactions', 'refunds'];

const rememberPaymentFamily = (paymentFamilies, sourceModule, document) => {
  if (sourceModule !== 'PAYMENT_RECEIVED' && sourceModule !== 'PAYMENT_MADE') return;
  const members = [String(document._id)];
  for (const array of PAYMENT_LINE_ARRAYS) {
    for (const line of linesAt(document, array)) {
      if (line?._id) members.push(String(line._id));
    }
  }
  const meta = { parentId: String(document._id), label: documentLabel(sourceModule, document), members, sourceModule };
  for (const id of members) paymentFamilies.set(`${sourceModule}|${id}`, meta);
};

const loadOwnerIndex = async (sourceIdsByModule, models) => {
  const specs = ownerSpecsFor(models);
  const index = new Map();
  const paymentFamilies = new Map();

  for (const [sourceModule, idSet] of sourceIdsByModule.entries()) {
    const ids = [...idSet];
    const objectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id));
    const owners = specs[sourceModule] || [];

    for (const owner of owners) {
      if (!owner.Model || !objectIds.length) continue;

      const parents = await owner.Model.find({ _id: { $in: objectIds } })
        .select(owner.select)
        .lean();
      for (const document of parents) {
        index.set(sourceKey(sourceModule, document._id), {
          found: true,
          nestKind: null,
          parentId: String(document._id),
          label: documentLabel(sourceModule, document),
          status: document.status || document.transactionStatus || null,
          document,
        });
        rememberPaymentFamily(paymentFamilies, sourceModule, document);
      }

      if (!owner.lineArrays.length) continue;

      const lineFilter = owner.lineArrays.map(array => ({ [`${array}._id`]: { $in: objectIds } }));
      const holders = await owner.Model.find({ $or: lineFilter }).select(owner.select).lean();
      for (const document of holders) {
        for (const array of owner.lineArrays) {
          for (const line of linesAt(document, array)) {
            if (!line?._id || !idSet.has(String(line._id))) continue;
            const key = sourceKey(sourceModule, line._id);
            if (index.has(key)) continue;
            index.set(key, {
              found: true,
              nestKind: nestKindForArray(sourceModule, array),
              parentId: String(document._id),
              label: documentLabel(sourceModule, document),
              status: document.status || document.transactionStatus || null,
              document,
            });
          }
        }
        rememberPaymentFamily(paymentFamilies, sourceModule, document);
      }
    }
  }

  return { index, paymentFamilies };
};

const loadProductionFamilies = async (models, companyId, sourceIds) => {
  if (!sourceIds.length) return new Map();
  const orders = await models.books.ProductionOrder.find({
    companyId,
    $or: [
      { _id: { $in: sourceIds } },
      { 'submissionHistory._id': { $in: sourceIds } },
      { 'processBased.processes._id': { $in: sourceIds } },
    ],
  })
    .select('productionOrderCode submissionHistory._id processBased.processes._id')
    .lean();

  const familyById = new Map();
  for (const order of orders) {
    const members = [String(order._id)];
    for (const entry of order.submissionHistory || []) {
      if (entry?._id) members.push(String(entry._id));
    }
    for (const entry of order.processBased?.processes || []) {
      if (entry?._id) members.push(String(entry._id));
    }
    for (const id of members) {
      familyById.set(id, { orderId: String(order._id), label: order.productionOrderCode, members });
    }
  }
  return familyById;
};

const storedVsTodayWhy = (sourceModule, stored, expected) => {
  if (sourceModule === 'OPENING_STOCK') {
    if (!expected) {
      return "opening stock is valued from warehouse openingStock × rate (item-inventory rate, or that warehouse's opening batch price when the rate was never stored); that value is 0, but the stored journal remains";
    }
    return "opening stock is valued from warehouse openingStock × rate (item-inventory rate, or that warehouse's opening batch price when the rate was never stored); the stored journal does not match that opening";
  }
  if (sourceModule === 'GRPO' && !expected) {
    return 'GRPO posting follows current batches; none remain, so today posts nothing, but the stored journal remains';
  }
  if (sourceModule === 'PRODUCTION') {
    return 'live journals are keyed to submission/process ids; today posts one journal per order from current batches — keying and/or batch cost changed';
  }
  if (sourceModule === 'INVOICE' || sourceModule === 'BILL' || sourceModule === 'CREDIT_NOTE' || sourceModule === 'DEBIT_NOTE') {
    return 'today rebuilds amounts with calculateAmounts and current item/line accounts (an item income/expense account can move after the stored journal was written)';
  }
  if (sourceModule === 'BANK_TRANSFER') {
    return 'a rate not stored on the transfer is read from the currency master as it stands today';
  }
  if (sourceModule === 'PAYMENT_RECEIVED' || sourceModule === 'PAYMENT_MADE') {
    return 'today rebuilds the payment journal from current applied/unused amounts (advance apply journals are not replayed)';
  }
  if (!stored) return 'today would post this account; the stored journal does not';
  if (!expected) return 'the stored journal hits this account; today would not';
  return "stored amount on this account does not match what today's post function writes";
};

const ineligibleWhy = (sourceModule, owner) => {
  const status = owner.status;
  if (status === 'CANCELLED') {
    return sourceModule === 'BANK_TRANSFER'
      ? 'transfer is CANCELLED — cancel today deletes the journal, but this row was left behind (the document still exists, so the orphan remover will not touch it)'
      : `document status is CANCELLED, so today does not post, but the journal is still in the ledger`;
  }
  if (
    sourceModule === 'BANK_TRANSFER' ||
    sourceModule === 'PAYMENT_RECEIVED' ||
    sourceModule === 'PAYMENT_MADE' ||
    sourceModule === 'INVENTORY_ADJUSTMENT'
  ) {
    return `status is ${status || '(missing)'}, not APPROVED — today does not post`;
  }
  if (sourceModule === 'DELIVERY_CHALLAN') {
    return 'challan is cancelled or has no batches, so today does not post a stock journal';
  }
  return status ? `status ${status} is outside the posting gate` : 'document is outside the posting gate';
};

const classifyGroup = async ({
  sourceModule,
  keys,
  accountId,
  currentBySource,
  expectedBySource,
  currentSources,
  expectedSources,
  ownerIndex,
  narrations,
  modules,
  familyMeta,
}) => {
  const stored = round2(keys.reduce((sum, key) => sum + netOnAccount(currentBySource, key, accountId), 0));
  const expected = round2(keys.reduce((sum, key) => sum + netOnAccount(expectedBySource, key, accountId), 0));
  const effect = round2(stored - expected);
  if (Math.abs(effect) < 0.01) return null;

  const hasCurrent = keys.some(key => currentSources.has(key));
  const hasExpected = keys.some(key => expectedSources.has(key));
  const primaryKey =
    keys.find(key => Math.abs(netOnAccount(currentBySource, key, accountId)) >= 0.01) ||
    keys.find(key => Math.abs(netOnAccount(expectedBySource, key, accountId)) >= 0.01) ||
    keys[0];
  const { sourceId: primarySourceId } = parseSourceKey(primaryKey);
  const owner = ownerIndex.get(primaryKey) || ownerIndex.get(keys[0]) || { found: false };
  const narration = narrations.get(primaryKey) || keys.map(key => narrations.get(key) || '').join(' ');
  const label = familyMeta?.label || owner.label || primarySourceId.slice(-8);
  const idForRef = familyMeta?.parentId || familyMeta?.orderId || primarySourceId;
  const docRef = `${sourceModule} ${label} [${idForRef}]`;

  const hasApplyLine = keys.some(key => {
    const nest = ownerIndex.get(key)?.nestKind;
    return nest === 'advance_line' || ADVANCE_NARRATION.test(narrations.get(key) || '');
  });
  if ((sourceModule === 'PAYMENT_RECEIVED' || sourceModule === 'PAYMENT_MADE') && hasApplyLine) {
    return {
      kind: 'ADVANCE_APPLY',
      effect,
      text: `${docRef}  stored ${formatAmount(stored)} vs expected ${formatAmount(expected)} — apply/remove journals are keyed to line ids and are not replayed; the payment journal is rebuilt from current applied/unused. This leftover does not net to zero on this account`,
    };
  }

  if (hasCurrent && hasExpected) {
    return {
      kind: 'STORED_VS_TODAY',
      effect,
      text: `${docRef}  stored ${formatAmount(stored)} vs expected ${formatAmount(expected)} — ${storedVsTodayWhy(sourceModule, stored, expected)}`,
    };
  }

  if (hasExpected && !hasCurrent) {
    return {
      kind: 'MISSING_FROM_LEDGER',
      effect,
      text: `${docRef}  expected ${formatAmount(expected)}, nothing stored — eligible document has no journal (backfillLedgerEntries.js --apply)`,
    };
  }

  if (ADVANCE_NARRATION.test(narration) || owner.nestKind === 'advance_line') {
    return {
      kind: 'ADVANCE_APPLY',
      effect,
      text: `${docRef}  stored ${formatAmount(stored)} vs expected ${formatAmount(expected)} — apply/remove journal keyed to a payment line id (not replayed; would double AR/AP if rebuilt)`,
    };
  }

  if (!owner.found) {
    return {
      kind: 'ORPHAN',
      effect,
      text: `${sourceModule} ${primarySourceId}  ${formatAmount(effect)}  source document is gone; journal was left behind (removeOrphanLedgerEntries-remove.js)`,
    };
  }

  const parentModules = modules.filter(module => (module.sourceModule || module.name) === sourceModule);
  const parentModule = parentModules.find(module => !module.perUnit) || parentModules[0];
  if (parentModule?.skip && owner.document && !owner.nestKind) {
    const outcome = await parentModule.skip(owner.document);
    if (outcome) {
      const reason = typeof outcome === 'string' ? outcome : outcome.reason;
      return {
        kind: 'SKIPPED',
        effect,
        text: `${docRef}  ${formatAmount(effect)}  replay skipped — ${reason}. Stored journal remains`,
      };
    }
  }

  if (owner.document && parentModule && !owner.nestKind && !matchesFilter(owner.document, parentModule.filter)) {
    return {
      kind: 'INELIGIBLE',
      effect,
      text: `${docRef}  ${formatAmount(effect)}  ${ineligibleWhy(sourceModule, owner)}`,
    };
  }

  if (familyMeta) {
    return {
      kind: 'STORED_VS_TODAY',
      effect,
      text: `${docRef}  stored ${formatAmount(stored)} vs expected ${formatAmount(expected)} — ${storedVsTodayWhy('PRODUCTION', stored, expected)}`,
    };
  }

  return {
    kind: 'STORED_VS_TODAY',
    effect,
    text: `${docRef}  stored ${formatAmount(stored)} vs expected ${formatAmount(expected)} — ${storedVsTodayWhy(sourceModule, stored, expected)}`,
  };
};

const explainAccount = async ({
  accountId,
  diff,
  currentBySource,
  expectedBySource,
  ownerIndex,
  narrations,
  modules,
  productionFamilies,
  paymentFamilies,
}) => {
  const currentSources = new Set(currentBySource.keys());
  const expectedSources = new Set(expectedBySource.keys());
  const candidateKeys = new Set();
  for (const key of [...currentSources, ...expectedSources]) {
    if (Math.abs(netOnAccount(currentBySource, key, accountId)) >= 0.01) candidateKeys.add(key);
    if (Math.abs(netOnAccount(expectedBySource, key, accountId)) >= 0.01) candidateKeys.add(key);
  }

  const visited = new Set();
  const reasons = [];

  for (const key of candidateKeys) {
    if (visited.has(key)) continue;
    const { sourceModule, sourceId } = parseSourceKey(key);

    if (sourceModule === 'PRODUCTION') {
      const family = productionFamilies.get(sourceId);
      const memberIds = family?.members || [sourceId];
      const keys = memberIds.map(id => sourceKey('PRODUCTION', id));
      keys.forEach(memberKey => visited.add(memberKey));
      const reason = await classifyGroup({
        sourceModule,
        keys,
        accountId,
        currentBySource,
        expectedBySource,
        currentSources,
        expectedSources,
        ownerIndex,
        narrations,
        modules,
        familyMeta: family || null,
      });
      if (reason) reasons.push(reason);
      continue;
    }

    if (sourceModule === 'PAYMENT_RECEIVED' || sourceModule === 'PAYMENT_MADE') {
      const family = paymentFamilies.get(key);
      const memberIds = family?.members || [sourceId];
      const keys = memberIds.map(id => sourceKey(sourceModule, id));
      keys.forEach(memberKey => visited.add(memberKey));
      const reason = await classifyGroup({
        sourceModule,
        keys,
        accountId,
        currentBySource,
        expectedBySource,
        currentSources,
        expectedSources,
        ownerIndex,
        narrations,
        modules,
        familyMeta: family || null,
      });
      if (reason) reasons.push(reason);
      continue;
    }

    visited.add(key);
    const reason = await classifyGroup({
      sourceModule,
      keys: [key],
      accountId,
      currentBySource,
      expectedBySource,
      currentSources,
      expectedSources,
      ownerIndex,
      narrations,
      modules,
      familyMeta: null,
    });
    if (reason) reasons.push(reason);
  }

  const explained = round2(reasons.reduce((sum, reason) => sum + reason.effect, 0));
  const unexplained = round2(diff - explained);
  if (Math.abs(unexplained) >= 0.01) {
    reasons.push({
      kind: 'UNEXPLAINED',
      effect: unexplained,
      text: `${formatAmount(unexplained)}  not traced to a source journal — inspect ledgerentries for this account`,
    });
  }

  reasons.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  return reasons;
};

const printBalanceTable = rows => {
  console.log('\nACCOUNT BALANCES — debit minus credit: + is a debit balance, - is a credit balance');
  console.log('   CURRENT   ledger balance today');
  console.log("   EXPECTED  same journals rebuilt with today's posting functions (rolled back)");
  console.log('   DIFF      CURRENT minus EXPECTED\n');
  console.log(`${'ACCOUNT'.padEnd(34)}${'CURRENT'.padStart(18)}${'EXPECTED'.padStart(18)}${'DIFF'.padStart(18)}`);
  for (const row of rows) {
    console.log(
      `${row.name.slice(0, 33).padEnd(34)}${formatAmount(row.current).padStart(18)}${formatAmount(row.expected).padStart(18)}${formatAmount(row.diff).padStart(18)}`,
    );
  }
};

const printReasons = (mismatches, reasonsByAccount) => {
  console.log('\n' + '─'.repeat(72));
  console.log("WHY EACH DIFF EXISTS — effects on an account must sum to that account's DIFF");
  console.log('─'.repeat(72));

  if (!mismatches.length) {
    console.log('\nEvery chart account matches EXPECTED. Nothing to justify.');
    return;
  }

  for (const row of mismatches) {
    const reasons = reasonsByAccount.get(row.accountId) || [];
    console.log(`\n${row.name}   DIFF ${formatAmount(row.diff)}`);
    console.log(`   CURRENT ${formatAmount(row.current)}   EXPECTED ${formatAmount(row.expected)}`);
    if (!reasons.length) {
      console.log('   (no source split)');
      continue;
    }
    reasons.forEach((reason, index) => {
      console.log(
        `   ${String(index + 1).padStart(2)}.  ${formatAmount(reason.effect).padStart(14)}  [${reason.kind}]  ${reason.text}`,
      );
    });
    const summed = round2(reasons.reduce((sum, reason) => sum + reason.effect, 0));
    console.log(`   ${' '.repeat(4)}  ${formatAmount(summed).padStart(14)}  sum of reasons`);
  }
};

const reportCompany = async ({ company, rawConnection, ledgerService, LedgerEntry, Account, models, modules }) => {
  const companyId = company._id;
  console.log(`\n${'='.repeat(72)}`);
  console.log(`Company: ${company.name || '(unnamed)'}  [${company._id}]`);
  console.log('='.repeat(72));

  const { summary, failures, expectedFromPosting, expectedBySource } = await runModulesForCompany(companyId, modules, {
    rawConnection,
    LedgerEntry,
    booksCrm: models['books-crm'],
    shouldPost: true,
    verify: false,
    reconcile: true,
    concurrency: 8,
  });

  printModuleSummary(summary, failures, { apply: false, verify: false, reconcile: true });

  const ledgerNow = await ledgerService.getAccountBalances({ companyId });
  const accounts = await Account.find({ companyId }).select('accountName').lean();
  const accountById = new Map(accounts.map(account => [String(account._id), account]));
  const rowKeys = new Set([...accounts.map(account => String(account._id)), ...ledgerNow.keys(), ...expectedFromPosting.keys()]);

  const rows = [...rowKeys]
    .map(accountId => {
      const account = accountById.get(accountId);
      const current = netBalance(ledgerNow.get(accountId));
      const expected = netBalance(expectedFromPosting.get(accountId));
      return {
        accountId,
        name: account ? account.accountName : `(unknown account ${accountId.slice(-8)})`,
        current,
        expected,
        diff: round2(current - expected),
        orphan: !account,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  printBalanceTable(rows);

  const orphans = rows.filter(row => row.orphan);
  if (orphans.length) {
    console.log(`\n   ${orphans.length} account(s) referenced by journals do not exist in the chart of accounts.`);
  }

  const mismatches = rows.filter(row => Math.abs(row.diff) >= 0.01);
  console.log(
    mismatches.length
      ? `\n   ${mismatches.length} account(s) where CURRENT ≠ EXPECTED — reasons follow.`
      : '\n   Every chart account matches EXPECTED.',
  );

  const { bySource: currentBySource, narrations } = await loadCurrentBySource(LedgerEntry, companyId);

  const sourceIdsByModule = new Map();
  const remember = key => {
    const { sourceModule, sourceId } = parseSourceKey(key);
    if (!sourceIdsByModule.has(sourceModule)) sourceIdsByModule.set(sourceModule, new Set());
    sourceIdsByModule.get(sourceModule).add(sourceId);
  };
  for (const key of currentBySource.keys()) remember(key);
  for (const key of expectedBySource.keys()) remember(key);

  const [{ index: ownerIndex, paymentFamilies }, productionFamilies] = await Promise.all([
    loadOwnerIndex(sourceIdsByModule, models),
    loadProductionFamilies(
      models,
      companyId,
      [...(sourceIdsByModule.get('PRODUCTION') || [])]
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id)),
    ),
  ]);

  const reasonsByAccount = new Map();
  for (const row of mismatches) {
    const reasons = await explainAccount({
      accountId: row.accountId,
      diff: row.diff,
      currentBySource,
      expectedBySource,
      ownerIndex,
      narrations,
      modules,
      productionFamilies,
      paymentFamilies,
    });
    reasonsByAccount.set(row.accountId, reasons);
  }

  printReasons(mismatches, reasonsByAccount);
};

const run = async () => {
  console.log(`Log file: ${LOG_FILE}`);
  const args = process.argv.slice(2);
  const companyArg = args.find(arg => !arg.startsWith('--'));
  if (companyArg && !mongoose.Types.ObjectId.isValid(companyArg)) {
    console.error('Usage: node migrations/reportLedgerAccountBalances.js [<companyId>]');
    process.exit(1);
  }
  const companyId = companyArg ? new mongoose.Types.ObjectId(companyArg) : null;

  const rawConnection = await bootstrap();
  const ledgerService = require('../modules/accountant/ledger/ledger.service');
  const enums = require('../utils/enum');
  const modelService = require('../services/model.service');
  const { LedgerEntry, Account } = modelService.getBooksModels();
  const models = { books: modelService.getBooksModels(), common: modelService.getCommonModels() };
  models['books-crm'] = modelService.getBooksCrmModels();

  const targetCompanies = companyId
    ? await models.common.Company.find({ _id: companyId }).select('name').lean()
    : await models.common.Company.find({}).select('name').sort({ name: 1 }).lean();

  if (!targetCompanies.length) {
    console.log(companyId ? `No company found for ${companyId}.` : 'No companies found.');
    return;
  }

  console.log(`\nScope   : ${companyId ? companyId.toString() : 'ALL COMPANIES'}`);
  console.log('Mode    : report only — every journal is rebuilt and rolled back; nothing is written\n');

  const modules = buildModules(ledgerService, models, enums);

  for (const company of targetCompanies) {
    await reportCompany({
      company,
      rawConnection,
      ledgerService,
      LedgerEntry,
      Account,
      models,
      modules,
    });
  }

  console.log('\nThis report does not write. Database-side posting and cleanup:');
  console.log('   missing journals             node migrations/backfillLedgerEntries.js <companyId> --apply');
  console.log('   orphan journals              node migrations/removeOrphanLedgerEntries-remove.js up --companyId=<id>');
  console.log('   surplus advance reversals    node migrations/removeSurplusAdvanceReversals-remove.js up --companyId=<id>');
  console.log('   stale payment advances       node migrations/rebuildStalePaymentAdvanceLedgers-remove.js up --companyId=<id>');
  console.log('   cancelled bank transfers     node migrations/removeCancelledBankTransferLedgers-remove.js up --companyId=<id>');
  console.log('   stale GRPO journals          node migrations/removeStaleGrpoLedgers-remove.js up --companyId=<id>');
  console.log(`\nFull output was also written to: ${LOG_FILE}\n`);
};

console.time('reportLedgerAccountBalances');
run()
  .then(() => {
    console.timeEnd('reportLedgerAccountBalances');
    process.exit(0);
  })
  .catch(error => {
    console.error('Ledger balance report failed:', error);
    console.timeEnd('reportLedgerAccountBalances');
    process.exit(1);
  });
