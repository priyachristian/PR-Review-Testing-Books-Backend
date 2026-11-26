/**
 * Copy all data from one company to another (for CA testing).
 *
 * Copies: CRM masters + transactions, Books-CRM masters + transactions,
 *         Books accounting + inventory + production + recurring — across
 *         books-crm, books, crm, common DBs.
 *
 * What is NOT copied:
 *   - User, Token, OTP, Company        (auth-level, shared across companies)
 *   - ErrorLog, DevelopmentUpdate      (system logs)
 *   - PortalInviteToken                (transient tokens)
 *   - CustomerPortalUser               (portal auth)
 *
 * Every copied document gets a new _id. An in-memory idMap (oldId → newId)
 * per model is used to remap all internal refs before inserting.
 * User refs (addedBy, updatedBy, assignedTo) are intentionally NOT remapped
 * — users live in Common DB and are shared across companies.
 *
 * Usage:
 *   NODE_ENV=development node scripts/copy-company.js \
 *     --source=<sourceCompanyId> --target=<targetCompanyId>
 */

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('../config/config');

const mongoose = require('mongoose');
const { getModelsAndConnections } = require('@smit9313/abss-models-core');

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const r = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.+)$/);
    if (m) r[m[1]] = m[2];
  }
  return r;
}

// ─── ID MAP REGISTRY ──────────────────────────────────────────────────────────
// Unified across all databases so cross-DB refs work
// (e.g. Invoice in books referenced by PaymentReceived in books-crm).

const idMaps = {};

function ensureMap(name) {
  if (!idMaps[name]) idMaps[name] = new Map();
  return idMaps[name];
}

function remapId(id, mapName) {
  if (!id) return id;
  const newId = idMaps[mapName]?.get(id.toString());
  return newId ? new mongoose.Types.ObjectId(newId) : id;
}

// ─── REF CONFIG MERGER ────────────────────────────────────────────────────────

function mergeRefs(...configs) {
  const r = { root: {}, plainArrays: {}, arrays: {}, nestedArrays: {}, embeddedObjects: {}, dynamicRefs: [] };
  for (const c of configs) {
    if (!c) continue;
    if (c.root) Object.assign(r.root, c.root);
    if (c.plainArrays) Object.assign(r.plainArrays, c.plainArrays);
    if (c.arrays) Object.assign(r.arrays, c.arrays);
    if (c.embeddedObjects) Object.assign(r.embeddedObjects, c.embeddedObjects);
    if (c.nestedArrays) {
      for (const [k, v] of Object.entries(c.nestedArrays)) r.nestedArrays[k] = { ...r.nestedArrays[k], ...v };
    }
    if (c.dynamicRefs) r.dynamicRefs.push(...c.dynamicRefs);
  }
  return r;
}

// ─── SHARED REF PATTERNS ──────────────────────────────────────────────────────

// items[] with accountId + nested batches[]
const ITEMS_REF = {
  arrays: { items: { itemId: 'Item', accountId: 'Account' } },
  nestedArrays: { items: { batches: { warehouseId: 'Warehouse', itemBatchId: 'ItemBatch' } } },
};

// Base refs inherited by all sales docs (Invoice, Quote, SalesOrder, DeliveryChallan, CreditNote)
const SALES_BASE = mergeRefs(ITEMS_REF, {
  root: {
    customerId: 'Customer',
    bankId: 'Bank',
    divisionId: 'Division',
    branchId: 'Branch',
    warehouseId: 'Warehouse',
    priceListId: 'PriceList',
  },
});

// Base refs inherited by all purchase docs (PurchaseOrder, GrpoOrder, Bill, DebitNote)
const PURCHASE_BASE = mergeRefs(ITEMS_REF, {
  root: {
    divisionId: 'Division',
    branchId: 'Branch',
    warehouseId: 'Warehouse',
    bankId: 'Bank',
  },
});

// convertedTo[] dynamic ref (sales: Quote → SalesOrder/DeliveryChallan/Invoice)
const CONVERTED_TO_SALES = {
  dynamicRefs: [
    {
      arrayField: 'convertedTo',
      idField: 'documentId',
      typeField: 'type',
      typeToMap: { SalesOrder: 'SalesOrder', DeliveryChallan: 'DeliveryChallan', Invoice: 'Invoice' },
    },
  ],
};

// convertedTo[] dynamic ref (purchase: PurchaseOrder → GrpoOrder/Bill)
const CONVERTED_TO_PURCHASE = {
  dynamicRefs: [
    {
      arrayField: 'convertedTo',
      idField: 'documentId',
      typeField: 'type',
      typeToMap: { GRPO: 'GrpoOrder', BILL: 'Bill', GrpoOrder: 'GrpoOrder', Bill: 'Bill' },
    },
  ],
};

// ─── DOCUMENT REMAP ───────────────────────────────────────────────────────────
//
// refConfig shape:
// {
//   root:            { fieldName: 'MapName' }
//   plainArrays:     { fieldName: 'MapName' }          ← array of plain ObjectIds
//   arrays:          { arrField: { subField: 'Map' } } ← array of objects
//   nestedArrays:    { parentArr: { childArr: { field: 'Map' } } } ← 2-level deep
//   embeddedObjects: { objField: { subField: 'Map' } } ← embedded sub-object
//   dynamicRefs:     [{ arrayField, idField, typeField, typeToMap }]
// }

function remapDoc(doc, cfg = {}) {
  const d = { ...doc };

  // Root-level ObjectId fields
  if (cfg.root) {
    for (const [f, map] of Object.entries(cfg.root)) if (d[f]) d[f] = remapId(d[f], map);
  }

  // Arrays of plain ObjectIds (e.g. ancestors[], processes[], branchId[])
  if (cfg.plainArrays) {
    for (const [f, map] of Object.entries(cfg.plainArrays)) {
      if (Array.isArray(d[f])) d[f] = d[f].map(id => (id ? remapId(id, map) : id));
    }
  }

  // Arrays of objects
  if (cfg.arrays) {
    for (const [arrF, fieldMap] of Object.entries(cfg.arrays)) {
      if (Array.isArray(d[arrF])) {
        d[arrF] = d[arrF].map(item => {
          if (!item || typeof item !== 'object') return item;
          const ni = { ...item };
          for (const [f, map] of Object.entries(fieldMap)) if (ni[f]) ni[f] = remapId(ni[f], map);
          return ni;
        });
      }
    }
  }

  // Two-level nested arrays (e.g. items[].batches[])
  if (cfg.nestedArrays) {
    for (const [parentF, childConfig] of Object.entries(cfg.nestedArrays)) {
      if (Array.isArray(d[parentF])) {
        d[parentF] = d[parentF].map(parentItem => {
          if (!parentItem || typeof parentItem !== 'object') return parentItem;
          const pi = { ...parentItem };
          for (const [childF, childFieldMap] of Object.entries(childConfig)) {
            if (Array.isArray(pi[childF])) {
              pi[childF] = pi[childF].map(ci => {
                if (!ci || typeof ci !== 'object') return ci;
                const nc = { ...ci };
                for (const [f, map] of Object.entries(childFieldMap)) if (nc[f]) nc[f] = remapId(nc[f], map);
                return nc;
              });
            }
          }
          return pi;
        });
      }
    }
  }

  // Embedded objects (e.g. transportCourier.transportId)
  if (cfg.embeddedObjects) {
    for (const [objF, fieldMap] of Object.entries(cfg.embeddedObjects)) {
      if (d[objF] && typeof d[objF] === 'object' && !Array.isArray(d[objF])) {
        const no = { ...d[objF] };
        for (const [f, map] of Object.entries(fieldMap)) if (no[f]) no[f] = remapId(no[f], map);
        d[objF] = no;
      }
    }
  }

  // Dynamic refPath arrays (e.g. convertedTo[].documentId resolved by convertedTo[].type)
  if (cfg.dynamicRefs?.length) {
    for (const { arrayField, idField, typeField, typeToMap } of cfg.dynamicRefs) {
      if (Array.isArray(d[arrayField])) {
        d[arrayField] = d[arrayField].map(item => {
          if (!item) return item;
          const ni = { ...item };
          const mapName = typeToMap[ni[typeField]];
          if (mapName && ni[idField]) ni[idField] = remapId(ni[idField], mapName);
          return ni;
        });
      }
    }
  }

  return d;
}

// ─── COPY COLLECTION ──────────────────────────────────────────────────────────

/**
 * @param {mongoose.Model}  Model
 * @param {string}          srcId       source companyId
 * @param {string}          tgtId       target companyId
 * @param {object}          refConfig
 * @param {string}          label       display name + idMaps key
 * @param {object}          [options]
 * @param {object}          [options.query]       override default companyId filter
 * @param {boolean}         [options.noCompanyId] don't set companyId on new docs
 */
async function copyCollection(Model, srcId, tgtId, refConfig = {}, label, options = {}) {
  if (!Model) {
    console.log(`  - ${label}: model not found, skipping`);
    return;
  }

  const name = label || Model.modelName;
  const query = options.query || { companyId: new mongoose.Types.ObjectId(srcId) };
  const docs = await Model.find(query).lean();

  if (!docs.length) {
    console.log(`  - ${name}: 0 docs`);
    return;
  }

  const map = ensureMap(name);
  const newDocs = [];

  for (const doc of docs) {
    const newId = new mongoose.Types.ObjectId();
    const newDoc = remapDoc(doc, refConfig);
    newDoc._id = newId;
    if (!options.noCompanyId) newDoc.companyId = new mongoose.Types.ObjectId(tgtId);
    delete newDoc.__v;
    map.set(doc._id.toString(), newId.toString());
    newDocs.push(newDoc);
  }

  try {
    await Model.insertMany(newDocs, { ordered: false });
    console.log(`  ✓ ${name}: ${docs.length} docs`);
  } catch (err) {
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      console.warn(`  ! ${name}: ${docs.length} docs (${err.writeErrors?.length ?? '?'} duplicates skipped)`);
    } else {
      throw err;
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const SOURCE = args.source;
  const TARGET = args.target;

  if (!SOURCE || !TARGET) {
    console.error('Usage: node scripts/copy-company.js --source=<companyId> --target=<companyId>');
    process.exit(1);
  }
  if (SOURCE === TARGET) {
    console.error('Source and target must be different.');
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('       ABSS — Copy Company Script');
  console.log('========================================');
  console.log(`Source : ${SOURCE}`);
  console.log(`Target : ${TARGET}`);
  console.log(`Env    : ${process.env.NODE_ENV}\n`);

  console.log('Connecting to databases...');
  const { models } = await getModelsAndConnections();
  console.log('Connected.\n');

  const BC = models['books-crm'];
  const B = models['books'];
  const C = models['crm'];
  const CM = models['common'];

  const startTime = Date.now();

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Common: CompanySettings
  // ══════════════════════════════════════════════════════════════════════════
  console.log('Phase 1 — Common: CompanySettings');
  if (CM?.CompanySettings) {
    const s = await CM.CompanySettings.findOne({ companyId: new mongoose.Types.ObjectId(SOURCE) }).lean();
    if (s) {
      const { _id, companyId, __v, ...rest } = s;
      await CM.CompanySettings.findOneAndUpdate(
        { companyId: new mongoose.Types.ObjectId(TARGET) },
        { $set: { ...rest, companyId: new mongoose.Types.ObjectId(TARGET) } },
        { upsert: true },
      );
      console.log('  ✓ CompanySettings: upserted');
    } else {
      console.log('  - CompanySettings: 0 docs');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2 — CRM Masters (no internal deps)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 2 — CRM Masters');
  if (C) {
    await copyCollection(C.Platform, SOURCE, TARGET, {}, 'Platform');
    await copyCollection(C.LeadSource, SOURCE, TARGET, {}, 'LeadSource');
    await copyCollection(C.LeadStatus, SOURCE, TARGET, {}, 'LeadStatus');
    await copyCollection(C.LeadIndustry, SOURCE, TARGET, {}, 'LeadIndustry');
    await copyCollection(C.Role, SOURCE, TARGET, {}, 'CrmRole');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 3 — Books-CRM Masters (no internal deps)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 3 — Books-CRM Masters');
  await copyCollection(BC.Division, SOURCE, TARGET, {}, 'Division');
  await copyCollection(BC.ItemGroup, SOURCE, TARGET, {}, 'ItemGroup');
  await copyCollection(BC.ItemUnit, SOURCE, TARGET, {}, 'ItemUnit');
  await copyCollection(BC.ModuleSettings, SOURCE, TARGET, {}, 'ModuleSettings');

  await copyCollection(
    BC.Branch,
    SOURCE,
    TARGET,
    {
      root: { divisionId: 'Division' },
    },
    'Branch',
  );

  await copyCollection(
    BC.Warehouse,
    SOURCE,
    TARGET,
    {
      root: { divisionId: 'Division', branchId: 'Branch' },
    },
    'Warehouse',
  );

  await copyCollection(
    BC.Bank,
    SOURCE,
    TARGET,
    {
      root: { divisionId: 'Division', branchId: 'Branch' },
    },
    'Bank',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 4 — Books Masters
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 4 — Books Masters');

  await copyCollection(B.QualityMaster, SOURCE, TARGET, {}, 'QualityMaster');
  await copyCollection(B.CustomField, SOURCE, TARGET, {}, 'CustomField');
  await copyCollection(B.Tax, SOURCE, TARGET, {}, 'Tax');
  await copyCollection(B.Gst, SOURCE, TARGET, {}, 'Gst');
  await copyCollection(B.SalesPerson, SOURCE, TARGET, {}, 'SalesPerson');
  await copyCollection(B.TransportCourier, SOURCE, TARGET, {}, 'TransportCourier');
  await copyCollection(B.ManPower, SOURCE, TARGET, {}, 'ManPower');
  await copyCollection(B.Process, SOURCE, TARGET, {}, 'Process');

  // Recipe depends on Process
  await copyCollection(
    B.Recipe,
    SOURCE,
    TARGET,
    {
      plainArrays: { processes: 'Process' },
    },
    'Recipe',
  );

  await copyCollection(B.AccountItemGroup, SOURCE, TARGET, {}, 'AccountItemGroup');
  await copyCollection(B.Role, SOURCE, TARGET, {}, 'BooksRole');

  // ── Account: has self-refs (parentAccountId, ancestors[]) ────────────────
  // Copy all first to build the full id map, then patch self-refs.
  const rawAccounts = await B.Account.find({ companyId: new mongoose.Types.ObjectId(SOURCE) }).lean();

  if (rawAccounts.length) {
    const accMap = ensureMap('Account');
    const newAccs = [];

    for (const doc of rawAccounts) {
      const newId = new mongoose.Types.ObjectId();
      const newDoc = { ...doc, _id: newId, companyId: new mongoose.Types.ObjectId(TARGET) };
      delete newDoc.__v;
      accMap.set(doc._id.toString(), newId.toString());
      newAccs.push(newDoc);
    }

    await B.Account.insertMany(newAccs, { ordered: false });
    console.log(`  ✓ Account: ${newAccs.length} docs`);

    // Post-pass: remap self-refs
    const patchOps = newAccs
      .filter(d => d.parentAccountId || d.ancestors?.length)
      .map(d =>
        B.Account.updateOne(
          { _id: d._id },
          {
            $set: {
              ...(d.parentAccountId ? { parentAccountId: remapId(d.parentAccountId, 'Account') } : {}),
              ...(d.ancestors?.length ? { ancestors: d.ancestors.map(a => remapId(a, 'Account')) } : {}),
            },
          },
        ),
      );

    if (patchOps.length) {
      await Promise.all(patchOps);
      console.log(`  ✓ Account self-refs patched: ${patchOps.length} docs`);
    }
  } else {
    console.log('  - Account: 0 docs');
  }

  // AccountItemMaster depends on Account + AccountItemGroup
  await copyCollection(
    B.AccountItemMaster,
    SOURCE,
    TARGET,
    {
      root: { accountId: 'Account', itemGroup: 'AccountItemGroup' },
    },
    'AccountItemMaster',
  );

  await copyCollection(B.AccountLedger, SOURCE, TARGET, {}, 'AccountLedger');

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 5 — CRM Campaigns (depends on Platform)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 5 — CRM Campaigns');
  if (C) {
    await copyCollection(
      C.Campaign,
      SOURCE,
      TARGET,
      {
        arrays: { platform: { platformId: 'Platform' } },
      },
      'Campaign',
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 6 — Items (has BOM self-refs)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 6 — Items');

  const rawItems = await BC.Item.find({ companyId: new mongoose.Types.ObjectId(SOURCE) }).lean();

  if (rawItems.length) {
    const itemMap = ensureMap('Item');
    const newItems = [];

    for (const doc of rawItems) {
      const newId = new mongoose.Types.ObjectId();
      const newDoc = { ...doc, _id: newId, companyId: new mongoose.Types.ObjectId(TARGET) };
      delete newDoc.__v;
      // Non-self refs remapped now
      if (newDoc.itemGroup) newDoc.itemGroup = remapId(newDoc.itemGroup, 'ItemGroup');
      itemMap.set(doc._id.toString(), newId.toString());
      newItems.push(newDoc);
    }

    await BC.Item.insertMany(newItems, { ordered: false });
    console.log(`  ✓ Item: ${newItems.length} docs`);

    // Post-pass: fix BOM + scrap self-refs
    const bomOps = newItems
      .filter(d => d.productionData?.bomBased?.length || d.productionData?.productionScrapOutInventory?.length)
      .map(d => {
        const upd = {};
        if (d.productionData?.bomBased?.length) {
          upd['productionData.bomBased'] = d.productionData.bomBased.map(b => ({
            ...b,
            item: b.item ? remapId(b.item, 'Item') : b.item,
            itemGroup: b.itemGroup ? remapId(b.itemGroup, 'ItemGroup') : b.itemGroup,
          }));
        }
        if (d.productionData?.productionScrapOutInventory?.length) {
          upd['productionData.productionScrapOutInventory'] = d.productionData.productionScrapOutInventory.map(s => ({
            ...s,
            scrapItemName: s.scrapItemName ? remapId(s.scrapItemName, 'Item') : s.scrapItemName,
          }));
        }
        return BC.Item.updateOne({ _id: d._id }, { $set: upd });
      });

    if (bomOps.length) {
      await Promise.all(bomOps);
      console.log(`  ✓ Item BOM self-refs patched: ${bomOps.length} docs`);
    }
  } else {
    console.log('  - Item: 0 docs');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 7 — PriceList & Customer
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 7 — PriceList & Customer');

  await copyCollection(
    BC.PriceList,
    SOURCE,
    TARGET,
    {
      arrays: { items: { itemId: 'Item', itemGroup: 'ItemGroup' } },
    },
    'PriceList',
  );

  await copyCollection(
    BC.Customer,
    SOURCE,
    TARGET,
    {
      root: { priceList: 'PriceList', campaignId: 'Campaign' },
      arrays: { branch: { branchId: 'Branch', divisionId: 'Division' } },
    },
    'Customer',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 8 — Inventory & Batches
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 8 — Inventory & Batches');

  await copyCollection(
    BC.ItemBatch,
    SOURCE,
    TARGET,
    {
      root: { itemId: 'Item', divisionId: 'Division', branchId: 'Branch', warehouseId: 'Warehouse' },
    },
    'ItemBatch',
  );

  await copyCollection(
    BC.ItemInventory,
    SOURCE,
    TARGET,
    {
      root: { itemId: 'Item' },
      arrays: { warehouses: { warehouseId: 'Warehouse', divisionId: 'Division', branchId: 'Branch' } },
    },
    'ItemInventory',
  );

  await copyCollection(
    BC.ItemHistory,
    SOURCE,
    TARGET,
    {
      root: { itemId: 'Item', warehouseId: 'Warehouse', branchId: 'Branch', divisionId: 'Division' },
    },
    'ItemHistory',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 9 — CRM Transactions
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 9 — CRM Transactions');

  if (C) {
    await copyCollection(
      C.Lead,
      SOURCE,
      TARGET,
      {
        root: {
          platformId: 'Platform',
          campaignId: 'Campaign',
          leadSource: 'LeadSource',
          industry: 'LeadIndustry',
        },
      },
      'Lead',
    );

    await copyCollection(
      C.QrCode,
      SOURCE,
      TARGET,
      {
        root: { leadSourceId: 'LeadSource' },
      },
      'QrCode',
    );

    await copyCollection(
      C.UserRole,
      SOURCE,
      TARGET,
      {
        root: { roleId: 'CrmRole' },
      },
      'CrmUserRole',
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 10 — Books-CRM Transactions
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 10 — Books-CRM Transactions');

  await copyCollection(
    BC.Quote,
    SOURCE,
    TARGET,
    mergeRefs(
      SALES_BASE,
      {
        root: { leadId: 'Lead', campaignId: 'Campaign' },
      },
      CONVERTED_TO_SALES,
    ),
    'Quote',
  );

  await copyCollection(
    BC.SalesOrder,
    SOURCE,
    TARGET,
    mergeRefs(
      SALES_BASE,
      {
        root: { quoteId: 'Quote' },
      },
      CONVERTED_TO_SALES,
    ),
    'SalesOrder',
  );

  await copyCollection(
    BC.OpeningBalanceTransaction,
    SOURCE,
    TARGET,
    {
      root: { customerId: 'Customer', branchId: 'Branch', divisionId: 'Division' },
    },
    'OpeningBalanceTransaction',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 11 — Books Transactions
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 11 — Books Transactions');

  // Books has its own ItemBatch collection (separate from books-crm)
  if (B.ItemBatch) {
    await copyCollection(
      B.ItemBatch,
      SOURCE,
      TARGET,
      {
        root: { itemId: 'Item', divisionId: 'Division', branchId: 'Branch', warehouseId: 'Warehouse' },
      },
      'Books.ItemBatch',
    );
  }

  await copyCollection(
    B.PurchaseOrder,
    SOURCE,
    TARGET,
    mergeRefs(
      PURCHASE_BASE,
      {
        root: { vendor: 'Customer', customer: 'Customer' },
      },
      CONVERTED_TO_PURCHASE,
    ),
    'PurchaseOrder',
  );

  await copyCollection(
    B.GrpoOrder,
    SOURCE,
    TARGET,
    mergeRefs(PURCHASE_BASE, {
      root: { vendor: 'Customer', customer: 'Customer' },
      arrays: {
        purchaseOrders: { purchaseOrderId: 'PurchaseOrder' },
        convertedTo: { documentId: 'Bill' }, // GrpoOrder always converts to Bill
      },
    }),
    'GrpoOrder',
  );

  await copyCollection(
    B.DeliveryChallan,
    SOURCE,
    TARGET,
    mergeRefs(
      SALES_BASE,
      {
        arrays: { salesOrders: { salesOrderId: 'SalesOrder' } },
      },
      CONVERTED_TO_SALES,
    ),
    'DeliveryChallan',
  );

  await copyCollection(
    B.Invoice,
    SOURCE,
    TARGET,
    mergeRefs(SALES_BASE, {
      root: {
        quoteId: 'Quote',
        splitInvoiceId: 'Invoice', // self-ref — remapped if in same batch
        splitWarehouseId: 'Warehouse',
        invoiceDispatchId: 'InvoiceDispatch',
      },
      arrays: {
        salesOrders: { salesOrderId: 'SalesOrder' },
        deliveryChallanIds: { deliveryChallanId: 'DeliveryChallan' },
        creditsApplied: { creditNoteId: 'CreditNote' },
      },
    }),
    'Invoice',
  );

  await copyCollection(
    B.CreditNote,
    SOURCE,
    TARGET,
    mergeRefs(SALES_BASE, {
      root: { invoiceId: 'Invoice' },
      arrays: { invoicesApplied: { invoiceId: 'Invoice' } },
    }),
    'CreditNote',
  );

  await copyCollection(
    B.Bill,
    SOURCE,
    TARGET,
    mergeRefs(PURCHASE_BASE, {
      root: {
        vendor: 'Customer',
        customer: 'Customer',
        splitBillId: 'Bill', // self-ref
        splitWarehouseId: 'Warehouse',
      },
      arrays: {
        purchaseOrders: { purchaseOrderId: 'PurchaseOrder' },
        grpoIds: { grpoId: 'GrpoOrder' },
        creditsApplied: { debitNoteId: 'DebitNote' },
      },
    }),
    'Bill',
  );

  await copyCollection(
    B.DebitNote,
    SOURCE,
    TARGET,
    mergeRefs(PURCHASE_BASE, {
      root: { vendor: 'Customer' },
      arrays: { billsApplied: { billId: 'Bill' } },
    }),
    'DebitNote',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 12 — Payments
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 12 — Payments');

  // PaymentReceived lives in books-crm but refs Invoice from books DB.
  // Works because idMaps is unified across all databases.
  await copyCollection(
    BC.PaymentReceived,
    SOURCE,
    TARGET,
    {
      root: {
        customerId: 'Customer',
        bankId: 'Bank',
        branchId: 'Branch',
        divisionId: 'Division',
        warehouseId: 'Warehouse',
      },
      arrays: {
        invoices: { invoiceId: 'Invoice' },
        openingBalanceTransactions: { openingBalanceTransactionId: 'OpeningBalanceTransaction' },
      },
    },
    'PaymentReceived',
  );

  await copyCollection(
    B.PaymentMade,
    SOURCE,
    TARGET,
    {
      root: {
        vendorId: 'Customer',
        bankId: 'Bank',
        branchId: 'Branch',
        divisionId: 'Division',
        warehouseId: 'Warehouse',
      },
      arrays: {
        bills: { billId: 'Bill' },
        openingBalanceTransactions: { openingBalanceTransactionId: 'OpeningBalanceTransaction' },
      },
    },
    'PaymentMade',
  );

  await copyCollection(
    BC.BankTransferLog,
    SOURCE,
    TARGET,
    {
      root: { fromBankId: 'Bank', toBankId: 'Bank' },
    },
    'BankTransferLog',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 13 — Journals & Ledgers
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 13 — Journals & Ledgers');

  await copyCollection(
    B.ManualJournal,
    SOURCE,
    TARGET,
    {
      root: { divisionId: 'Division', branchId: 'Branch', warehouseId: 'Warehouse' },
      arrays: {
        journalEntries: {
          // field is journalEntries, not entries
          accountId: 'Account',
          businessAccountLedgerMasterId: 'AccountLedger',
        },
      },
    },
    'ManualJournal',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 14 — Inventory
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 14 — Inventory');

  await copyCollection(
    B.InventoryAdjustment,
    SOURCE,
    TARGET,
    {
      root: { warehouseId: 'Warehouse', divisionId: 'Division', branchId: 'Branch' },
      arrays: { items: { itemId: 'Item', warehouseId: 'Warehouse' } },
    },
    'InventoryAdjustment',
  );

  await copyCollection(
    B.InventoryLogs,
    SOURCE,
    TARGET,
    {
      root: { itemId: 'Item', warehouseId: 'Warehouse', divisionId: 'Division', branchId: 'Branch' },
    },
    'InventoryLogs',
  );

  await copyCollection(
    B.InventoryTransferRequest,
    SOURCE,
    TARGET,
    {
      root: { itemId: 'Item', fromWarehouseId: 'Warehouse', toWarehouseId: 'Warehouse', productionOrderId: 'ProductionOrder' },
      arrays: { rawMaterials: { rawMaterialId: 'Item' } },
    },
    'InventoryTransferRequest',
  );

  await copyCollection(
    B.Stock,
    SOURCE,
    TARGET,
    {
      root: { itemId: 'Item', warehouseId: 'Warehouse', divisionId: 'Division', branchId: 'Branch' },
    },
    'Stock',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 15 — Recurring Documents
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 15 — Recurring');

  await copyCollection(B.RecurringInvoice, SOURCE, TARGET, mergeRefs(SALES_BASE), 'RecurringInvoice');

  // RecurringBills uses vendorId/customerId (not vendor like PurchaseOrder)
  await copyCollection(
    B.RecurringBills,
    SOURCE,
    TARGET,
    mergeRefs(PURCHASE_BASE, {
      root: { vendorId: 'Customer', customerId: 'Customer' },
    }),
    'RecurringBills',
  );

  await copyCollection(
    B.RecurringExpense,
    SOURCE,
    TARGET,
    mergeRefs(ITEMS_REF, {
      root: {
        bankId: 'Bank',
        divisionId: 'Division',
        branchId: 'Branch',
        warehouseId: 'Warehouse',
        expenseAccount: 'Account',
        customer: 'Customer',
      },
    }),
    'RecurringExpense',
  );

  // RecurringConfig: dynamic sourceType ref (RecurringInvoice / RecurringBills / RecurringExpense)
  const rcDocs = await B.RecurringConfig.find({ companyId: new mongoose.Types.ObjectId(SOURCE) }).lean();

  if (rcDocs.length) {
    const rcMap = ensureMap('RecurringConfig');
    const SOURCE_TYPE_TO_MAP = {
      RecurringInvoice: 'RecurringInvoice',
      RecurringBills: 'RecurringBills',
      RecurringExpense: 'RecurringExpense',
    };
    const newRcDocs = rcDocs.map(doc => {
      const newId = new mongoose.Types.ObjectId();
      rcMap.set(doc._id.toString(), newId.toString());
      const nd = { ...doc, _id: newId, companyId: new mongoose.Types.ObjectId(TARGET) };
      delete nd.__v;
      const mapName = SOURCE_TYPE_TO_MAP[nd.sourceType];
      if (mapName && nd.sourceId) nd.sourceId = remapId(nd.sourceId, mapName);
      return nd;
    });
    await B.RecurringConfig.insertMany(newRcDocs, { ordered: false });
    console.log(`  ✓ RecurringConfig: ${newRcDocs.length} docs`);
  } else {
    console.log('  - RecurringConfig: 0 docs');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 16 — Production
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 16 — Production');

  await copyCollection(
    B.ProductionOrder,
    SOURCE,
    TARGET,
    mergeRefs({
      root: {
        itemId: 'Item',
        salesOrderId: 'SalesOrder',
        divisionId: 'Division',
        branchId: 'Branch',
        warehouseId: 'Warehouse',
        dispatchWarehouseId: 'Warehouse',
        inventoryInwarehouseId: 'Warehouse',
        inStockWarehouseId: 'Warehouse',
        productionWarehouseId: 'Warehouse',
      },
      plainArrays: {
        productionOwner: 'ManPower',
        manPower_inventoryTransfer: 'ManPower',
      },
      arrays: {
        manPower: { workerId: 'ManPower' },
        rawMaterials: { rawMaterialId: 'Item' },
        scrapOutProcess: { item: 'Item' },
        processRawMaterialInput: { workerId: 'ManPower' },
      },
      nestedArrays: {
        batches: { warehouseId: 'Warehouse', itemBatchId: 'ItemBatch' },
        rawMaterials: { batches: { warehouseId: 'Warehouse', itemBatchId: 'ItemBatch' } },
        scrapOutProcess: { batches: { warehouseId: 'Warehouse', itemBatchId: 'ItemBatch' } },
        processRawMaterialInput: { batches: { warehouseId: 'Warehouse', itemBatchId: 'ItemBatch' } },
      },
      embeddedObjects: {
        processBased: { recipeId: 'Recipe' },
      },
    }),
    'ProductionOrder',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 17 — Misc
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nPhase 17 — Misc');

  await copyCollection(
    B.Expenses,
    SOURCE,
    TARGET,
    mergeRefs(ITEMS_REF, {
      root: {
        bankId: 'Bank',
        divisionId: 'Division',
        branchId: 'Branch',
        warehouseId: 'Warehouse',
        expenseAccount: 'Account',
        customer: 'Customer',
      },
    }),
    'Expenses',
  );

  await copyCollection(
    B.Project,
    SOURCE,
    TARGET,
    {
      root: { customerId: 'Customer' },
    },
    'Project',
  );

  // TimeSheet has NO companyId — query by copied projectIds
  const projOldIds = Array.from(idMaps['Project']?.keys() || []).map(id => new mongoose.Types.ObjectId(id));
  if (B.TimeSheet && projOldIds.length > 0) {
    await copyCollection(
      B.TimeSheet,
      SOURCE,
      TARGET,
      {
        root: { projectId: 'Project' },
      },
      'TimeSheet',
      { query: { projectId: { $in: projOldIds } }, noCompanyId: true },
    );
  } else {
    console.log('  - TimeSheet: 0 docs (no projects)');
  }

  // InvoiceDispatch has NO companyId — query by copied invoiceIds
  const invOldIds = Array.from(idMaps['Invoice']?.keys() || []).map(id => new mongoose.Types.ObjectId(id));
  if (B.InvoiceDispatch && invOldIds.length > 0) {
    await copyCollection(
      B.InvoiceDispatch,
      SOURCE,
      TARGET,
      {
        root: { invoiceId: 'Invoice' },
        embeddedObjects: { transportCourier: { transportId: 'TransportCourier' } },
      },
      'InvoiceDispatch',
      { query: { invoiceId: { $in: invOldIds } }, noCompanyId: true },
    );
  } else {
    console.log('  - InvoiceDispatch: 0 docs (no invoices)');
  }

  await copyCollection(
    B.GeneralSalesAnalytics,
    SOURCE,
    TARGET,
    {
      root: { customerId: 'Customer', itemId: 'Item' },
    },
    'GeneralSalesAnalytics',
  );

  await copyCollection(
    B.ItemGroupAnalyticsConfig,
    SOURCE,
    TARGET,
    {
      plainArrays: { itemGroupIds: 'ItemGroup' },
    },
    'ItemGroupAnalyticsConfig',
  );

  await copyCollection(
    B.UserRole,
    SOURCE,
    TARGET,
    {
      root: { roleId: 'BooksRole' },
    },
    'BooksUserRole',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // DONE
  // ══════════════════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  let total = 0;
  for (const m of Object.values(idMaps)) total += m.size;

  console.log('\n========================================');
  console.log(`  Done in ${elapsed}s — ${total} documents copied`);
  console.log('========================================\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
