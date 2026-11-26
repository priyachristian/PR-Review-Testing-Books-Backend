/**
 * Delete one or more Item Groups by name, reversing every effect module by module.
 *
 * PHASES (run in this dependency order):
 *   sales        — Invoices, challans, credit notes, quotes, sales orders, customer orders,
 *                  recurring invoices, rejection orders, price lists, incentive schemes
 *   payments-in  — Payments received referencing deleted invoices;
 *                  invoice dispatches referencing deleted invoices
 *   purchase     — Bills, POs, GRPOs, debit notes, recurring bills
 *   payments-out — Payments made referencing deleted bills
 *   expenses     — Expenses with item-line references
 *   production   — Production orders, inventory adjustments, transfer requests
 *   incentives   — Incentive logs referencing any deleted document
 *   bom          — Clear BOM / scrap references on surviving items
 *   items        — Inventory records, batches, histories, stocks, opening-stock journal,
 *                  and the items themselves
 *   group        — Analytics configs (item group + sub item group), item group record
 *
 * Cross-phase IDs (invoice IDs → paymentreceiveds, bill IDs → paymentmades) are
 * pre-computed BEFORE any phase runs, so all phases are correct when run together.
 * Running phases independently after a partial run may miss orphaned records.
 *
 * Usage:
 *   node migrations/deleteItemGroupByName.js --companyId=<id> --itemGroupName=rff
 *   node migrations/deleteItemGroupByName.js --companyId=<id> --itemGroupName=rff --apply
 *   node migrations/deleteItemGroupByName.js --companyId=<id> --itemGroupName=rff --phase=sales,purchase --apply
 *
 * NOTE: Customer / vendor currentBalance is a denormalized cache on the branch array.
 * Deleting documents at the MongoDB level bypasses the service layer, so those cached
 * balances will be stale after this script runs. Trigger a balance recalculation for
 * affected customers/vendors after the deletion.
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const OPENING_BALANCE = 'OPENING_BALANCE';
const OPENING_STOCK = 'OPENING_STOCK';

const PHASE_ORDER = [
  'sales',
  'payments-in',
  'purchase',
  'payments-out',
  'expenses',
  'production',
  'incentives',
  'bom',
  'items',
  'group',
];

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const get = key => {
    const idx = argv.findIndex(a => a.startsWith(`--${key}=`));
    if (idx === -1) return undefined;
    const parts = [argv[idx].slice(key.length + 3)];
    for (let i = idx + 1; i < argv.length; i++) {
      if (argv[i].startsWith('--')) break;
      parts.push(argv[i]);
    }
    return parts.join(' ').trim() || undefined;
  };
  const list = v =>
    v
      ? v
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : [];

  const companyId = get('companyId');
  if (!companyId || !ObjectId.isValid(companyId)) {
    throw new Error('--companyId=<valid ObjectId> is required');
  }

  const itemGroupNames = list(get('itemGroupName'));
  if (!itemGroupNames.length) {
    throw new Error('--itemGroupName=<name>[,name2,...] is required');
  }

  const rawPhases = list(get('phase'));
  const phases = rawPhases.length ? rawPhases : PHASE_ORDER;
  const invalid = phases.filter(p => !PHASE_ORDER.includes(p));
  if (invalid.length) {
    throw new Error(`Unknown phase(s): ${invalid.join(', ')}. Valid: ${PHASE_ORDER.join(', ')}`);
  }

  return { companyId: new ObjectId(companyId), itemGroupNames, phases };
}

const escapeRegex = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Display helpers ──────────────────────────────────────────────────────────

const RELATED_DOC_DISPLAY = {
  'booksCrm.quotes': { number: ['quoteId'], date: 'quoteDate', party: 'customerId', status: 'status', total: 'total' },
  'booksCrm.salesorders': { number: ['orderId'], date: 'orderDate', party: 'customerId', status: 'status', total: 'total' },
  'booksCrm.pricelists': { number: ['priceListCode', 'priceListName'] },
  'booksCrm.incentiveschemes': { number: ['name'], date: 'startDate', status: 'status' },
  'booksCrm.paymentreceiveds': { number: ['paymentReceivedId'], date: 'paymentDate', party: 'customerId', total: 'amount' },
  'books.invoices': { number: ['invoiceId'], date: 'invoiceDate', party: 'customerId', status: 'status', total: 'total' },
  'books.deliverychallans': { number: ['challanId'], date: 'challanDate', party: 'customerId', status: 'status', total: 'total' },
  'books.creditnotes': {
    number: ['creditNoteId'],
    date: 'creditNoteDate',
    party: 'customerId',
    status: 'status',
    total: 'total',
  },
  'books.recurringinvoices': {
    number: ['recurringInvoiceId', 'profileName'],
    date: 'startDate',
    party: 'customerId',
    status: 'status',
  },
  'books.customerorders': {
    number: ['customerOrderId'],
    date: 'createdAt',
    party: 'customerId',
    status: 'status',
    total: 'total',
  },
  'books.rejectionorders': { number: ['rejectionOrderId'], date: 'transportationDate', party: 'customerId', status: 'status' },
  'books.invoicedispatches': { number: ['dispatchId'], date: 'dispatchDate', party: 'customerId' },
  'books.bills': { number: ['billId'], date: 'billDate', party: 'vendor', status: 'status', total: 'total' },
  'books.grpoorders': { number: ['grpoOrderId'], date: 'date', party: 'vendor', status: 'status', total: 'total' },
  'books.purchaseorders': { number: ['purchaseOrderId'], date: 'date', party: 'vendor', status: 'status', total: 'total' },
  'books.debitnotes': { number: ['debitNoteId'], date: 'debitNoteDate', party: 'vendorId', status: 'status', total: 'total' },
  'books.recurringbills': { number: ['recurringBillId', 'profileName'], date: 'startDate', party: 'vendorId', status: 'status' },
  'books.paymentmades': { number: ['paymentMadeId'], date: 'paymentDate', party: 'vendorId', total: 'amount' },
  'books.expenses': { number: ['expenseId'], date: 'expenseDate', status: 'status', total: 'total' },
  'books.inventoryadjustments': { number: ['inventoryAdjustmentNumber'], date: 'adjustmentDate', status: 'reason' },
  'books.inventorytransferrequests': { number: ['transferId'], status: 'status' },
  'books.productionorders': { number: ['productionOrderCode'], date: 'productionDate', status: 'status' },
};

const addTotals = (totals, counts) => {
  for (const [k, v] of Object.entries(counts)) {
    if (v) totals[k] = (totals[k] || 0) + v;
  }
};

const formatDate = v => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const cell = v =>
  String(v ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();

const printTsv = (title, rows) => {
  console.log(`\n  ${title} (${rows.length})`);
  if (!rows.length) {
    console.log('  (none)');
    return;
  }
  const headers = Object.keys(rows[0]);
  console.log('  ' + headers.join('\t'));
  for (const row of rows) console.log('  ' + headers.map(h => cell(row[h])).join('\t'));
};

const docProjection = spec => {
  const p = { _id: 1, 'items.itemId': 1, 'items.itemNo': 1, 'items.itemName': 1, itemId: 1, 'rawMaterials.rawMaterialId': 1 };
  for (const f of spec.number || []) p[f] = 1;
  if (spec.date) p[spec.date] = 1;
  if (spec.party) p[spec.party] = 1;
  if (spec.status) p[spec.status] = 1;
  if (spec.total) p[spec.total] = 1;
  return p;
};

const matchedItemLabels = (doc, itemIdSet, itemById) => {
  const labels = [];
  const push = id => {
    if (!id || !itemIdSet.has(String(id))) return;
    const item = itemById.get(String(id));
    labels.push(item ? [item.itemNo, item.itemName].filter(Boolean).join(' ') : String(id));
  };
  for (const line of doc.items || []) push(line.itemId);
  push(doc.itemId);
  for (const line of doc.rawMaterials || []) push(line.rawMaterialId);
  return [...new Set(labels)].join('; ');
};

const loadPartyNames = async (crm, companyId, ids) => {
  const unique = [...new Set(ids.filter(Boolean).map(id => String(id)))];
  if (!unique.length) return new Map();
  const docs = await crm
    .collection('customers')
    .find(
      { _id: { $in: unique.map(id => new ObjectId(id)) }, companyId },
      { projection: { customerDisplayName: 1, companyName: 1 } },
    )
    .toArray();
  return new Map(docs.map(doc => [String(doc._id), doc.customerDisplayName || doc.companyName || '']));
};

// ─── Target builders (per phase) ──────────────────────────────────────────────

const buildSalesTargets = (crm, books, companyId, itemIds) => {
  const idIn = { $in: itemIds };
  return [
    ['books.invoices', books.collection('invoices'), { companyId, 'items.itemId': idIn }],
    ['books.deliverychallans', books.collection('deliverychallans'), { companyId, 'items.itemId': idIn }],
    ['books.creditnotes', books.collection('creditnotes'), { companyId, 'items.itemId': idIn }],
    ['books.recurringinvoices', books.collection('recurringinvoices'), { companyId, 'items.itemId': idIn }],
    ['books.customerorders', books.collection('customerorders'), { companyId, 'items.itemId': idIn }],
    [
      'books.rejectionorders',
      books.collection('rejectionorders'),
      { companyId, $or: [{ 'items.itemId': idIn }, { 'items.componentRecoveries.componentItemId': idIn }] },
    ],
    ['booksCrm.quotes', crm.collection('quotes'), { companyId, 'items.itemId': idIn }],
    ['booksCrm.salesorders', crm.collection('salesorders'), { companyId, 'items.itemId': idIn }],
    ['booksCrm.pricelists', crm.collection('pricelists'), { companyId, 'items.itemId': idIn }],
    ['booksCrm.incentiveschemes', crm.collection('incentiveschemes'), { companyId, 'docTypes.items': idIn }],
  ];
};

const buildPurchaseTargets = (crm, books, companyId, itemIds) => {
  const idIn = { $in: itemIds };
  return [
    ['books.bills', books.collection('bills'), { companyId, 'items.itemId': idIn }],
    ['books.grpoorders', books.collection('grpoorders'), { companyId, 'items.itemId': idIn }],
    ['books.purchaseorders', books.collection('purchaseorders'), { companyId, 'items.itemId': idIn }],
    ['books.debitnotes', books.collection('debitnotes'), { companyId, 'items.itemId': idIn }],
    [
      'books.recurringbills',
      books.collection('recurringbills'),
      { companyId, $or: [{ 'items.itemId': idIn }, { 'inventoryConfig.items.itemId': idIn }] },
    ],
  ];
};

const buildPaymentInTargets = (crm, books, companyId, invoiceIds) => {
  if (!invoiceIds.length) return [];
  const idIn = { $in: invoiceIds };
  return [
    ['booksCrm.paymentreceiveds', crm.collection('paymentreceiveds'), { companyId, 'invoices.invoiceId': idIn }],
    ['books.invoicedispatches', books.collection('invoicedispatches'), { companyId, invoiceId: idIn }],
  ];
};

const buildPaymentOutTargets = (books, companyId, billIds) => {
  if (!billIds.length) return [];
  return [['books.paymentmades', books.collection('paymentmades'), { companyId, 'bills.billId': { $in: billIds } }]];
};

const buildExpenseTargets = (books, companyId, itemIds) => {
  if (!itemIds.length) return [];
  return [['books.expenses', books.collection('expenses'), { companyId, 'items.itemId': { $in: itemIds } }]];
};

const buildProductionTargets = (books, companyId, itemIds) => {
  const idIn = { $in: itemIds };
  return [
    ['books.inventoryadjustments', books.collection('inventoryadjustments'), { companyId, 'items.itemId': idIn }],
    [
      'books.inventorytransferrequests',
      books.collection('inventorytransferrequests'),
      { companyId, $or: [{ itemId: idIn }, { 'rawMaterials.rawMaterialId': idIn }] },
    ],
    [
      'books.productionorders',
      books.collection('productionorders'),
      {
        companyId,
        $or: [
          { itemId: idIn },
          { 'rawMaterials.rawMaterialId': idIn },
          { 'processBased.processes.processRawMaterialInput.item': idIn },
          { 'processBased.processes.scrapOutProcess.item': idIn },
          { 'submissionHistory.rawMaterialsConsumed.rawMaterialId': idIn },
        ],
      },
    ],
  ];
};

// ─── Cross-phase ID pre-computation ──────────────────────────────────────────

async function buildDiscovery(crm, books, companyId, itemIds) {
  const idIn = { $in: itemIds };
  const proj = { projection: { _id: 1 } };

  const [invoiceDocs, challanDocs, billDocs, quoteDocs, salesOrderDocs, customerOrderDocs, creditNoteDocs] = await Promise.all([
    books.collection('invoices').find({ companyId, 'items.itemId': idIn }, proj).toArray(),
    books.collection('deliverychallans').find({ companyId, 'items.itemId': idIn }, proj).toArray(),
    books.collection('bills').find({ companyId, 'items.itemId': idIn }, proj).toArray(),
    crm.collection('quotes').find({ companyId, 'items.itemId': idIn }, proj).toArray(),
    crm.collection('salesorders').find({ companyId, 'items.itemId': idIn }, proj).toArray(),
    books.collection('customerorders').find({ companyId, 'items.itemId': idIn }, proj).toArray(),
    books.collection('creditnotes').find({ companyId, 'items.itemId': idIn }, proj).toArray(),
  ]);

  const invoiceIds = invoiceDocs.map(d => d._id);
  const challanIds = challanDocs.map(d => d._id);
  const billIds = billDocs.map(d => d._id);
  const quoteIds = quoteDocs.map(d => d._id);
  const salesOrderIds = salesOrderDocs.map(d => d._id);
  const customerOrderIds = customerOrderDocs.map(d => d._id);
  const creditNoteIds = creditNoteDocs.map(d => d._id);

  const [paymentReceivedDocs, paymentMadeDocs] = await Promise.all([
    invoiceIds.length
      ? crm
          .collection('paymentreceiveds')
          .find({ companyId, 'invoices.invoiceId': { $in: invoiceIds } }, proj)
          .toArray()
      : [],
    billIds.length
      ? books
          .collection('paymentmades')
          .find({ companyId, 'bills.billId': { $in: billIds } }, proj)
          .toArray()
      : [],
  ]);

  const paymentReceivedIds = paymentReceivedDocs.map(d => d._id);
  const paymentMadeIds = paymentMadeDocs.map(d => d._id);

  const allDeletedDocIds = [
    ...invoiceIds,
    ...challanIds,
    ...creditNoteIds,
    ...quoteIds,
    ...salesOrderIds,
    ...customerOrderIds,
    ...billIds,
    ...paymentReceivedIds,
    ...paymentMadeIds,
  ];

  return {
    invoiceIds,
    challanIds,
    creditNoteIds,
    billIds,
    quoteIds,
    salesOrderIds,
    customerOrderIds,
    paymentReceivedIds,
    paymentMadeIds,
    allDeletedDocIds,
  };
}

// ─── Phase preview helpers ────────────────────────────────────────────────────

async function previewTargets(targets, crm, companyId, itemIds, itemById) {
  const itemIdSet = new Set(itemIds.map(id => String(id)));
  const summary = [];
  const documents = [];
  const partyIds = [];

  for (const [label, col, filter] of targets) {
    const spec = RELATED_DOC_DISPLAY[label] || { number: [] };
    const docs = await col.find(filter, { projection: docProjection(spec) }).toArray();
    if (!docs.length) continue;
    summary.push({ collection: label, count: docs.length, action: 'DELETE' });
    for (const doc of docs) {
      if (spec.party && doc[spec.party]) partyIds.push(doc[spec.party]);
      documents.push({ label, spec, doc });
    }
  }

  const partyNames = await loadPartyNames(crm, companyId, partyIds);
  const rows = documents.map(({ label, spec, doc }) => ({
    collection: label.replace(/^books(Crm)?\./, ''),
    number: (spec.number || [])
      .map(f => doc[f])
      .filter(Boolean)
      .join(' '),
    date: formatDate(spec.date ? doc[spec.date] : ''),
    party: spec.party ? partyNames.get(String(doc[spec.party])) || '' : '',
    status: spec.status ? doc[spec.status] || '' : '',
    total: spec.total && doc[spec.total] != null ? doc[spec.total] : '',
    matchedItems: matchedItemLabels(doc, itemIdSet, itemById),
    _id: String(doc._id),
  }));

  return { summary, rows };
}

async function previewIncentiveLogs(crm, companyId, allDeletedDocIds) {
  if (!allDeletedDocIds.length) return { summary: [], rows: [] };
  const count = await crm.collection('incentivelogs').countDocuments({ companyId, docId: { $in: allDeletedDocIds } });
  return { summary: count ? [{ collection: 'booksCrm.incentivelogs', count, action: 'DELETE' }] : [], rows: [] };
}

async function previewBomCleanup(crm, companyId, itemIds) {
  if (!itemIds.length) return { summary: [], rows: [] };
  const bomFilter = {
    companyId,
    _id: { $nin: itemIds },
    $or: [
      { 'productionData.bomBased.item': { $in: itemIds } },
      { 'productionData.productionScrapOutInventory.scrapItemName': { $in: itemIds } },
    ],
  };
  const docs = await crm
    .collection('items')
    .find(bomFilter, { projection: { _id: 1, itemNo: 1, itemName: 1 } })
    .toArray();
  return {
    summary: docs.length ? [{ collection: 'booksCrm.items (BOM/scrap refs)', count: docs.length, action: 'CLEAR refs' }] : [],
    rows: docs.map(d => ({ itemNo: d.itemNo || '', itemName: d.itemName || '', _id: d._id.toString() })),
  };
}

// ─── Phase execute helpers ────────────────────────────────────────────────────

async function executeTargets(targets, books, companyId, session) {
  const counts = {};
  const deletedSourceIds = [];
  const opts = session ? { session } : {};

  for (const [label, col, filter] of targets) {
    const docs = await col.find(filter, { projection: { _id: 1 }, ...opts }).toArray();
    if (!docs.length) continue;
    deletedSourceIds.push(...docs.map(d => d._id));
    const res = await col.deleteMany(filter, opts);
    if (res.deletedCount) counts[label] = res.deletedCount;
  }

  if (deletedSourceIds.length) {
    const res = await books.collection('ledgerentries').deleteMany({ companyId, sourceId: { $in: deletedSourceIds } }, opts);
    if (res.deletedCount) counts['books.ledgerentries'] = (counts['books.ledgerentries'] || 0) + res.deletedCount;
  }

  return counts;
}

async function executeIncentiveLogs(crm, companyId, allDeletedDocIds, session) {
  if (!allDeletedDocIds.length) return {};
  const opts = session ? { session } : {};
  const res = await crm.collection('incentivelogs').deleteMany({ companyId, docId: { $in: allDeletedDocIds } }, opts);
  return res.deletedCount ? { 'booksCrm.incentivelogs': res.deletedCount } : {};
}

async function executeBomCleanup(crm, companyId, itemIds, session) {
  if (!itemIds.length) return {};
  const opts = session ? { session } : {};
  const bomFilter = {
    companyId,
    _id: { $nin: itemIds },
    $or: [
      { 'productionData.bomBased.item': { $in: itemIds } },
      { 'productionData.productionScrapOutInventory.scrapItemName': { $in: itemIds } },
    ],
  };
  const res = await crm.collection('items').updateMany(
    bomFilter,
    {
      $pull: {
        'productionData.bomBased': { item: { $in: itemIds } },
        'productionData.productionScrapOutInventory': { scrapItemName: { $in: itemIds } },
      },
    },
    opts,
  );
  return res.modifiedCount ? { 'booksCrm.items(BOM refs cleared)': res.modifiedCount } : {};
}

async function executeItemOwnedRecords(crm, books, companyId, itemIds, session) {
  const counts = {};
  const idIn = { $in: itemIds };
  const opts = session ? { session } : {};

  for (const [label, col, filter] of [
    ['booksCrm.iteminventories', crm.collection('iteminventories'), { itemId: idIn, companyId }],
    ['booksCrm.itembatches', crm.collection('itembatches'), { itemId: idIn, companyId }],
    ['booksCrm.itemhistories', crm.collection('itemhistories'), { itemId: idIn, companyId }],
    ['books.inventorylogs', books.collection('inventorylogs'), { itemId: idIn, companyId }],
    ['books.stocks', books.collection('stocks'), { itemId: idIn, companyId }],
    [
      'books.ledgerentries(opening)',
      books.collection('ledgerentries'),
      { companyId, sourceModule: { $in: [OPENING_BALANCE, OPENING_STOCK] }, sourceId: idIn },
    ],
    ['booksCrm.items', crm.collection('items'), { _id: idIn, companyId }],
  ]) {
    const res = await col.deleteMany(filter, opts);
    if (res.deletedCount) counts[label] = res.deletedCount;
  }
  return counts;
}

async function executeGroupCleanup(crm, books, companyId, itemGroup, subItemGroupIds, session) {
  const counts = {};
  const opts = session ? { session } : {};

  // itemgroupanalyticsconfigs
  const igCol = books.collection('itemgroupanalyticsconfigs');
  const igMatches = await igCol
    .find({ companyId, itemGroupIds: itemGroup._id }, { projection: { _id: 1, itemGroupIds: 1, groupTitle: 1 }, ...opts })
    .toArray();
  if (igMatches.length) {
    const toDelete = igMatches.filter(c => (c.itemGroupIds || []).length <= 1).map(c => c._id);
    const toPull = igMatches.filter(c => (c.itemGroupIds || []).length > 1).map(c => c._id);
    if (toDelete.length) {
      const res = await igCol.deleteMany({ _id: { $in: toDelete } }, opts);
      if (res.deletedCount) counts['books.itemgroupanalyticsconfigs'] = res.deletedCount;
    }
    if (toPull.length) {
      const res = await igCol.updateMany({ _id: { $in: toPull } }, { $pull: { itemGroupIds: itemGroup._id } }, opts);
      if (res.modifiedCount) counts['books.itemgroupanalyticsconfigs(pulled)'] = res.modifiedCount;
    }
    console.log(`  Analytics configs: ${igMatches.map(c => c.groupTitle || c._id).join(', ')}`);
  }

  // subitemgroupanalyticsconfigs
  if (subItemGroupIds.length) {
    const sigCol = books.collection('subitemgroupanalyticsconfigs');
    const sigMatches = await sigCol
      .find(
        { companyId, subItemGroupIds: { $in: subItemGroupIds } },
        { projection: { _id: 1, subItemGroupIds: 1, groupTitle: 1 }, ...opts },
      )
      .toArray();
    if (sigMatches.length) {
      const toDelete = [];
      const toPull = [];
      for (const c of sigMatches) {
        const remaining = (c.subItemGroupIds || []).filter(id => !subItemGroupIds.some(sid => String(sid) === String(id)));
        if (remaining.length === 0) toDelete.push(c._id);
        else toPull.push(c._id);
      }
      if (toDelete.length) {
        const res = await sigCol.deleteMany({ _id: { $in: toDelete } }, opts);
        if (res.deletedCount) counts['books.subitemgroupanalyticsconfigs'] = res.deletedCount;
      }
      if (toPull.length) {
        const res = await sigCol.updateMany(
          { _id: { $in: toPull } },
          { $pull: { subItemGroupIds: { $in: subItemGroupIds } } },
          opts,
        );
        if (res.modifiedCount) counts['books.subitemgroupanalyticsconfigs(pulled)'] = res.modifiedCount;
      }
    }
  }

  // Delete the item group itself
  const res = await crm.collection('itemgroups').deleteOne({ _id: itemGroup._id, companyId }, opts);
  if (res.deletedCount) counts['booksCrm.itemgroups'] = 1;

  return counts;
}

// ─── Phase dispatch ───────────────────────────────────────────────────────────

async function previewPhase(phaseName, { crm, books, companyId, itemIds, itemById, discovery, itemGroup, items }) {
  if (phaseName === 'sales') {
    return previewTargets(buildSalesTargets(crm, books, companyId, itemIds), crm, companyId, itemIds, itemById);
  }
  if (phaseName === 'payments-in') {
    return previewTargets(buildPaymentInTargets(crm, books, companyId, discovery.invoiceIds), crm, companyId, [], new Map());
  }
  if (phaseName === 'purchase') {
    return previewTargets(buildPurchaseTargets(crm, books, companyId, itemIds), crm, companyId, itemIds, itemById);
  }
  if (phaseName === 'payments-out') {
    return previewTargets(buildPaymentOutTargets(books, companyId, discovery.billIds), crm, companyId, [], new Map());
  }
  if (phaseName === 'expenses') {
    return previewTargets(buildExpenseTargets(books, companyId, itemIds), crm, companyId, itemIds, itemById);
  }
  if (phaseName === 'production') {
    return previewTargets(buildProductionTargets(books, companyId, itemIds), crm, companyId, itemIds, itemById);
  }
  if (phaseName === 'incentives') {
    return previewIncentiveLogs(crm, companyId, discovery.allDeletedDocIds);
  }
  if (phaseName === 'bom') {
    return previewBomCleanup(crm, companyId, itemIds);
  }
  if (phaseName === 'items') {
    const summary = [];
    for (const [label, col, filter] of [
      ['booksCrm.iteminventories', crm.collection('iteminventories'), { itemId: { $in: itemIds }, companyId }],
      ['booksCrm.itembatches', crm.collection('itembatches'), { itemId: { $in: itemIds }, companyId }],
      ['booksCrm.itemhistories', crm.collection('itemhistories'), { itemId: { $in: itemIds }, companyId }],
      ['books.inventorylogs', books.collection('inventorylogs'), { itemId: { $in: itemIds }, companyId }],
      ['books.stocks', books.collection('stocks'), { itemId: { $in: itemIds }, companyId }],
      ['booksCrm.items', crm.collection('items'), { _id: { $in: itemIds }, companyId }],
    ]) {
      const count = await col.countDocuments(filter);
      if (count) summary.push({ collection: label, count, action: 'DELETE' });
    }
    return { summary, rows: items.map(i => ({ itemNo: i.itemNo || '', itemName: i.itemName || '', _id: i._id.toString() })) };
  }
  if (phaseName === 'group') {
    const summary = [];
    const igCount = await books
      .collection('itemgroupanalyticsconfigs')
      .countDocuments({ companyId, itemGroupIds: itemGroup._id });
    if (igCount) summary.push({ collection: 'books.itemgroupanalyticsconfigs', count: igCount, action: 'DELETE/PULL' });
    const subItemGroupIds = [...new Set(items.map(i => i.subItemGroup).filter(Boolean))];
    if (subItemGroupIds.length) {
      const sigCount = await books
        .collection('subitemgroupanalyticsconfigs')
        .countDocuments({ companyId, subItemGroupIds: { $in: subItemGroupIds } });
      if (sigCount) summary.push({ collection: 'books.subitemgroupanalyticsconfigs', count: sigCount, action: 'DELETE/PULL' });
    }
    summary.push({ collection: 'booksCrm.itemgroups', count: 1, action: 'DELETE' });
    return { summary, rows: [] };
  }
  throw new Error(`Unknown phase: ${phaseName}`);
}

async function executePhase(phaseName, { crm, books, companyId, itemIds, discovery, itemGroup, items, session, totals }) {
  let counts = {};

  if (phaseName === 'sales') {
    counts = await executeTargets(buildSalesTargets(crm, books, companyId, itemIds), books, companyId, session);
  } else if (phaseName === 'payments-in') {
    counts = await executeTargets(buildPaymentInTargets(crm, books, companyId, discovery.invoiceIds), books, companyId, session);
  } else if (phaseName === 'purchase') {
    counts = await executeTargets(buildPurchaseTargets(crm, books, companyId, itemIds), books, companyId, session);
  } else if (phaseName === 'payments-out') {
    counts = await executeTargets(buildPaymentOutTargets(books, companyId, discovery.billIds), books, companyId, session);
  } else if (phaseName === 'expenses') {
    counts = await executeTargets(buildExpenseTargets(books, companyId, itemIds), books, companyId, session);
  } else if (phaseName === 'production') {
    counts = await executeTargets(buildProductionTargets(books, companyId, itemIds), books, companyId, session);
  } else if (phaseName === 'incentives') {
    counts = await executeIncentiveLogs(crm, companyId, discovery.allDeletedDocIds, session);
  } else if (phaseName === 'bom') {
    counts = await executeBomCleanup(crm, companyId, itemIds, session);
  } else if (phaseName === 'items') {
    counts = await executeItemOwnedRecords(crm, books, companyId, itemIds, session);
  } else if (phaseName === 'group') {
    const subItemGroupIds = [...new Set(items.map(i => i.subItemGroup).filter(Boolean))];
    counts = await executeGroupCleanup(crm, books, companyId, itemGroup, subItemGroupIds, session);
  } else {
    throw new Error(`Unknown phase: ${phaseName}`);
  }

  addTotals(totals, counts);
  return counts;
}

// ─── Main per-group processor ─────────────────────────────────────────────────

async function processItemGroup({ client, crm, books, companyId, itemGroupName, phases, apply, totals }) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Item Group: "${itemGroupName}"`);
  console.log('═'.repeat(60));

  const nameRegex = new RegExp(`^${escapeRegex(itemGroupName)}$`, 'i');
  const matches = await crm
    .collection('itemgroups')
    .find({ companyId, name: nameRegex })
    .project({ _id: 1, name: 1, itemGroupId: 1 })
    .toArray();

  if (!matches.length) {
    console.log('  Not found — skipping.');
    return { name: itemGroupName, status: 'not_found' };
  }
  if (matches.length > 1) {
    console.log('  Multiple matches — resolve duplicates first:');
    console.table(matches.map(g => ({ _id: g._id.toString(), name: g.name, itemGroupId: g.itemGroupId })));
    return { name: itemGroupName, status: 'duplicate' };
  }

  const itemGroup = matches[0];
  console.log(`  Matched: ${itemGroup.name} (${itemGroup._id}) code=${itemGroup.itemGroupId || '(none)'}`);

  const items = await crm
    .collection('items')
    .find({ companyId, itemGroup: itemGroup._id })
    .project({ _id: 1, itemNo: 1, itemName: 1, subItemGroup: 1 })
    .toArray();

  printTsv(
    `Items in "${itemGroup.name}"`,
    items.map(i => ({ itemNo: i.itemNo || '', itemName: i.itemName || '', _id: i._id.toString() })),
  );

  const subItemGroupIds = [...new Set(items.map(i => i.subItemGroup).filter(Boolean))];
  if (subItemGroupIds.length) {
    const subGroups = await crm
      .collection('subitemgroups')
      .find({ _id: { $in: subItemGroupIds.map(id => new ObjectId(String(id))) }, companyId })
      .project({ _id: 1, name: 1, subItemGroupId: 1 })
      .toArray();
    if (subGroups.length) {
      console.log(`\n  Sub Item Groups referenced by these items (${subGroups.length}) — reported, not deleted:`);
      console.table(subGroups.map(g => ({ _id: g._id.toString(), name: g.name, subItemGroupId: g.subItemGroupId })));
    }
  }

  const itemIds = items.map(i => i._id);
  const itemById = new Map(items.map(i => [String(i._id), i]));

  // Pre-compute all cross-phase IDs from current DB state.
  const discovery = itemIds.length
    ? await buildDiscovery(crm, books, companyId, itemIds)
    : {
        invoiceIds: [],
        challanIds: [],
        creditNoteIds: [],
        billIds: [],
        quoteIds: [],
        salesOrderIds: [],
        customerOrderIds: [],
        paymentReceivedIds: [],
        paymentMadeIds: [],
        allDeletedDocIds: [],
      };

  // ── Preview all phases ────────────────────────────────────────────────────
  for (const phaseName of phases) {
    const { summary, rows } = await previewPhase(phaseName, {
      crm,
      books,
      companyId,
      itemIds,
      itemById,
      discovery,
      itemGroup,
      items,
    });
    if (!summary.length && !rows.length) {
      console.log(`\n  Phase [${phaseName}]: (nothing to do)`);
      continue;
    }
    console.log(`\n  Phase [${phaseName}]:`);
    if (summary.length) console.table(summary);
    if (rows.length) printTsv('Documents', rows);
  }

  if (!apply) {
    console.log('\n  Dry run — pass --apply to execute.');
    return { name: itemGroupName, status: 'dry-run' };
  }

  // ── Execute phases, each in its own transaction ───────────────────────────
  for (const phaseName of phases) {
    console.log(`\n  Running phase [${phaseName}]...`);
    const session = client.startSession();
    try {
      let counts = {};
      await session.withTransaction(async () => {
        counts = await executePhase(phaseName, {
          crm,
          books,
          companyId,
          itemIds,
          discovery,
          itemGroup,
          items,
          session,
          totals,
        });
      });
      const changed = Object.entries(counts)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      console.log(`  Phase [${phaseName}]: done${changed ? ` — ${changed}` : ' (nothing deleted)'}`);
    } catch (err) {
      await session.endSession();
      throw err;
    }
    await session.endSession();
  }

  console.log(`\n  All phases complete for "${itemGroupName}".`);
  if (discovery.paymentReceivedIds.length || discovery.paymentMadeIds.length) {
    console.log(
      '  ⚠️  Customer/vendor currentBalance is a denormalized cache — trigger a balance recalculation for affected parties.',
    );
  }

  return { name: itemGroupName, status: 'deleted' };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run() {
  const { companyId, itemGroupNames, phases } = parseArgs(process.argv);
  const apply = process.argv.includes('--apply');
  const { client, booksCrm: crm, books, common } = await getConnection();

  try {
    console.log(`Mode   : ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);
    console.log(`Phases : ${phases.join(', ')}`);
    console.log(`Company: ${companyId}`);
    console.log(`Groups : ${itemGroupNames.join(', ')}`);

    const company = await common.collection('companies').findOne({ _id: companyId }, { projection: { name: 1 } });
    if (!company) {
      console.log('Company not found — aborting.');
      return;
    }
    console.log(`Company name: ${company.name || '(unknown)'}`);

    const totals = {};
    const results = [];

    for (const itemGroupName of itemGroupNames) {
      const result = await processItemGroup({ client, crm, books, companyId, itemGroupName, phases, apply, totals });
      results.push(result);
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('Overall Summary');
    console.log('═'.repeat(60));
    console.table(results.map(r => ({ itemGroup: r.name, status: r.status })));

    if (apply && Object.keys(totals).length) {
      console.log('\nTotal records deleted / updated per collection:');
      console.table(Object.entries(totals).map(([collection, count]) => ({ collection, count })));
    }

    console.log(apply ? '\n✅ Done.' : '\nDry run complete — pass --apply to execute.');
  } catch (err) {
    console.error('❌ Failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
