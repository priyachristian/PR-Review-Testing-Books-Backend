/**
 * Posts ledger entries for documents raised before ledger posting existed.
 *
 * Sales, purchase, production and inventory documents from before this branch live only as
 * documents: they moved stock and money but never wrote a LedgerEntry row, so the chart of
 * accounts shows no closing balance for them. This writes the missing journals.
 *
 * WHY THIS REUSES THE APPLICATION CODE
 * The amounts must match what the app posts today, to the paisa. Rather than re-implementing
 * the posting rules (item account grouping, GRNI settlement, tax sides, round-off tolerance),
 * this boots the same model layer server.js builds and calls the real ledger.service.js
 * functions. There is one definition of what an invoice does to the ledger, and this uses it.
 *
 * WHAT IS POSTED, AND WHEN
 * Each module reproduces the exact gate its service applies, so a document that would not post
 * today does not post here either:
 *   Refunds        credit note, debit note, payment received, payment made (one per refund)
 *   Invoice        DRAFT / SENT / PARTIALLY_PAID / PAID / OVERDUE
 *   Bill           DRAFT / OPEN / PARTIALLY_PAID / PAID / OVERDUE
 *   Credit Note    DRAFT / OPEN / PARTIALLY_USED / USED / CLOSED
 *   Debit Note     DRAFT / OPEN / PARTIALLY_USED / USED / CLOSED
 *   GRPO           DRAFT / RECORDED / CONVERTED
 *   Delivery Chal  anything not CANCELLED, and only where the challan itself deducted stock
 *                  (its lines hold batches) — in invoice-mode challans there is nothing to post
 *   Expense        always (posts on create)
 *   Payment Rcvd   APPROVED, base currency only
 *   Payment Made   APPROVED, base currency only
 *   Bank Transfer  APPROVED, single currency only (no exchangeRate)
 *   Inventory Adj  APPROVED
 *   Production     any order that produced or consumed stock
 *   Opening Bal    account balances, customer/vendor balances, and item opening stock
 * A draft already moves stock and the party balance, so it posts as well and the three stay in
 * step with each other. Only a cancelled document posts nothing.
 * Foreign currency is posted, not skipped. Payments carry their own currency and rate, plus the
 * per-document rates the applied invoices/bills cleared at (appliedAt), so receivables and
 * payables clear at the rate they were raised at and the realized gain or loss reaches Exchange
 * Gain or Loss. Each leg of a bank transfer converts at its own rate, read from the currency
 * master exactly as bank.service.js does on approval, so a cross-currency transfer balances and
 * its spread lands in the same FX account. Payments with currency null/missing are treated as
 * base currency (legacy rows before currency was stamped on payment docs).
 * One caveat worth knowing: a rate that is not stored on the document is read from the currency
 * master as it stands today, so a transfer backfilled long after the fact converts at today's
 * rate rather than the rate on its own date.
 *
 * SAFETY
 *   - Counts by default; writes only with --apply.
 *   - Idempotent: a document that already has ledger rows is skipped, never posted twice.
 *   - One transaction per document, so a single bad document cannot half-write a journal or
 *     stop the run. Every failure is collected and printed with its reason.
 *   - Never edits the source document, stock, or batches — only inserts LedgerEntry rows.
 *   - Invoice / Bill / Credit Note / Debit Note posting amounts are rebuilt with the same
 *     arithmetic as frontend calculateAmounts (src/utils/services.js): qty × rate → discount →
 *     GST → charges → round-off. Stored DB totals that diverge from that are not used for the
 *     journal (that mismatch is what caused "Journal is not balanced"). The source document is
 *     never edited — only the in-memory posting view is.
 *   - Split documents (isSplit): tax lines are zeroed, same as calculateAmounts.
 *   - Everything printed to the console is also written, line by line, to a .txt file under
 *     migrations/logs/.
 *
 * PREREQUISITES (run these first, or documents will be reported as failures)
 *   - seedMissingSystemAccounts.js          system accounts must exist, per company
 *   - backfillItemAccounts.js               items need sales / inventory accounts
 *   - Customers and vendors need accountId  (bulk customer import sets this)
 *   NOTE: backfillItemAccounts.js deliberately does NOT set purchaseAccountId. Bills and debit
 *   notes with non-stock lines will fail until a purchase account is chosen on those items.
 *
 * Advance apply/remove journals are deliberately NOT replayed. Applying an advance also edits
 * the payment (it fills invoices[] and lowers unusedAmount), so rebuilding the payment journal
 * from the document as it stands already lands on the same net figures. Replaying them as well
 * would credit receivables twice.
 *
 * NOT COVERED — reported at the end so nothing looks complete when it is not:
 *   - MANUAL_JOURNAL   already has migrations/backfillManualJournalLedger.js
 *
 * Omitting <companyId> processes every company, printing each by name, then a GRAND TOTAL.
 *
 * Run: node migrations/backfillLedgerEntries.js                       (count, all companies)
 *      node migrations/backfillLedgerEntries.js <companyId>           (count, one company)
 *      node migrations/backfillLedgerEntries.js <companyId> --apply   (write)
 *      node migrations/backfillLedgerEntries.js --only=INVOICE        (one module)
 *      node migrations/backfillLedgerEntries.js --only=INVOICE,BILL --apply
 *
 * Daily CURRENT / EXPECTED / DIFF with reasons (read-only):
 *      node migrations/reportLedgerAccountBalances.js
 *      node migrations/reportLedgerAccountBalances.js <companyId>
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const mongoose = require('mongoose');
// Loaded first: it reads .env, and the models package validates ABSS_CLUSTER at import time.
const config = require('../config/config');
const { getModelsAndConnections } = require('@smit9313/abss-models-core');
const modelService = require('../services/model.service');
const { resolveTransactionCurrency } = require('../services/currencyResolver.service');

// Mirror every console.log/console.error to a .txt log file, written synchronously line by line
// so the full run is on disk even if the process crashes partway.
const LOG_DIR = path.join(__dirname, 'logs');
const isCli = require.main === module;
let LOG_FILE = null;
if (isCli) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  LOG_FILE = path.join(LOG_DIR, `backfillLedgerEntries_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
}

const stringifyLogArg = arg => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 4 }));
const appendToLogFile = (...args) => {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, `${args.map(stringifyLogArg).join(' ')}\n`);
  } catch {
    // Logging to disk must never break the migration itself.
  }
};

if (isCli) {
  const originalConsoleLog = console.log.bind(console);
  const originalConsoleError = console.error.bind(console);
  console.log = (...args) => {
    originalConsoleLog(...args);
    appendToLogFile(...args);
  };
  console.error = (...args) => {
    originalConsoleError(...args);
    appendToLogFile('[ERROR]', ...args);
  };
}

// Boot the same model layer server.js builds, so the application services work unchanged.
const bootstrap = async () => {
  const { models, connections } = await getModelsAndConnections(config.mongoose.db_names);
  modelService.setApp({
    locals: {
      db: {
        connections: {
          common: connections.common,
          booksCrm: connections['books-crm'],
          books: connections.books,
          crm: connections.crm,
          abssAdmin: connections['abss-admin'],
        },
        models: {
          common: models.common,
          booksCrm: models['books-crm'],
          books: models.books,
          crm: models.crm,
          abssAdmin: models['abss-admin'],
        },
        connection: connections.rawConnection,
      },
    },
  });
  return connections.rawConnection;
};

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const toNumber = (value, fallback = 0) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

const getGstNumericRate = gst => {
  if (gst == null || gst === '') return 0;
  const normalized = String(gst).trim().toLowerCase();
  return normalized === 'none' || normalized === 'exempted' ? 0 : toNumber(gst, 0);
};

const normalizeStateForTax = state => {
  if (!state || typeof state !== 'string') return '';
  return state
    .trim()
    .replace(/^\[[A-Z]{2,5}\]\s*-\s*/i, '')
    .trim()
    .toLowerCase();
};

const isInterStateParty = ({ companyState, partyState, companyGstin, partyGstin }) => {
  if (companyGstin && partyGstin) {
    return companyGstin.substring(0, 2) !== partyGstin.substring(0, 2);
  }
  const company = normalizeStateForTax(companyState);
  const party = normalizeStateForTax(partyState);
  if (!company || !party) return false;
  return company !== party;
};

const isAmountDiscountType = discountType => String(discountType || '').toUpperCase() === 'AMOUNT';

const itemDiscountFields = item => {
  const config = item?.discountConfig || {};
  return {
    discountType: item?.discountType || config.discountType,
    discountValue: item?.discountValue ?? config.discountValue,
  };
};

const documentDiscountFields = document => {
  const config = document?.discountConfig || {};
  return {
    appliesTo: document.appliesTo || config.appliesTo,
    discountType: document.discountType || config.discountType,
    discountValue: document.discountValue ?? config.discountValue,
  };
};

/**
 * Same arithmetic as frontend calculateAmounts (abss-books-frontend/src/utils/services.js).
 * Returns the figures the journal must use — not whatever mismatched totals sit on the DB row.
 */
const calculateDocumentAmounts = (document, { isIGST = false } = {}) => {
  const useCgstSgstSplit = !isIGST;
  const isSplit = Boolean(document.isSplit);
  const { appliesTo, discountType, discountValue } = documentDiscountFields(document);
  const charges = document.additionalCharges || document.additionalcharge || [];

  const computeLineGst = (taxableAmount, gstRate) => {
    if (!gstRate || isSplit) return 0;
    if (useCgstSgstSplit) {
      const cgstAmount = round2((taxableAmount * (gstRate / 2)) / 100);
      return round2(cgstAmount * 2);
    }
    return round2((taxableAmount * gstRate) / 100);
  };

  let items = (document.items || []).map(item => {
    const quantity = toNumber(item.quantity, 0);
    const rate = toNumber(item.rate, 0);
    const gstRate = getGstNumericRate(item.gst);
    let amount = round2(quantity * rate);

    const { discountType: itemDiscountType, discountValue: itemDiscountValue } = itemDiscountFields(item);
    if (appliesTo === 'ITEM' && !Number.isNaN(Number(itemDiscountValue)) && Number(itemDiscountValue) > 0) {
      if (isAmountDiscountType(itemDiscountType)) {
        amount = round2(amount - toNumber(itemDiscountValue, 0));
      } else {
        amount = round2(amount - (amount * toNumber(itemDiscountValue, 0)) / 100);
      }
    }

    const taxAmount = computeLineGst(amount, gstRate);
    return {
      ...item,
      amount,
      taxAmount: isSplit ? 0 : taxAmount,
    };
  });

  let subTotal = round2(items.reduce((sum, item) => sum + toNumber(item.amount, 0), 0));
  let gst = round2(items.reduce((sum, item) => sum + toNumber(item.taxAmount, 0), 0));
  let discountedSubTotal = subTotal;

  if (appliesTo === 'TRANSACTION' && !Number.isNaN(Number(discountValue)) && Number(discountValue) > 0) {
    const txnDiscount = toNumber(discountValue, 0);
    let updatedGst = 0;
    discountedSubTotal = 0;
    const totalItemAmount = subTotal;
    let distributedDiscount = 0;

    items = items.map((item, index) => {
      const itemAmount = toNumber(item.amount, 0);
      const gstRate = getGstNumericRate(item.gst);
      let taxableAmount = itemAmount;

      if (isAmountDiscountType(discountType)) {
        let proportionalDiscount = 0;
        if (index === items.length - 1) {
          proportionalDiscount = round2(txnDiscount - distributedDiscount);
        } else {
          proportionalDiscount = totalItemAmount > 0 ? round2((itemAmount / totalItemAmount) * txnDiscount) : 0;
          distributedDiscount = round2(distributedDiscount + proportionalDiscount);
        }
        taxableAmount = itemAmount - proportionalDiscount;
      } else {
        const itemDiscount = round2((itemAmount * txnDiscount) / 100);
        taxableAmount = Math.max(0, itemAmount - itemDiscount);
      }

      discountedSubTotal += taxableAmount;
      const taxAmount = computeLineGst(taxableAmount, gstRate);
      updatedGst += taxAmount;
      return { ...item, taxAmount: isSplit ? 0 : taxAmount };
    });

    gst = updatedGst;
  }

  let chargesTax = 0;
  let chargesTotal = 0;
  for (const charge of charges) {
    if (charge?.isTaxable && charge?.amount) {
      chargesTax += (toNumber(charge.amount, 0) * toNumber(charge.taxRate, 0)) / 100;
    }
    chargesTotal += toNumber(charge.amount, 0);
  }

  gst = round2(gst + (isSplit ? 0 : chargesTax));
  const preciseTotal = round2(discountedSubTotal + gst + chargesTotal);
  let roundOffAmount = 0;
  let total = preciseTotal;
  if (document.isRoundOff) {
    total = Math.round(preciseTotal);
    roundOffAmount = round2(total - preciseTotal);
  }

  const half = round2(gst / 2);
  return {
    items,
    subTotal,
    totalTax: gst,
    total,
    roundOffAmount,
    sgst: isSplit || !useCgstSgstSplit ? 0 : half,
    cgst: isSplit || !useCgstSgstSplit ? 0 : round2(gst - half),
    igst: isSplit || useCgstSgstSplit ? 0 : gst,
  };
};

const resolveDocumentIsIGST = async (document, models, cache) => {
  const companyId = String(document.companyId);
  if (!cache.companies.has(companyId)) {
    cache.companies.set(companyId, await models.common.Company.findById(document.companyId).select('address gstNumber').lean());
  }
  const company = cache.companies.get(companyId);

  const partyId = document.customerId || document.vendor || document.vendorId;
  const partyKey = partyId ? String(partyId) : null;
  if (partyKey && !cache.parties.has(partyKey)) {
    cache.parties.set(partyKey, await models['books-crm'].Customer.findById(partyId).select('otherDetails address').lean());
  }
  const party = partyKey ? cache.parties.get(partyKey) : null;

  return isInterStateParty({
    companyState: company?.address?.state,
    partyState: party?.address?.shipping?.state || party?.address?.billing?.state,
    companyGstin: company?.gstNumber,
    partyGstin: party?.otherDetails?.gstinUin || party?.otherDetails?.registeredBusinessValue,
  });
};

/**
 * In-memory posting view — calculateAmounts figures only. Does not write the DB.
 */
const buildLedgerPostingView = async (document, models, cache) => {
  const isIGST = document.isSplit ? false : await resolveDocumentIsIGST(document, models, cache);
  const amounts = calculateDocumentAmounts(document, { isIGST });
  return {
    ...document,
    items: amounts.items,
    subTotal: amounts.subTotal,
    totalTax: amounts.totalTax,
    total: amounts.total,
    roundOffAmount: amounts.roundOffAmount,
    sgst: amounts.sgst,
    cgst: amounts.cgst,
    igst: amounts.igst,
  };
};

// A party that cannot be resolved is a data fault, not a deliberate skip: the document belongs
// in the books and is missing from them. Returned as { hard: true } so it is reported as a
// failure to act on, rather than sitting under "skipped on purpose" where nobody looks.
// partyCache: Map<partyId, { accountId } | null> — preloaded per company to avoid N+1 finds.
const partySkipReason = async (document, partyField, booksCrm, partyCache = null) => {
  const partyId = document[partyField];
  if (!partyId) return { reason: 'party id missing on document', hard: true };
  const key = String(partyId);
  let party;
  if (partyCache && partyCache.has(key)) {
    party = partyCache.get(key);
  } else {
    party = await booksCrm.Customer.findOne({ _id: partyId, companyId: document.companyId }).select('accountId').lean();
    if (partyCache) partyCache.set(key, party || null);
  }
  if (!party) return { reason: 'Customer or vendor not found', hard: true };
  if (!party.accountId) return { reason: 'No receivable/payable account assigned on party', hard: true };
  return null;
};

// One aggregation instead of thousands of countDocuments: every (sourceModule, sourceId) that
// already has at least one LedgerEntry for this company.
const loadPostedSourceIds = async (LedgerEntry, companyId, sourceModules) => {
  const modules = [...new Set(sourceModules.filter(Boolean))];
  if (!modules.length) return new Map();

  const rows = await LedgerEntry.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(String(companyId)),
        sourceModule: { $in: modules },
      },
    },
    { $group: { _id: { sourceModule: '$sourceModule', sourceId: '$sourceId' } } },
  ]).allowDiskUse(true);

  const byModule = new Map();
  for (const row of rows) {
    const sourceModule = row._id.sourceModule;
    if (!byModule.has(sourceModule)) byModule.set(sourceModule, new Set());
    byModule.get(sourceModule).add(String(row._id.sourceId));
  }
  return byModule;
};

const preloadPartyCache = async (booksCrm, companyId) => {
  const parties = await booksCrm.Customer.find({ companyId }).select('_id accountId').lean();
  return new Map(parties.map(party => [String(party._id), party]));
};

// Run async work over items with a fixed parallelism. Order of results matches input order.
const mapWithConcurrency = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const limit = Math.max(1, Number(concurrency) || 1);

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

const isDocumentAlreadyPosted = (postedByModule, sourceModule, document, module) => {
  const posted = postedByModule.get(sourceModule) || new Set();
  if (!module.perUnit) return posted.has(String(document._id));
  const unitIds = module.unitIds ? module.unitIds(document) : [];
  if (!unitIds.length) return false;
  return unitIds.every(id => posted.has(String(id)));
};

const netBalance = totals => round2((totals?.debit || 0) - (totals?.credit || 0));

const addTotals = (map, accountId, debit, credit) => {
  if (!accountId) return;
  const key = String(accountId);
  const row = map.get(key) || { debit: 0, credit: 0 };
  row.debit = round2(row.debit + (Number(debit) || 0));
  row.credit = round2(row.credit + (Number(credit) || 0));
  map.set(key, row);
};

const addExpectedSource = (expectedBySource, sourceModule, sourceId, accountId, debit, credit) => {
  if (!expectedBySource || !sourceId) return;
  const key = `${sourceModule}|${String(sourceId)}`;
  let accountMap = expectedBySource.get(key);
  if (!accountMap) {
    accountMap = new Map();
    expectedBySource.set(key, accountMap);
  }
  addTotals(accountMap, accountId, debit, credit);
};

const formatAmount = value => {
  const num = round2(value);
  if (!num) return '0';
  return num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

const isSessionArtefact = error => /does not match any in-progress transactions/.test(error?.message || '');

/** Legacy payments still carry bankId (Bank collection); ledger needs Account id. */
const paymentAccountIdFromDocument = (document, accountField, bankToAccountId) => {
  if (document[accountField]) return document[accountField];
  const bankId = document.bankId || document._doc?.bankId;
  if (!bankId) return null;
  return bankToAccountId.get(String(bankId)) || null;
};

const sumPaymentApplied = (rows = []) => round2(rows.reduce((sum, row) => sum + (Number(row.amountApplied) || 0), 0));

// Each applied document cleared its balance at its own rate, so the payment journal needs that rate
// per part, not just the payment's own — exactly what paymentReceived/paymentMade.service.js build
// before posting. Without it a foreign-currency receipt clears AR at the wrong rate and the
// realized exchange gain or loss is never posted.
const buildAppliedAt = async (payment, applications, OpeningBalanceTransaction) => {
  const appliedAt = [];
  for (const applied of [
    ...applications,
    ...(payment.openingBalanceTransactions || []).map(({ openingBalanceTransactionId, amountApplied }) => ({
      id: openingBalanceTransactionId,
      amountApplied,
      Model: OpeningBalanceTransaction,
    })),
  ]) {
    const amount = Number(applied.amountApplied) || 0;
    if (!amount) continue;
    const document = await applied.Model.findById(applied.id).select('exchangeRate').lean();
    appliedAt.push({ amount, exchangeRate: document?.exchangeRate ?? payment.exchangeRate ?? 1 });
  }
  return appliedAt;
};

// Stock value a production order put in, and took out, read from the batches themselves so the
// cost is the one really paid rather than a re-derived estimate.
const productionStockMovements = async (ItemBatch, companyId, productionOrderId) => {
  const [created, consumedFrom] = await Promise.all([
    ItemBatch.find({ companyId, sourceType: 'PRODUCTION_ORDER', sourceId: productionOrderId })
      .select('itemId quantity purchasePrice')
      .lean(),
    ItemBatch.find({
      companyId,
      'deductions.deductedSourceType': 'PRODUCTION_ORDER',
      'deductions.deductedSourceId': productionOrderId,
    })
      .select('itemId purchasePrice deductions')
      .lean(),
  ]);

  const consumedByItem = {};
  for (const batch of consumedFrom) {
    for (const deduction of batch.deductions || []) {
      if (String(deduction.deductedSourceId) !== String(productionOrderId)) continue;
      if (deduction.deductedSourceType !== 'PRODUCTION_ORDER') continue;
      const key = String(batch.itemId);
      const cost = round2((Number(deduction.quantityDeducted) || 0) * (Number(batch.purchasePrice) || 0));
      consumedByItem[key] = round2((consumedByItem[key] || 0) + cost);
    }
  }

  return { created, consumedByItem };
};

// Rebuild the production posting from what was stored: finished goods and scrap from the batches
// the run created, materials from the batches it consumed, labour and overhead from the
// submissions or processes that recorded them.
const buildProductionArgs = (order, created, consumedByItem) => {
  const finishedGoodsBatches = created.filter(batch => String(batch.itemId) === String(order.itemId));
  const scrapBatches = created.filter(batch => String(batch.itemId) !== String(order.itemId));

  const fgQuantity = finishedGoodsBatches.reduce((sum, batch) => sum + (Number(batch.quantity) || 0), 0);
  const fgValue = round2(
    finishedGoodsBatches.reduce((sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0), 0),
  );

  const scrapByItem = {};
  for (const batch of scrapBatches) {
    const key = String(batch.itemId);
    const value = round2((Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0));
    scrapByItem[key] = round2((scrapByItem[key] || 0) + value);
  }

  // Labour, overhead and the rejected units' cost come from the same costing the live app posts with,
  // so a backfilled journal matches a live one. Required here, after setApp, like the ledger service.
  const {
    summarizeProcessRouteCost,
    computeBomBasedCostToDate,
  } = require('../modules/production/addProduction/productionOrder.service');
  const costing =
    order.productionManageMethod === 'PROCESS_ROUTE' ? summarizeProcessRouteCost(order) : computeBomBasedCostToDate(order);

  const submissions = order.submissionHistory || [];
  const lastSubmission = submissions[submissions.length - 1];

  return {
    companyId: order.companyId,
    sourceId: order._id,
    postingDate: lastSubmission?.submissionDate || order.productionDate || order.createdAt,
    narration: `Production ${order.productionOrderCode}`,
    finishedGoods: fgQuantity ? { itemId: order.itemId, quantity: fgQuantity, unitCost: fgValue / fgQuantity } : null,
    rawMaterials: Object.entries(consumedByItem).map(([itemId, cost]) => ({ itemId, cost })),
    labourCost: round2(costing.labourCost),
    overheadCost: round2(costing.overheadCost),
    scrap: Object.entries(scrapByItem).map(([itemId, value]) => ({ itemId, value })),
    productionLoss: costing.productionLoss,
    isClosedOut: ['COMPLETED', 'CLOSED'].includes(order.status),
  };
};

// What each module keeps, how to recognise a document that should have posted, and how to post it.
const buildModules = (ledgerService, models, enums) => {
  const {
    LEDGER_SOURCE_MODULES,
    LEDGER_PARTY_TYPES,
    INVOICE_STATUS,
    BILL_STATUSES,
    CREDIT_NOTE_STATUS,
    DEBIT_NOTE_STATUS,
    GRPO_STATUSES,
    DELIVERY_CHALLAN_STATUS,
    OB_TYPE_BALANCE,
    CONTACT_TYPE,
  } = enums;
  const { BALANCE_TYPES } = require('@smit9313/abss-models-core/src/utils/enum');
  const books = models.books;
  const booksCrm = models['books-crm'];
  const ledgerCache = { companies: new Map(), parties: new Map() };
  const bankToAccountId = new Map();
  let bankMapLoaded = false;
  // Filled once per company in runModulesForCompany — shared by every module skip handler.
  const partyCache = new Map();

  const ensureBankMap = async () => {
    if (bankMapLoaded) return bankToAccountId;
    bankMapLoaded = true;
    try {
      if (booksCrm.Bank) {
        const banks = await booksCrm.Bank.find({ accountId: { $ne: null } })
          .select('_id accountId')
          .lean();
        for (const bank of banks) {
          bankToAccountId.set(String(bank._id), bank.accountId);
        }
      }
    } catch (_) {
      // Skip stays honest: missing paidThroughAccountId is reported per payment.
    }
    return bankToAccountId;
  };

  const resolvePaymentAccountId = async (document, accountField) => {
    await ensureBankMap();
    const existing = paymentAccountIdFromDocument(document, accountField, bankToAccountId);
    if (existing) return existing;
    const bankId = document.bankId || document._doc?.bankId;
    if (!bankId) return null;
    // After bank→account merge, some legacy rows already store Account._id in bankId.
    const account = await books.Account.findById(bankId).select('_id').lean();
    return account?._id || null;
  };

  const partySkip = partyField => document => partySkipReason(document, partyField, booksCrm, partyCache);

  const moduleList = [
    {
      name: LEDGER_SOURCE_MODULES.DELIVERY_CHALLAN,
      model: books.DeliveryChallan,
      // Only challans that actually deducted stock hold batches, and only those have a journal to
      // post — in invoice-mode the challan moves nothing, so it is left out of the count entirely.
      filter: { status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED }, 'items.batches.0': { $exists: true } },
      label: document => `Delivery Challan ${document.challanId}`,
      post: (document, session) =>
        ledgerService.postDeliveryChallanJournal({ companyId: document.companyId, deliveryChallan: document }, session),
    },
    {
      name: LEDGER_SOURCE_MODULES.INVOICE,
      model: books.Invoice,
      filter: {
        status: {
          $in: [
            INVOICE_STATUS.DRAFT,
            INVOICE_STATUS.SENT,
            INVOICE_STATUS.PARTIALLY_PAID,
            INVOICE_STATUS.PAID,
            INVOICE_STATUS.OVERDUE,
          ],
        },
      },
      label: document => `Invoice ${document.invoiceId}`,
      skip: partySkip('customerId'),
      post: async (document, session) => {
        const invoice = await buildLedgerPostingView(document, models, ledgerCache);
        return ledgerService.postInvoiceJournal({ companyId: document.companyId, invoice }, session);
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.GRPO,
      model: books.GrpoOrder,
      filter: { status: { $in: [GRPO_STATUSES.DRAFT, GRPO_STATUSES.RECORDED, GRPO_STATUSES.CONVERTED] } },
      label: document => `GRPO ${document.grpoOrderId}`,
      post: (document, session) => ledgerService.postGrpoJournal({ companyId: document.companyId, grpo: document }, session),
    },
    {
      name: LEDGER_SOURCE_MODULES.BILL,
      model: books.Bill,
      filter: {
        status: {
          $in: [BILL_STATUSES.DRAFT, BILL_STATUSES.OPEN, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.PAID, BILL_STATUSES.OVERDUE],
        },
      },
      label: document => `Bill ${document.billId}`,
      skip: partySkip('vendor'),
      post: async (document, session) => {
        const bill = await buildLedgerPostingView(document, models, ledgerCache);
        return ledgerService.postBillJournal({ companyId: document.companyId, bill }, session);
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.CREDIT_NOTE,
      model: books.CreditNote,
      filter: {
        status: {
          $in: [
            CREDIT_NOTE_STATUS.DRAFT,
            CREDIT_NOTE_STATUS.OPEN,
            CREDIT_NOTE_STATUS.PARTIALLY_USED,
            CREDIT_NOTE_STATUS.USED,
            CREDIT_NOTE_STATUS.CLOSED,
          ],
        },
      },
      label: document => `Credit Note ${document.creditNoteId}`,
      skip: partySkip('customerId'),
      post: async (document, session) => {
        const creditNote = await buildLedgerPostingView(document, models, ledgerCache);
        return ledgerService.postCreditNoteJournal({ companyId: document.companyId, creditNote }, session);
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.DEBIT_NOTE,
      model: books.DebitNote,
      filter: {
        status: {
          $in: [
            DEBIT_NOTE_STATUS.DRAFT,
            DEBIT_NOTE_STATUS.OPEN,
            DEBIT_NOTE_STATUS.PARTIALLY_USED,
            DEBIT_NOTE_STATUS.USED,
            DEBIT_NOTE_STATUS.CLOSED,
          ],
        },
      },
      label: document => `Debit Note ${document.debitNoteId}`,
      skip: partySkip('vendorId'),
      post: async (document, session) => {
        const debitNote = await buildLedgerPostingView(document, models, ledgerCache);
        return ledgerService.postDebitNoteJournal({ companyId: document.companyId, debitNote }, session);
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.EXPENSE,
      model: books.Expenses,
      filter: {},
      label: document => `Expense ${document.expenseId}`,
      post: (document, session) =>
        ledgerService.postExpenseJournal(
          {
            companyId: document.companyId,
            expenseAccountId: document.expenseAccount,
            paidThroughAccountId: document.paidThroughAccountId,
            amount: document.amount,
            partyId: document.customer,
            postingDate: document.date,
            sourceId: document._id,
            narration: `Expense ${document.expenseId}`,
            currencyId: document.currency,
            exchangeRate: document.exchangeRate,
          },
          session,
        ),
    },
    {
      name: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED,
      model: booksCrm.PaymentReceived,
      filter: { status: 'APPROVED' },
      label: document => `Payment received ${document.paymentReceivedId}`,
      skip: async document => {
        await ensureBankMap();
        const depositAccountId = await resolvePaymentAccountId(document, 'depositToAccountId');
        if (!depositAccountId) {
          return 'missing depositToAccountId (legacy bankId not mapped — run renameAccountantModuleBankIds.js)';
        }
        return null;
      },
      post: async (document, session) => {
        const depositAccountId = await resolvePaymentAccountId(document, 'depositToAccountId');
        const appliedAmount = sumPaymentApplied(document.invoices) + sumPaymentApplied(document.openingBalanceTransactions);
        // Round unused so advance float-dust cannot create a 0-paise Unearned Revenue line.
        // Refunds keep their own entries, so the payment records what was unused before them.
        const unusedAmount = round2(
          Math.abs(Number(document.unusedAmount) || 0) +
            (document.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
        );
        const appliedAt = await buildAppliedAt(
          document,
          (document.invoices || []).map(({ invoiceId, amountApplied }) => ({
            id: invoiceId,
            amountApplied,
            Model: books.Invoice,
          })),
          booksCrm.OpeningBalanceTransaction,
        );
        return ledgerService.postPaymentReceivedJournal(
          {
            companyId: document.companyId,
            depositAccountId,
            appliedAmount,
            unusedAmount,
            partyId: document.customerId,
            postingDate: document.paymentDate,
            sourceId: document._id,
            narration: `Payment received ${document.paymentReceivedId}`,
            isSplit: document.isSplit,
            currencyId: document.currency,
            exchangeRate: document.exchangeRate,
            appliedAt,
          },
          session,
        );
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.PAYMENT_MADE,
      model: books.PaymentMade,
      filter: { status: 'APPROVED' },
      label: document => `Payment made ${document.paymentMadeId}`,
      skip: async document => {
        const paidThroughAccountId = await resolvePaymentAccountId(document, 'paidThroughAccountId');
        if (!paidThroughAccountId) {
          return 'missing paidThroughAccountId (legacy bankId not mapped — run renameAccountantModuleBankIds.js)';
        }
        return null;
      },
      post: async (document, session) => {
        const paidThroughAccountId = await resolvePaymentAccountId(document, 'paidThroughAccountId');
        const appliedAmount = sumPaymentApplied(document.bills) + sumPaymentApplied(document.openingBalanceTransactions);
        // Round unused so advance float-dust cannot create a 0-paise Prepaid Expenses line.
        // Refunds keep their own entries, so the payment records what was unused before them.
        const unusedAmount = round2(
          Math.abs(Number(document.unusedAmount) || 0) +
            (document.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
        );
        const appliedAt = await buildAppliedAt(
          document,
          (document.bills || []).map(({ billId, amountApplied }) => ({ id: billId, amountApplied, Model: books.Bill })),
          booksCrm.OpeningBalanceTransaction,
        );
        return ledgerService.postPaymentMadeJournal(
          {
            companyId: document.companyId,
            paidThroughAccountId,
            appliedAmount,
            unusedAmount,
            partyId: document.vendorId,
            postingDate: document.paymentDate,
            sourceId: document._id,
            narration: `Payment made ${document.paymentMadeId}`,
            isSplit: document.isSplit,
            currencyId: document.currency,
            exchangeRate: document.exchangeRate,
            appliedAt,
          },
          session,
        );
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.BANK_TRANSFER,
      model: booksCrm.BankTransferLog,
      filter: { transactionStatus: 'APPROVED' },
      label: document => `Bank transfer ${document._id}`,
      // Each leg carries its own currency and its own rate to base, so a cross-currency transfer
      // still balances and the conversion spread lands in Exchange Gain or Loss — the same call
      // bank.service.js makes on approval.
      post: async (document, session) => {
        const [toBase, fromBase] = await Promise.all([
          resolveTransactionCurrency({ companyId: document.companyId, currencyId: document.toCurrencyId }),
          resolveTransactionCurrency({ companyId: document.companyId, currencyId: document.fromCurrencyId }),
        ]);
        return ledgerService.postBankTransferJournal(
          {
            companyId: document.companyId,
            postingDate: document.date,
            sourceId: document._id,
            narration: document.transactionDescription,
            debitAccountId: document.toAccountId,
            debitAmount: document.toAmount || document.amount,
            debitCurrencyId: document.toCurrencyId,
            debitExchangeRate: toBase.exchangeRate,
            creditAccountId: document.fromAccountId,
            creditAmount: document.fromAmount || document.amount,
            creditCurrencyId: document.fromCurrencyId,
            creditExchangeRate: fromBase.exchangeRate,
          },
          session,
        );
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.INVENTORY_ADJUSTMENT,
      model: books.InventoryAdjustment,
      filter: { status: 'APPROVED' },
      label: document => `Inventory Adjustment ${document.inventoryAdjustmentNumber}`,
      // Stock in is the batches the adjustment created; stock out is what it consumed, valued at
      // the batch cost actually taken, so the journal matches the stock movement exactly.
      post: async (document, session) => {
        const { ItemBatch } = booksCrm;
        const [created, consumedFrom] = await Promise.all([
          ItemBatch.find({ companyId: document.companyId, sourceType: 'INVENTORY_ADJUSTMENT', sourceId: document._id })
            .select('itemId quantity purchasePrice')
            .session(session)
            .lean(),
          ItemBatch.find({
            companyId: document.companyId,
            'deductions.deductedSourceType': 'INVENTORY_ADJUSTMENT',
            'deductions.deductedSourceId': document._id,
          })
            .select('itemId purchasePrice deductions')
            .session(session)
            .lean(),
        ]);

        const stockInByItem = {};
        for (const batch of created) {
          const key = String(batch.itemId);
          const value = round2((Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0));
          stockInByItem[key] = round2((stockInByItem[key] || 0) + value);
        }

        const stockOutByItem = {};
        for (const batch of consumedFrom) {
          for (const deduction of batch.deductions || []) {
            if (String(deduction.deductedSourceId) !== String(document._id)) continue;
            if (deduction.deductedSourceType !== 'INVENTORY_ADJUSTMENT') continue;
            const key = String(batch.itemId);
            const value = round2((Number(deduction.quantityDeducted) || 0) * (Number(batch.purchasePrice) || 0));
            stockOutByItem[key] = round2((stockOutByItem[key] || 0) + value);
          }
        }

        await ledgerService.postAdjustmentJournal(
          {
            companyId: document.companyId,
            adjustment: document,
            stockIn: Object.entries(stockInByItem).map(([itemId, value]) => ({ itemId, value })),
            stockOut: Object.entries(stockOutByItem).map(([itemId, value]) => ({ itemId, value })),
          },
          session,
        );
      },
    },
    {
      name: LEDGER_SOURCE_MODULES.PRODUCTION,
      model: books.ProductionOrder,
      filter: {},
      label: document => `Production ${document.productionOrderCode}`,
      // The live code posts one journal per submission, but batches record only the order they
      // belong to, so a finished run cannot be split back into its submissions. One journal per
      // order is posted instead: the account totals are identical, only the grouping differs.
      post: async (document, session) => {
        // The live app posts one journal per submission or process, keyed to that submission's id;
        // this posts one per order. An order the app has already posted therefore carries rows the
        // parent-id check cannot see, and posting again would double it. Check those ids too.
        const submissionIds = (document.submissionHistory || []).map(entry => entry._id).filter(Boolean);
        const processIds = (document.processBased?.processes || []).map(entry => entry._id).filter(Boolean);
        const priorIds = [...submissionIds, ...processIds];
        if (priorIds.length) {
          const alreadyPosted = await books.LedgerEntry.countDocuments({
            companyId: document.companyId,
            sourceModule: LEDGER_SOURCE_MODULES.PRODUCTION,
            sourceId: { $in: priorIds },
          }).session(session);
          if (alreadyPosted) return;
        }

        const { created, consumedByItem } = await productionStockMovements(booksCrm.ItemBatch, document.companyId, document._id);
        if (!created.length && !Object.keys(consumedByItem).length) return;
        await ledgerService.postProductionJournal(buildProductionArgs(document, created, consumedByItem), session);
      },
    },

    // Refunds move real money and the parent document's own journal never touches cash, so each
    // refund carries its own journal keyed to the refund's id. That is why these are per-unit:
    // one document can hold several, and each has to be judged on its own.
    {
      name: 'CREDIT_NOTE_REFUND',
      sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE,
      model: books.CreditNote,
      filter: { refunds: { $exists: true, $ne: [] } },
      perUnit: true,
      unitIds: document => (document.refunds || []).map(refund => refund._id),
      label: document => `Credit Note ${document.creditNoteId} refunds`,
      post: async (document, session) => {
        for (const refund of document.refunds || []) {
          const already = await books.LedgerEntry.countDocuments({
            companyId: document.companyId,
            sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE,
            sourceId: refund._id,
          }).session(session);
          if (already) continue;
          await ledgerService.postCreditNoteRefundJournal(
            {
              companyId: document.companyId,
              fromAccountId: refund.fromAccountId,
              amount: refund.refundAmount,
              partyId: document.customerId,
              postingDate: refund.refundDate,
              sourceId: refund._id,
              narration: `Refund against ${document.creditNoteId}`,
            },
            session,
          );
        }
      },
    },
    {
      name: 'DEBIT_NOTE_REFUND',
      sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE,
      model: books.DebitNote,
      filter: { refunds: { $exists: true, $ne: [] } },
      perUnit: true,
      unitIds: document => (document.refunds || []).map(refund => refund._id),
      label: document => `Debit Note ${document.debitNoteId} refunds`,
      post: async (document, session) => {
        for (const refund of document.refunds || []) {
          const already = await books.LedgerEntry.countDocuments({
            companyId: document.companyId,
            sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE,
            sourceId: refund._id,
          }).session(session);
          if (already) continue;
          await ledgerService.postDebitNoteRefundJournal(
            {
              companyId: document.companyId,
              toAccountId: refund.toAccountId,
              amount: refund.refundAmount,
              partyId: document.vendorId,
              postingDate: refund.refundDate,
              sourceId: refund._id,
              narration: `Refund against ${document.debitNoteId}`,
            },
            session,
          );
        }
      },
    },
    {
      name: 'PAYMENT_RECEIVED_REFUND',
      sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED,
      model: booksCrm.PaymentReceived,
      filter: { status: 'APPROVED', refunds: { $exists: true, $ne: [] } },
      perUnit: true,
      unitIds: document => (document.refunds || []).map(refund => refund._id),
      label: document => `Payment received ${document.paymentReceivedId} refunds`,
      post: async (document, session) => {
        for (const refund of document.refunds || []) {
          const already = await books.LedgerEntry.countDocuments({
            companyId: document.companyId,
            sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED,
            sourceId: refund._id,
          }).session(session);
          if (already) continue;
          // A payment refund stores amountRefunded / refundedAt, and legacy rows still hold bankId
          // rather than fromAccountId — same shape the payment itself needs resolving.
          const fromAccountId = await resolvePaymentAccountId(refund, 'fromAccountId');
          await ledgerService.postCustomerRefundJournal(
            {
              companyId: document.companyId,
              fromAccountId,
              amount: refund.amountRefunded,
              partyId: document.customerId,
              postingDate: refund.refundedAt,
              sourceId: refund._id,
              narration: `Refund against ${document.paymentReceivedId}`,
              currencyId: document.currency,
              exchangeRate: document.exchangeRate,
            },
            session,
          );
        }
      },
    },
    {
      name: 'PAYMENT_MADE_REFUND',
      sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE,
      model: books.PaymentMade,
      filter: { status: 'APPROVED', refunds: { $exists: true, $ne: [] } },
      perUnit: true,
      unitIds: document => (document.refunds || []).map(refund => refund._id),
      label: document => `Payment made ${document.paymentMadeId} refunds`,
      post: async (document, session) => {
        for (const refund of document.refunds || []) {
          const already = await books.LedgerEntry.countDocuments({
            companyId: document.companyId,
            sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE,
            sourceId: refund._id,
          }).session(session);
          if (already) continue;
          const toAccountId = await resolvePaymentAccountId(refund, 'toAccountId');
          await ledgerService.postVendorRefundJournal(
            {
              companyId: document.companyId,
              toAccountId,
              amount: refund.amountRefunded,
              partyId: document.vendorId,
              postingDate: refund.refundedAt,
              sourceId: refund._id,
              narration: `Refund against ${document.paymentMadeId}`,
              currencyId: document.currency,
              exchangeRate: document.exchangeRate,
            },
            session,
          );
        }
      },
    },

    // Opening balance is written from three places, each keyed to a different document, so each
    // one posts and is tracked under its own source module.
    {
      name: 'OPENING_BALANCE_ACCOUNT',
      sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE,
      model: books.AccountOpeningBalance,
      filter: { isActive: { $ne: false } },
      label: document => `Account opening balance ${document.accountId}`,
      post: async (document, session) => {
        // An opening balance on a foreign-currency account is stated in that account's currency,
        // so it converts at that currency's rate — account.service.js resolves it the same way.
        const account = await books.Account.findById(document.accountId).select('currencyId').session(session).lean();
        const currency = await resolveTransactionCurrency({ companyId: document.companyId, currencyId: account?.currencyId });
        return ledgerService.postOpeningBalanceJournal(
          {
            companyId: document.companyId,
            accountId: document.accountId,
            amount: document.amount,
            balanceType: document.balanceType,
            postingDate: document.openingBalanceDate,
            sourceId: document._id,
            sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE,
            narration: 'Opening balance',
            currencyId: currency.currency,
            exchangeRate: currency.exchangeRate,
          },
          session,
        );
      },
    },
    {
      name: 'OPENING_BALANCE_PARTY',
      sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
      model: booksCrm.OpeningBalanceTransaction,
      filter: {},
      label: document => `Party opening balance ${document.transactionNo}`,
      // The balance sits on the party's own receivable or payable account, tagged with the party
      // so the subledger still adds up to the control account.
      post: async (document, session) => {
        const balanceType = OB_TYPE_BALANCE[document.type];
        if (!balanceType) throw new Error(`Unsupported opening balance type: ${document.type}`);
        const party = await booksCrm.Customer.findOne({ _id: document.contactId, companyId: document.companyId })
          .select('accountId')
          .session(session)
          .lean();
        if (!party?.accountId) throw new Error('No receivable/payable account is assigned on this customer or vendor');

        await ledgerService.postOpeningBalanceJournal(
          {
            companyId: document.companyId,
            accountId: party.accountId,
            amount: document.amount,
            balanceType,
            postingDate: document.date,
            sourceId: document._id,
            sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
            partyId: document.contactId,
            partyType: document.contactType === CONTACT_TYPE.CUSTOMER ? LEDGER_PARTY_TYPES.CUSTOMER : LEDGER_PARTY_TYPES.VENDOR,
            narration: document.contactType === CONTACT_TYPE.CUSTOMER ? 'Customer opening balance' : 'Vendor opening balance',
            currencyId: document.currency,
            exchangeRate: document.exchangeRate,
          },
          session,
        );
      },
    },
    {
      name: 'OPENING_STOCK',
      sourceModule: LEDGER_SOURCE_MODULES.OPENING_STOCK,
      model: booksCrm.Item,
      filter: { inventoryAccountId: { $ne: null } },
      label: document => `Opening stock ${document.itemNo || document.itemName}`,
      // Same value as syncItemOpeningStockJournal: warehouse openingStock × openingStockRate; sold/missing batches must not wipe an opening still on item inventory; legacy warehouses fall back to the OPENING_STOCK batch purchasePrice; live postingDate uses today, while backfill uses the item's own date.
      post: async (document, session) => {
        const itemInventory = await booksCrm.ItemInventory.findOne({ companyId: document.companyId, itemId: document._id })
          .select('warehouses.warehouseId warehouses.openingStock warehouses.openingStockRate')
          .session(session)
          .lean();
        const openingBatches = await booksCrm.ItemBatch.find({
          companyId: document.companyId,
          sourceType: 'OPENING_STOCK',
          sourceId: document._id,
        })
          .select('warehouseId purchasePrice')
          .session(session)
          .lean();
        const batchRateByWarehouse = new Map();
        for (const batch of openingBatches) {
          if (!batch.warehouseId) continue;
          batchRateByWarehouse.set(String(batch.warehouseId), Number(batch.purchasePrice) || 0);
        }
        const value = round2(
          (itemInventory?.warehouses || []).reduce((sum, warehouse) => {
            const storedRate = warehouse.openingStockRate;
            const rate =
              storedRate === undefined || storedRate === null || storedRate === ''
                ? batchRateByWarehouse.get(String(warehouse.warehouseId)) || 0
                : Number(storedRate);
            return sum + (Number(warehouse.openingStock) || 0) * rate;
          }, 0),
        );
        if (!value) return;

        await ledgerService.postOpeningBalanceJournal(
          {
            companyId: document.companyId,
            accountId: document.inventoryAccountId,
            amount: value,
            balanceType: BALANCE_TYPES.DEBIT,
            postingDate: document.createdAt || new Date(),
            sourceId: document._id,
            sourceModule: LEDGER_SOURCE_MODULES.OPENING_STOCK,
            narration: `Opening stock ${document.itemNo || document.itemName}`,
          },
          session,
        );
      },
    },
  ];
  moduleList.partyCache = partyCache;
  return moduleList;
};

// Prints the FOUND/POSTED/ALREADY/SKIPPED table plus soft-skip and hard-failure sections for one
// summary set — used for each company's own results and again for the cross-company grand total.
const printModuleSummary = (summary, failures, { apply, verify, reconcile }) => {
  const postedHeading = apply ? 'POSTED' : verify || reconcile ? 'WOULD OK' : 'TO POST';
  console.log(
    `${'MODULE'.padEnd(22)}${'FOUND'.padStart(8)}${postedHeading.padStart(10)}${'ALREADY'.padStart(10)}${'SKIPPED'.padStart(10)}`,
  );
  for (const row of summary) {
    console.log(
      `${row.module.padEnd(22)}${String(row.found).padStart(8)}${String(row.posted).padStart(10)}${String(row.already).padStart(10)}${String(row.skipped).padStart(10)}`,
    );
  }

  const hardFailures = failures.filter(failure => !failure.soft);
  const softSkips = failures.filter(failure => failure.soft);

  if (softSkips.length) {
    console.log(`\nSKIPPED ON PURPOSE (${softSkips.length}) — cannot post a balanced journal yet`);
    softSkips.slice(0, 15).forEach(row => console.log(`   ${row.module.padEnd(20)} ${row.label}  —  ${row.reason}`));
    if (softSkips.length > 15) console.log(`   ...and ${softSkips.length - 15} more`);
  }

  if (hardFailures.length) {
    // Grouped by cause: these come from a handful of prerequisites, and the fix is per cause,
    // not per document.
    const byReason = new Map();
    for (const failure of hardFailures) {
      const key = `${failure.module} | ${failure.reason}`;
      const group = byReason.get(key) || { module: failure.module, reason: failure.reason, count: 0, examples: [] };
      group.count += 1;
      if (group.examples.length < 3) group.examples.push(failure.label);
      byReason.set(key, group);
    }

    console.log(`\nFAILED (${hardFailures.length}) — fix the cause, then re-run; posted documents are skipped`);
    [...byReason.values()]
      .sort((a, b) => b.count - a.count)
      .forEach(group => {
        console.log(`\n   ${group.count} x ${group.module}`);
        console.log(`      ${group.reason}`);
        console.log(`      e.g. ${group.examples.join(', ')}`);
      });
  }
};

// Post one document inside a transaction. verify/reconcile always abort; apply commits on success.
// Same journal builders as before — only the surrounding I/O (posted-set, lean, concurrency) changed.
const postDocumentJournal = async ({
  module,
  document,
  sourceModule,
  unitIds,
  rawConnection,
  LedgerEntry,
  verify,
  reconcile,
  simulatedDeltas,
  expectedFromPosting,
  expectedBySource,
  replayAlready,
}) => {
  let postError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await rawConnection.startSession();
    postError = null;
    try {
      await session.startTransaction();
      const sourceIdFilter = module.perUnit ? { $in: unitIds } : document._id;

      // Rebuilding expected must not add a second journal on top of the stored one. Delete in this
      // transaction, post, read the new lines, then abort so the live ledger is unchanged.
      if (verify || reconcile) {
        await LedgerEntry.deleteMany({ companyId: document.companyId, sourceModule, sourceId: sourceIdFilter }, { session });
        if (module.name === 'PRODUCTION') {
          const priorIds = [
            ...(document.submissionHistory || []).map(entry => entry._id).filter(Boolean),
            ...(document.processBased?.processes || []).map(entry => entry._id).filter(Boolean),
          ];
          if (priorIds.length) {
            await LedgerEntry.deleteMany(
              { companyId: document.companyId, sourceModule, sourceId: { $in: priorIds } },
              { session },
            );
          }
        }
      }

      await module.post(document, session);

      if ((verify || reconcile) && !postError) {
        const lines = await LedgerEntry.find({
          companyId: document.companyId,
          sourceModule,
          sourceId: sourceIdFilter,
        })
          .session(session)
          .select('accountId debit credit isSplit sourceId')
          .lean();
        for (const line of lines) {
          if (line.isSplit) continue;
          addTotals(expectedFromPosting, line.accountId, line.debit, line.credit);
          addExpectedSource(expectedBySource, sourceModule, line.sourceId, line.accountId, line.debit, line.credit);
          if (!replayAlready) addTotals(simulatedDeltas, line.accountId, line.debit, line.credit);
        }
      }
    } catch (error) {
      postError = error;
    }

    try {
      if (session.inTransaction()) {
        if (verify || reconcile || postError) await session.abortTransaction();
        else await session.commitTransaction();
      }
    } catch (closeError) {
      if (!postError && !verify && !reconcile) postError = closeError;
    }
    await session.endSession();

    if (!postError || !isSessionArtefact(postError)) break;
  }
  return postError;
};

// Classify + optionally post every document for one module. Extracted so modules stay independent
// and report/verify can reuse the same already/skip rules.
const runModuleForCompany = async (
  module,
  {
    companyId,
    postedByModule,
    rawConnection,
    LedgerEntry,
    shouldPost,
    verify,
    reconcile,
    concurrency,
    simulatedDeltas,
    expectedFromPosting,
    expectedBySource,
  },
) => {
  const sourceModule = module.sourceModule || module.name;
  const scope = { ...module.filter, companyId };
  // lean: posting uses plain field access; hydrated mongoose docs were a major memory/CPU cost.
  const documents = await module.model.find(scope).sort({ createdAt: 1 }).lean();

  if (shouldPost) console.log(`  ${module.name}: ${documents.length} document(s)`);

  let posted = 0;
  let already = 0;
  let skipped = 0;
  const failures = [];
  const toProcess = [];

  for (const document of documents) {
    if (isDocumentAlreadyPosted(postedByModule, sourceModule, document, module)) {
      already += 1;
      if (reconcile) {
        if (module.skip) {
          const outcome = await module.skip(document);
          if (outcome) continue;
        }
        toProcess.push({ document, replayAlready: true });
      }
      continue;
    }

    if (module.skip) {
      const outcome = await module.skip(document);
      if (outcome) {
        const isHard = typeof outcome === 'object' && outcome.hard;
        const reason = typeof outcome === 'string' ? outcome : outcome.reason;
        if (!isHard) skipped += 1;
        failures.push({ module: module.name, label: module.label(document), reason, soft: !isHard });
        continue;
      }
    }

    if (!shouldPost) {
      posted += 1;
      continue;
    }

    toProcess.push({ document, replayAlready: false });
  }

  if (shouldPost && toProcess.length) {
    let done = 0;
    await mapWithConcurrency(toProcess, concurrency, async ({ document, replayAlready }) => {
      const unitIds = module.unitIds ? module.unitIds(document) : [];
      const postError = await postDocumentJournal({
        module,
        document,
        sourceModule,
        unitIds,
        rawConnection,
        LedgerEntry,
        verify,
        reconcile,
        simulatedDeltas,
        expectedFromPosting,
        expectedBySource,
        replayAlready,
      });
      done += 1;
      if (done % 100 === 0 || done === toProcess.length) {
        console.log(`    … ${module.name}: ${done}/${toProcess.length}`);
      }
      if (postError) {
        failures.push({ module: module.name, label: module.label(document), reason: postError.message });
      } else if (!replayAlready) {
        posted += 1;
      }
    });
  }

  return {
    summary: { module: module.name, found: documents.length, posted, already, skipped },
    failures,
  };
};

// Runs every module for one company, returning its FOUND/POSTED/ALREADY/SKIPPED summary,
// failures, and (when replaying) the expected debit/credit per account and per source.
const runModulesForCompany = async (
  companyId,
  modules,
  { rawConnection, LedgerEntry, booksCrm, shouldPost, verify, reconcile, concurrency = 1 },
) => {
  const simulatedDeltas = new Map();
  const expectedFromPosting = new Map();
  const expectedBySource = new Map();

  // Preload once: posted sourceIds (aggregation) + party account map (for skip handlers).
  const sourceModules = modules.map(module => module.sourceModule || module.name);
  const [postedByModule, partyRows] = await Promise.all([
    loadPostedSourceIds(LedgerEntry, companyId, sourceModules),
    preloadPartyCache(booksCrm, companyId),
  ]);

  if (modules.partyCache) {
    modules.partyCache.clear();
    for (const [key, value] of partyRows) modules.partyCache.set(key, value);
  }

  const postedCount = [...postedByModule.values()].reduce((sum, set) => sum + set.size, 0);
  console.log(`  preload: ${postedCount} posted sourceId(s), ${partyRows.size} part(y/ies)`);

  const summary = [];
  const failures = [];

  const runOne = module =>
    runModuleForCompany(module, {
      companyId,
      postedByModule,
      rawConnection,
      LedgerEntry,
      shouldPost,
      verify,
      reconcile,
      concurrency,
      simulatedDeltas,
      expectedFromPosting,
      expectedBySource,
    });

  if (!shouldPost) {
    // Report mode: modules are independent counts — run them in parallel.
    const results = await Promise.all(modules.map(runOne));
    for (const result of results) {
      summary.push(result.summary);
      failures.push(...result.failures);
    }
  } else {
    // Apply and replay: modules sequential (readable progress); docs parallel inside.
    for (const module of modules) {
      const result = await runOne(module);
      summary.push(result.summary);
      failures.push(...result.failures);
    }
  }

  if (reconcile) {
    const coveredModules = [...new Set(modules.map(module => module.sourceModule || module.name))];
    const uncovered = await LedgerEntry.aggregate([
      {
        $match: {
          companyId,
          isSplit: false,
          sourceModule: { $nin: coveredModules },
        },
      },
      {
        $group: {
          _id: { accountId: '$accountId', sourceModule: '$sourceModule', sourceId: '$sourceId' },
          debit: { $sum: '$debit' },
          credit: { $sum: '$credit' },
        },
      },
    ]).allowDiskUse(true);
    for (const row of uncovered) {
      addTotals(expectedFromPosting, row._id.accountId, row.debit, row.credit);
      addExpectedSource(expectedBySource, row._id.sourceModule, row._id.sourceId, row._id.accountId, row.debit, row.credit);
    }
  }

  return { summary, failures, simulatedDeltas, expectedFromPosting, expectedBySource };
};

const migrate = async () => {
  console.log(`Log file: ${LOG_FILE}`);
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const onlyArg = args.find(arg => arg.startsWith('--only='));
  const only = onlyArg
    ? onlyArg
        .slice('--only='.length)
        .split(',')
        .map(name => name.trim().toUpperCase())
        .filter(Boolean)
    : null;
  const companyArg = args.find(arg => !arg.startsWith('--'));
  const companyId = companyArg ? new mongoose.Types.ObjectId(companyArg) : null;

  const rawConnection = await bootstrap();
  // Required only after setApp, so the services resolve their models against the booted layer.
  const ledgerService = require('../modules/accountant/ledger/ledger.service');
  const enums = require('../utils/enum');
  const { LedgerEntry } = modelService.getBooksModels();
  const models = { books: modelService.getBooksModels(), common: modelService.getCommonModels() };
  models['books-crm'] = modelService.getBooksCrmModels();

  console.log(`\nScope   : ${companyId ? companyId.toString() : 'ALL COMPANIES'}`);
  console.log(`Mode    : ${apply ? 'APPLYING CHANGES' : 'count only'}`);

  const builtModules = buildModules(ledgerService, models, enums);
  const modules = only ? builtModules.filter(module => only.includes(module.name)) : builtModules;
  modules.partyCache = builtModules.partyCache;

  if (onlyArg) {
    if (!only.length) {
      console.log('--only= needs at least one module name, e.g. --only=INVOICE');
      console.log(`Available: ${builtModules.map(module => module.name).join(', ')}`);
      return;
    }
    const unknown = only.filter(name => !builtModules.some(module => module.name === name));
    if (unknown.length) {
      console.log(`Unknown module(s): ${unknown.join(', ')}`);
      console.log(`Available: ${builtModules.map(module => module.name).join(', ')}`);
      return;
    }
    console.log(`Modules : ${modules.map(module => module.name).join(', ')}`);
  }
  console.log('');

  const targetCompanies = companyId
    ? await models.common.Company.find({ _id: companyId }).select('name').lean()
    : await models.common.Company.find({}).select('name').sort({ name: 1 }).lean();

  if (!targetCompanies.length) {
    console.log(companyId ? `No company found for ${companyId}.` : 'No companies found.');
    return;
  }

  const multipleCompanies = targetCompanies.length > 1;
  const grandSummaryByModule = new Map();
  const grandFailures = [];

  for (const company of targetCompanies) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`Company: ${company.name || '(unnamed)'}  [${company._id}]`);
    console.log('='.repeat(72));

    const { summary, failures } = await runModulesForCompany(company._id, modules, {
      rawConnection,
      LedgerEntry,
      booksCrm: models['books-crm'],
      shouldPost: apply,
      verify: false,
      reconcile: false,
      concurrency: 1,
    });

    printModuleSummary(summary, failures, { apply, verify: false, reconcile: false });

    for (const row of summary) {
      const entry = grandSummaryByModule.get(row.module) || {
        module: row.module,
        found: 0,
        posted: 0,
        already: 0,
        skipped: 0,
      };
      entry.found += row.found;
      entry.posted += row.posted;
      entry.already += row.already;
      entry.skipped += row.skipped;
      grandSummaryByModule.set(row.module, entry);
    }
    grandFailures.push(...failures);
  }

  if (multipleCompanies) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`GRAND TOTAL — ${targetCompanies.length} companies`);
    console.log('='.repeat(72));
    printModuleSummary([...grandSummaryByModule.values()], grandFailures, { apply, verify: false, reconcile: false });
  }

  console.log('\nNOT COVERED — handle separately so nothing is assumed complete');
  console.log('   MANUAL_JOURNAL   run migrations/backfillManualJournalLedger.js');

  if (apply) console.log('\nBackfill complete.\n');
  else console.log('\nNothing was written. Re-run with --apply to write.\n');

  console.log(`Full output was also written to: ${LOG_FILE}`);
};

module.exports = {
  bootstrap,
  buildModules,
  runModulesForCompany,
  addTotals,
  addExpectedSource,
  netBalance,
  formatAmount,
  round2,
  printModuleSummary,
};

if (require.main === module) {
  console.time('backfillLedgerEntries');
  migrate()
    .then(() => {
      console.timeEnd('backfillLedgerEntries');
      process.exit(0);
    })
    .catch(error => {
      console.error('Ledger backfill failed:', error);
      console.timeEnd('backfillLedgerEntries');
      process.exit(1);
    });
}
