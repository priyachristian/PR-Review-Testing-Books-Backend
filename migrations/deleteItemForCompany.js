/**
 * Delete items (and all owned records + opening-stock journal) for ONE company.
 *
 * Default scope is ALL items for the company. Narrow it with --itemId / --itemNo.
 *
 * Mirrors deleteItemById: an item that is still referenced in any transactional or config
 * document (invoices, orders, bills, price lists, production, incentive schemes, other
 * items' BOM, etc.) is reported as BLOCKED and left untouched. Only unreferenced items are
 * deleted, each inside its own transaction.
 *
 * DRY RUN by default — pass --apply to actually delete.
 *
 * Usage:
 *   node migrations/deleteItemForCompany.js --companyId=<id>                 # all items, dry run
 *   node migrations/deleteItemForCompany.js --companyId=<id> --apply         # all items, delete
 *   node migrations/deleteItemForCompany.js --companyId=<id> --itemId=<id1>,<id2>
 *   node migrations/deleteItemForCompany.js --companyId=<id> --itemNo=<no1>,<no2> --apply
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const OPENING_BALANCE = 'OPENING_BALANCE';
const SAMPLE_LIMIT = 50;

function parseArgs(argv) {
  const get = key => {
    const hit = argv.find(a => a.startsWith(`--${key}=`));
    return hit === undefined ? undefined : hit.slice(key.length + 3);
  };
  const list = value =>
    value
      ? value
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : [];

  const companyId = get('companyId');
  if (!companyId || !ObjectId.isValid(companyId)) {
    throw new Error('--companyId=<valid ObjectId> is required');
  }

  const itemIdStrings = list(get('itemId'));
  const itemNos = list(get('itemNo'));
  itemIdStrings.forEach(id => {
    if (!ObjectId.isValid(id)) throw new Error(`--itemId contains an invalid ObjectId: ${id}`);
  });

  return {
    companyId: new ObjectId(companyId),
    itemIds: itemIdStrings.map(id => new ObjectId(id)),
    itemNos,
  };
}

const buildGuardChecks = (crm, books, companyId, itemId) => {
  const idIn = { $in: [itemId] };
  return [
    ['booksCrm.quotes', crm.collection('quotes'), { companyId, 'items.itemId': idIn }],
    ['booksCrm.salesorders', crm.collection('salesorders'), { companyId, 'items.itemId': idIn }],
    ['booksCrm.pricelists', crm.collection('pricelists'), { companyId, 'items.itemId': idIn }],
    ['booksCrm.incentiveschemes', crm.collection('incentiveschemes'), { companyId, 'docTypes.items': idIn }],
    [
      'booksCrm.items(BOM)',
      crm.collection('items'),
      {
        companyId,
        _id: { $ne: itemId },
        $or: [{ 'productionData.bomBased.item': idIn }, { 'productionData.productionScrapOutInventory.scrapItemName': idIn }],
      },
    ],
    ['books.invoices', books.collection('invoices'), { companyId, 'items.itemId': idIn }],
    ['books.deliverychallans', books.collection('deliverychallans'), { companyId, 'items.itemId': idIn }],
    ['books.creditnotes', books.collection('creditnotes'), { companyId, 'items.itemId': idIn }],
    ['books.recurringinvoices', books.collection('recurringinvoices'), { companyId, 'items.itemId': idIn }],
    ['books.bills', books.collection('bills'), { companyId, 'items.itemId': idIn }],
    ['books.grpoorders', books.collection('grpoorders'), { companyId, 'items.itemId': idIn }],
    ['books.purchaseorders', books.collection('purchaseorders'), { companyId, 'items.itemId': idIn }],
    ['books.debitnotes', books.collection('debitnotes'), { companyId, 'items.itemId': idIn }],
    ['books.customerorders', books.collection('customerorders'), { companyId, 'items.itemId': idIn }],
    ['books.inventoryadjustments', books.collection('inventoryadjustments'), { companyId, 'items.itemId': idIn }],
    [
      'books.recurringbills',
      books.collection('recurringbills'),
      { companyId, $or: [{ 'items.itemId': idIn }, { 'inventoryConfig.items.itemId': idIn }] },
    ],
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
    [
      'books.rejectionorders',
      books.collection('rejectionorders'),
      { companyId, $or: [{ 'items.itemId': idIn }, { 'items.componentRecoveries.componentItemId': idIn }] },
    ],
  ];
};

const findReferences = async (crm, books, companyId, itemId) => {
  const references = [];
  for (const [label, col, filter] of buildGuardChecks(crm, books, companyId, itemId)) {
    const hit = await col.findOne(filter, { projection: { _id: 1 } });
    if (hit) references.push(label);
  }
  return references;
};

const deleteOwnedRecords = async (crm, books, companyId, itemId, session) => {
  const counts = {};
  const owned = [
    ['booksCrm.iteminventories', crm.collection('iteminventories'), { itemId, companyId }],
    ['booksCrm.itembatches', crm.collection('itembatches'), { itemId, companyId }],
    ['booksCrm.itemhistories', crm.collection('itemhistories'), { itemId, companyId }],
    ['books.inventorylogs', books.collection('inventorylogs'), { itemId, companyId }],
    ['books.stocks', books.collection('stocks'), { itemId, companyId }],
    ['books.ledgerentries', books.collection('ledgerentries'), { companyId, sourceModule: OPENING_BALANCE, sourceId: itemId }],
    ['booksCrm.items', crm.collection('items'), { _id: itemId, companyId }],
  ];
  for (const [label, col, filter] of owned) {
    const res = await col.deleteMany(filter, { session });
    counts[label] = res.deletedCount;
  }
  return counts;
};

async function run(apply = false) {
  const { companyId, itemIds, itemNos } = parseArgs(process.argv);
  const { client, booksCrm, books, common } = await getConnection();

  try {
    console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);
    console.log(`Company: ${companyId}`);

    const company = await common.collection('companies').findOne({ _id: companyId }, { projection: { name: 1 } });
    if (!company) {
      console.log('Company not found — aborting.');
      return;
    }
    console.log(`Company name: ${company.name || '(unknown)'}`);

    const scoped = itemIds.length || itemNos.length;
    const query = {
      companyId,
      ...(itemIds.length ? { _id: { $in: itemIds } } : itemNos.length ? { itemNo: { $in: itemNos } } : {}),
    };
    console.log(scoped ? `Scope: ${scoped} specified item(s)` : 'Scope: ALL items for this company');

    const items = await booksCrm.collection('items').find(query).project({ _id: 1, itemNo: 1, itemName: 1 }).toArray();
    if (!items.length) {
      console.log('No matching item found for this company — aborting.');
      return;
    }
    console.log(`Items in scope: ${items.length}`);

    const blocked = [];
    const deletable = [];
    const deleted = [];
    const totals = {};

    for (const item of items) {
      const references = await findReferences(booksCrm, books, companyId, item._id);

      if (references.length) {
        blocked.push({ itemNo: item.itemNo, itemName: item.itemName, blockedBy: [...new Set(references)].join(', ') });
        continue;
      }

      if (!apply) {
        deletable.push({ itemNo: item.itemNo, itemName: item.itemName });
        continue;
      }

      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const counts = await deleteOwnedRecords(booksCrm, books, companyId, item._id, session);
          for (const [key, value] of Object.entries(counts)) totals[key] = (totals[key] || 0) + value;
        });
      } finally {
        await session.endSession();
      }
      deleted.push({ itemNo: item.itemNo, itemName: item.itemName });
    }

    console.log('\n=== Summary ===');
    console.table([
      { metric: 'Items in scope', value: items.length },
      { metric: 'Blocked (in use)', value: blocked.length },
      { metric: apply ? 'Deleted' : 'Deletable (dry run)', value: apply ? deleted.length : deletable.length },
    ]);

    if (blocked.length) {
      console.log(`\nBLOCKED — still referenced, NOT deleted (${blocked.length}):`);
      console.table(blocked.slice(0, SAMPLE_LIMIT));
      if (blocked.length > SAMPLE_LIMIT) console.log(`... and ${blocked.length - SAMPLE_LIMIT} more`);
    }

    if (!apply && deletable.length) {
      console.log(`\nDeletable (dry run) (${deletable.length}):`);
      console.table(deletable.slice(0, SAMPLE_LIMIT));
      if (deletable.length > SAMPLE_LIMIT) console.log(`... and ${deletable.length - SAMPLE_LIMIT} more`);
    }

    if (apply && Object.keys(totals).length) {
      console.log('\nTotal records deleted per collection:');
      console.table(Object.entries(totals).map(([collection, deletedCount]) => ({ collection, deletedCount })));
    }

    console.log(apply ? '\n✅ Done.' : '\nDry run — no changes written. Re-run with --apply to delete the deletable items.');
  } catch (err) {
    console.error('❌ Delete failed:', err);
    throw err;
  } finally {
    await client.close();
  }
}

module.exports = { run };

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  run(apply)
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
