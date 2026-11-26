/**
 * Builds a full set of pre-ledger documents for one company, so the ledger backfill can be run
 * against known numbers and every closing balance checked.
 *
 * Everything it writes looks like data from before ledger posting existed: customers, vendors,
 * items, opening balances, opening stock, stock batches and eight to ten documents in every
 * module the backfill covers — and not one LedgerEntry. Running backfillLedgerEntries.js
 * afterwards should reproduce exactly the trial balance printed at the end of this script.
 *
 * HOW THE EXPECTED BALANCE IS ARRIVED AT
 * Each document registers what it should do to the ledger as it is built, worked out from the
 * quantities, rates and tax it was given — never by reading the posting code. The backfill then
 * works the same numbers out from the saved documents through ledger.service.js. Two independent
 * routes to the same figure, so agreement means something. The script also checks its own
 * expectation balances before writing anything.
 *
 * WHAT IS COVERED
 *   opening balances    account balances, all four party balance types, item opening stock
 *   purchases           GRPO into GRNI, bills settling GRNI, direct bills, service bills,
 *                       untracked goods expensed, multi-line, discount, charges, both tax modes
 *   sales               stock sales with cost of goods sold, service sales, multi-line,
 *                       document discount, additional charges, both tax modes
 *   returns             credit notes with and without stock, debit notes with and without stock
 *   money               expenses, receipts applied to invoices, customer advances, vendor
 *                       payments, vendor advances, bank transfers
 *   inventory           adjustments up and down, valued from the batches actually moved
 *   production          BOM runs consuming materials into finished goods, with and without scrap
 *
 * Everything carries seedTag: 'LEDGER_TEST', so --reset removes exactly what this made, and the
 * journals it produced, and nothing else. The company's own data is never touched.
 *
 * Run: node migrations/seedLedgerTestData.js <companyId>          (report, writes nothing)
 *      node migrations/seedLedgerTestData.js <companyId> --apply  (write)
 *      node migrations/seedLedgerTestData.js <companyId> --reset  (remove seeded data + journals)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const SEED_TAG = 'LEDGER_TEST';
const oid = () => new ObjectId();
const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const SEEDED_COLLECTIONS = [
  ['booksCrm', 'customers'],
  ['booksCrm', 'items'],
  ['booksCrm', 'itembatches'],
  ['booksCrm', 'iteminventories'],
  ['booksCrm', 'paymentreceiveds'],
  ['booksCrm', 'banktransferlogs'],
  ['booksCrm', 'openingbalancetransactions'],
  ['books', 'accountopeningbalances'],
  ['books', 'invoices'],
  ['books', 'bills'],
  ['books', 'grpoorders'],
  ['books', 'creditnotes'],
  ['books', 'debitnotes'],
  ['books', 'expenses'],
  ['books', 'paymentmades'],
  ['books', 'inventoryadjustments'],
  ['books', 'productionorders'],
];

const seed = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const reset = args.includes('--reset');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    if (!companyArg) {
      console.error('Usage: node migrations/seedLedgerTestData.js <companyId> [--apply|--reset]');
      process.exitCode = 1;
      return;
    }
    const companyId = new ObjectId(companyArg);

    const db = await getConnection();
    client = db.client;
    console.log(`\nCompany : ${companyId}`);
    console.log(`Mode    : ${reset ? 'RESET' : apply ? 'APPLYING' : 'report only — pass --apply to write'}\n`);

    // ---- reset ---------------------------------------------------------------------------
    // The journals go first: while the documents still exist the set of ids to clear can be
    // rebuilt, so a run that stops halfway can simply be run again.
    if (reset) {
      const seededIds = [];
      for (const [dbKey, collection] of SEEDED_COLLECTIONS) {
        const docs = await db[dbKey].collection(collection).find({ companyId, seedTag: SEED_TAG }).project({ _id: 1 }).toArray();
        seededIds.push(...docs.map(doc => doc._id));
      }
      const ledger = seededIds.length
        ? await db.books.collection('ledgerentries').deleteMany({ sourceId: { $in: seededIds } })
        : { deletedCount: 0 };
      console.log(`   removed ${String(ledger.deletedCount).padStart(4)}  ledgerentries`);

      let removed = 0;
      for (const [dbKey, collection] of SEEDED_COLLECTIONS) {
        const result = await db[dbKey].collection(collection).deleteMany({ companyId, seedTag: SEED_TAG });
        if (result.deletedCount) console.log(`   removed ${String(result.deletedCount).padStart(4)}  ${collection}`);
        removed += result.deletedCount;
      }
      console.log(`\nReset complete — ${removed} documents, ${ledger.deletedCount} ledger rows.\n`);
      return;
    }

    // Only writing is blocked once the data is there; the expected balance can always be printed,
    // so it can be compared against what the backfill actually posted.
    const alreadySeeded = (await db.books.collection('invoices').countDocuments({ companyId, seedTag: SEED_TAG })) > 0;
    if (alreadySeeded && apply) {
      console.log('This company already holds seeded test data. Run with --reset first.\n');
      return;
    }

    // ---- context -------------------------------------------------------------------------
    const accountRows = await db.books
      .collection('accounts')
      .find({ companyId, systemAccountKey: { $ne: null } })
      .project({ systemAccountKey: 1, accountName: 1 })
      .toArray();
    const account = key => {
      const found = accountRows.find(row => row.systemAccountKey === key);
      if (!found) throw new Error(`System account ${key} is missing — seed the chart of accounts first.`);
      return found._id;
    };
    const nameOf = key => accountRows.find(row => row.systemAccountKey === key)?.accountName || key;

    const branch = await db.booksCrm.collection('branches').findOne({ companyId });
    const warehouse = await db.booksCrm.collection('warehouses').findOne({ companyId });
    const company = await db.common.collection('companies').findOne({ _id: companyId });
    if (!branch || !warehouse) throw new Error('This company needs at least one branch and one warehouse.');

    const currency = company.baseCurrency;
    const base = {
      companyId,
      seedTag: SEED_TAG,
      branchId: branch._id,
      divisionId: branch.divisionId,
      warehouseId: warehouse._id,
    };
    const day = n => new Date(Date.UTC(2026, 0, n, 6, 0, 0));

    // Documents are numbered out of the company's own running sequence, so they fall in line
    // behind the real ones instead of running a private scheme alongside them. The sequence is
    // moved on at the end, so the next document raised on screen carries on where these stop.
    const moduleSettings = await db.booksCrm.collection('modulesettings').find({ companyId }).toArray();
    const sequenceCursor = {};
    const nextNumber = moduleName => {
      const setting = moduleSettings.find(row => row.moduleName === moduleName);
      if (!setting) throw new Error(`Module settings are missing for ${moduleName} on this company.`);
      if (!(moduleName in sequenceCursor)) {
        sequenceCursor[moduleName] = String(setting.nextSequence || setting.startingSequence || '1');
      }
      const current = sequenceCursor[moduleName];
      sequenceCursor[moduleName] = String(Number(current) + 1).padStart(current.length, '0');
      return `${setting.useCustomPrefix ? setting.prefix : ''}${current}`;
    };

    // Whoever raised the company's existing paperwork is credited with these too, so the
    // "added by" column is not blank on screen.
    const existingDoc =
      (await db.books.collection('invoices').findOne({ companyId, addedBy: { $ne: null } })) ||
      (await db.books.collection('grpoorders').findOne({ companyId, addedBy: { $ne: null } }));
    const userId = existingDoc?.addedBy || null;

    // ---- what the ledger is expected to end up holding --------------------------------------
    // Registered from the figures each document is built with, not from the posting code.
    const expected = {};
    const effect = (key, debit = 0, credit = 0) => {
      expected[key] = round2((expected[key] || 0) + debit - credit);
    };

    const AR = account('ACCOUNTS_RECEIVABLE');
    const AP = account('ACCOUNTS_PAYABLE');
    const SALES_ACC = account('SALES');
    const INVENTORY = account('INVENTORY_ASSET');
    const COGS_ACC = account('COST_OF_GOODS_SOLD');
    const PETTY = account('PETTY_CASH');
    const UNDEPOSITED = account('UNDEPOSITED_FUNDS');

    // ---- masters ---------------------------------------------------------------------------
    const partner = (index, role) => {
      const isVendor = role === 'vendor';
      const label = role === 'both' ? 'Both' : isVendor ? 'Vendor' : 'Customer';
      const name = `LT ${label} ${String(index).padStart(2, '0')}`;
      return {
        _id: oid(),
        ...base,
        customerNumber: nextNumber(isVendor ? 'VENDOR' : 'CUSTOMER'),
        companyLogo: '',
        configSource: 'COMPANY',
        includePriceListItemOnly: false,
        addedBy: userId,
        updatedBy: [],
        bpPrimaryContactName: { firstName: label, lastName: `Number ${index}` },
        businessPartnerType: index % 3 === 0 ? 'Individual' : 'Business',
        Role: { isCustomer: role !== 'vendor', isVendor: role !== 'customer' },
        companyName: `${name} Pvt Ltd`,
        customerDisplayName: name,
        bpEmail: `lt.${role}${index}@example.test`,
        customerPhoneNumber: `98765${String(43000 + index).slice(0, 5)}`,
        // A vendor is settled through payables, a customer through receivables.
        accountId: isVendor ? AP : AR,
        otherDetails: {
          gstTreatment: 'Registered Business Regular',
          gstinUin: `27AAAPL${String(1000 + index)}C1Z${index % 10}`,
          taxPreference: 'Taxable',
          pan: `AAAPL${String(1000 + index)}C`,
          currency,
          enablePortal: false,
          isCustomerPortalActivated: false,
          document: [],
          includePriceListItemOnly: false,
        },
        address: {
          billing: {
            address: { street1: `${index} Test Street`, street2: 'Industrial Area' },
            attention: name,
            city: 'Pune',
            country: 'India',
            pinCode: '411001',
            state: 'Maharashtra',
            phone: '',
            faxNumber: '',
          },
          shipping: {
            address: { street1: `${index} Test Street`, street2: 'Industrial Area' },
            attention: name,
            city: 'Pune',
            country: 'India',
            pinCode: '411001',
            state: 'Maharashtra',
            phone: '',
            faxNumber: '',
          },
          additionalShippingAddresses: [],
        },
        creditLimit: 100000,
        useBranchCreditLimit: false,
        useBranchPaymentTerms: false,
        isLinkedToVendor: role === 'both',
        restrictedModule: [],
        restrictedPaymentTermsModule: [],
        businessPartnerTeam: [],
        commentHistory: [],
        branch: [{ branchId: branch._id, openingBalance: 0, currentBalance: 0, creditLimit: 100000, isActive: true }],
        isActive: true,
        appName: 'BOOKS',
        createdAt: day(1),
        updatedAt: day(1),
      };
    };

    const customers = Array.from({ length: 10 }, (_, i) => partner(i + 1, 'customer'));
    const vendors = Array.from({ length: 8 }, (_, i) => partner(i + 1, 'vendor'));
    // Sold to and bought from. One accountId serves both, which is how the application behaves;
    // these are only used on sales here so the figures stay meaningful.
    const dualPartners = [partner(11, 'both'), partner(12, 'both')];
    const allPartners = [...customers, ...vendors, ...dualPartners];

    const makeItem = (index, name, sellingPrice, costPrice, { service = false, tracked = true } = {}) => ({
      _id: oid(),
      ...base,
      itemNo: nextNumber('ITEM'),
      itemName: name,
      description: `${name} — seeded for ledger testing`,
      itemType: service ? 'Service' : 'Goods',
      itemModelNo: `MDL-${index}`,
      itemStatus: true,
      itemCategory: { isGoods: !service, isService: service },
      trackInventory: !service && tracked,
      itemUnit: 'PIECES',
      gst: '18',
      hsnCode: service ? '998314' : '84713010',
      salesInformation: { isSellable: true, sellingPrice, salesAccountId: SALES_ACC },
      purchaseInformation: { isPurchasable: true, costPrice, purchaseAccountId: COGS_ACC },
      inventoryAccountId: !service && tracked ? INVENTORY : null,
      attachments: [],
      customFields: [],
      commentHistory: [],
      itemGroup: null,
      defaultPrice: sellingPrice,
      itemClassification: { inventoryItem: !service && tracked, purchasingItem: true, salesItem: true },
      nextSequence: 1,
      addedBy: userId,
      updatedBy: [],
      appName: 'BOOKS',
      createdAt: day(1),
      updatedAt: day(1),
    });

    const itemA = makeItem(1, 'LT Widget A', 150, 100);
    const itemB = makeItem(2, 'LT Widget B', 300, 200);
    const itemC = makeItem(3, 'LT Widget C', 500, 350);
    const itemD = makeItem(4, 'LT Widget D', 250, 180);
    const rm1 = makeItem(5, 'LT Raw Material 1', 80, 50);
    const rm2 = makeItem(6, 'LT Raw Material 2', 60, 30);
    const rm3 = makeItem(7, 'LT Raw Material 3', 40, 20);
    const fg1 = makeItem(8, 'LT Finished Good 1', 400, 0);
    const fg2 = makeItem(9, 'LT Finished Good 2', 600, 0);
    const scrapItem = makeItem(10, 'LT Scrap Output', 10, 5);
    const svc1 = makeItem(11, 'LT Installation Service', 1000, 600, { service: true });
    const svc2 = makeItem(12, 'LT Annual Support', 2500, 1500, { service: true });
    // Goods the company does not keep stock of: buying it is an expense, not inventory.
    const consumable = makeItem(13, 'LT Consumable (untracked)', 90, 60, { tracked: false });
    const items = [itemA, itemB, itemC, itemD, rm1, rm2, rm3, fg1, fg2, scrapItem, svc1, svc2, consumable];

    // ---- stock ------------------------------------------------------------------------------
    let batchCounter = 7000;
    const batches = [];
    const stockByItem = new Map();
    const addStock = (item, quantity, purchasePrice, sourceType, sourceId, createdAt) => {
      const batch = {
        _id: oid(),
        ...base,
        itemId: item._id,
        batchNo: ++batchCounter,
        quantity,
        remainingQty: quantity,
        purchasePrice,
        vendorBatchNo: null,
        userBatchNo: null,
        vendorBatchExpiry: null,
        sourceType,
        sourceId,
        deductions: [],
        createdAt,
        updatedAt: createdAt,
      };
      batches.push(batch);
      if (!stockByItem.has(String(item._id))) stockByItem.set(String(item._id), []);
      stockByItem.get(String(item._id)).push(batch);
      return batch;
    };
    const asLine = (batch, quantity) => ({
      batchNo: batch.batchNo,
      quantity,
      purchasePrice: batch.purchasePrice,
      sellingPrice: 0,
      warehouseId: warehouse._id,
      itemBatchId: batch._id,
    });
    // Stock leaves oldest first, at the cost it came in at — the trail the backfill reads back.
    const takeStock = (item, quantity, deductedSourceType, deductedSourceId, when) => {
      const pool = stockByItem.get(String(item._id)) || [];
      let left = quantity;
      let cost = 0;
      const lines = [];
      for (const batch of pool) {
        if (left <= 0) break;
        if (batch.remainingQty <= 0) continue;
        const take = Math.min(batch.remainingQty, left);
        batch.remainingQty -= take;
        batch.deductions.push({
          deductedSourceType,
          deductedSourceId,
          quantityDeducted: take,
          deductedAt: when,
          sellingPrice: 0,
        });
        cost = round2(cost + take * batch.purchasePrice);
        lines.push(asLine(batch, take));
        left -= take;
      }
      if (left > 0) throw new Error(`Fixture asks for ${quantity} of ${item.itemName} but only ${quantity - left} is in stock.`);
      return { lines, cost };
    };

    // ---- opening balances -------------------------------------------------------------------
    // Every opening balance faces the Opening Balance Adjustment account, so the pair balances.
    const OB_CONTRA = 'OPENING_BALANCE_ADJUSTMENT';
    const accountOpeningBalances = [];
    const addAccountOb = (key, amount, balanceType, date) => {
      accountOpeningBalances.push({
        _id: oid(),
        companyId,
        seedTag: SEED_TAG,
        accountId: account(key),
        amount,
        balanceType,
        openingBalanceDate: date,
        isActive: true,
        updatedBy: [],
        createdAt: date,
        updatedAt: date,
      });
      if (balanceType === 'Debit') {
        effect(key, amount, 0);
        effect(OB_CONTRA, 0, amount);
      } else {
        effect(key, 0, amount);
        effect(OB_CONTRA, amount, 0);
      }
    };
    addAccountOb('PETTY_CASH', 50000, 'Debit', day(1));
    addAccountOb('UNDEPOSITED_FUNDS', 12000, 'Debit', day(1));
    addAccountOb('FURNITURE_AND_EQUIPMENT', 80000, 'Debit', day(1));
    addAccountOb('INVESTMENTS', 25000, 'Debit', day(1));
    addAccountOb('OWNERS_EQUITY', 150000, 'Credit', day(1));
    addAccountOb('MORTGAGES', 17000, 'Credit', day(1));

    // All four party opening balance types: two ways to owe us, two ways we owe them.
    const partyOpeningBalances = [];
    const addPartyOb = (party, type, amount, date) => {
      const isCustomer = party.Role.isCustomer;
      partyOpeningBalances.push({
        _id: oid(),
        companyId,
        seedTag: SEED_TAG,
        contactId: party._id,
        contactType: isCustomer ? 'customer' : 'vendor',
        type,
        amount,
        remainingAmount: amount,
        date,
        branchId: branch._id,
        currency,
        exchangeRate: 1,
        decimalPlaces: 2,
        transactionNo: `LT-OB-${partyOpeningBalances.length + 1}`,
        createdAt: date,
        updatedAt: date,
      });
      const controlKey = isCustomer ? 'ACCOUNTS_RECEIVABLE' : 'ACCOUNTS_PAYABLE';
      const isDebit = type === 'opening_receivable' || type === 'vendor_credit';
      if (isDebit) {
        effect(controlKey, amount, 0);
        effect(OB_CONTRA, 0, amount);
      } else {
        effect(controlKey, 0, amount);
        effect(OB_CONTRA, amount, 0);
      }
    };
    addPartyOb(customers[0], 'opening_receivable', 15000, day(1));
    addPartyOb(customers[1], 'opening_receivable', 8000, day(1));
    addPartyOb(customers[2], 'opening_receivable', 4500, day(1));
    addPartyOb(customers[3], 'customer_credit', 3000, day(1));
    addPartyOb(customers[4], 'customer_credit', 1200, day(1));
    addPartyOb(vendors[0], 'opening_payable', 20000, day(1));
    addPartyOb(vendors[1], 'opening_payable', 6500, day(1));
    addPartyOb(vendors[2], 'vendor_credit', 2800, day(1));

    // Opening stock: value enters inventory against the same adjustment account.
    const itemInventories = [];
    const addOpeningStock = (item, quantity, rate) => {
      addStock(item, quantity, rate, 'OPENING_STOCK', item._id, day(1));
      const value = round2(quantity * rate);
      itemInventories.push({
        _id: oid(),
        companyId,
        seedTag: SEED_TAG,
        itemId: item._id,
        totalOpeningStock: quantity,
        totalAvailableStock: quantity,
        totalInventoryValue: value,
        warehouses: [
          {
            warehouseId: warehouse._id,
            branchId: branch._id,
            divisionId: branch.divisionId,
            openingStock: quantity,
            availableStock: quantity,
            inventoryValue: value,
            isActive: true,
          },
        ],
        updatedBy: [],
        createdAt: day(1),
        updatedAt: day(1),
      });
      effect('INVENTORY_ASSET', value, 0);
      effect(OB_CONTRA, 0, value);
    };
    addOpeningStock(itemA, 50, 100);
    addOpeningStock(itemB, 20, 200);
    addOpeningStock(rm1, 100, 50);
    addOpeningStock(itemC, 10, 350);

    // ---- document helpers ---------------------------------------------------------------------
    const line = (item, quantity, rate, batchLines = []) => ({
      itemId: item._id,
      itemNo: item.itemNo,
      itemName: item.itemName,
      description: item.description,
      quantity,
      rate,
      amount: round2(quantity * rate),
      gst: '18',
      hsnCode: item.hsnCode,
      itemUnit: 'PIECES',
      taxAmount: round2(quantity * rate * 0.18),
      discountConfig: {},
      splitAmount: 0,
      splitTax: 0,
      batches: batchLines,
    });

    // 'igst' for a sale across a state line, 'gst' for one inside it.
    const taxSplit = (taxable, mode) => {
      const tax = round2(taxable * 0.18);
      if (mode === 'igst') return { igst: tax, sgst: 0, cgst: 0, totalTax: tax };
      const half = round2(tax / 2);
      return { igst: 0, sgst: half, cgst: round2(tax - half), totalTax: tax };
    };

    const docBase = (date, extra = {}) => ({
      ...base,
      appliesTo: 'LINE_ITEM',
      discountConfig: {},
      additionalCharges: [],
      sgst: 0,
      cgst: 0,
      igst: 0,
      totalTax: 0,
      discount: 0,
      currency,
      exchangeRate: 1,
      decimalPlaces: 2,
      roundOffAmount: 0,
      isRoundOff: true,
      companyGstin: '27AAAPL9999C1ZP',
      companyLogo: '',
      // Every list screen filters on isSplit === false. A document without the field is not
      // matched by that filter and simply never appears, however correct its figures are.
      isSplit: false,
      bankId: null,
      referenceNumber: '',
      subject: '',
      customerNotes: '',
      termsAndConditions: '',
      authorizedSignature: '',
      attachments: [],
      commentHistory: [],
      inventoryConfig: {},
      addedBy: userId,
      updatedBy: [],
      createdAt: date,
      updatedAt: date,
      ...extra,
    });

    // ---- purchases: goods in, then the bill that pays for them --------------------------------
    const grpos = [];
    const addGrpo = (index, vendor, receipts, date) => {
      const id = oid();
      const lines = receipts.map(({ item, quantity, rate }) => {
        const batch = addStock(item, quantity, rate, 'GRPO', id, date);
        return line(item, quantity, rate, [asLine(batch, quantity)]);
      });
      const subTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      grpos.push({
        _id: id,
        ...docBase(date),
        grpoOrderId: nextNumber('GRPO'),
        vendor: vendor._id,
        addressId: vendor._id,
        date,
        dueDate: date,
        reference: '',
        paymentTerms: 'Due on Receipt',
        status: index % 5 === 0 ? 'CONVERTED' : 'RECORDED',
        items: lines,
        subTotal,
        total: subTotal,
        purchaseOrders: [],
        convertedTo: [],
        stockAddEnabled: true,
        stockHandledInBatch: true,
      });
      effect('INVENTORY_ASSET', subTotal, 0);
      effect('GOODS_RECEIVED_NOT_INVOICED', 0, subTotal);
      return { id, subTotal };
    };

    const grpo1 = addGrpo(1, vendors[0], [{ item: itemA, quantity: 100, rate: 100 }], day(2));
    const grpo2 = addGrpo(
      2,
      vendors[0],
      [
        { item: rm1, quantity: 400, rate: 50 },
        { item: rm2, quantity: 500, rate: 30 },
      ],
      day(2),
    );
    const grpo3 = addGrpo(3, vendors[1], [{ item: itemB, quantity: 60, rate: 200 }], day(3));
    const grpo4 = addGrpo(4, vendors[1], [{ item: itemC, quantity: 40, rate: 350 }], day(3));
    const grpo5 = addGrpo(5, vendors[2], [{ item: itemD, quantity: 80, rate: 180 }], day(4));
    const grpo6 = addGrpo(6, vendors[2], [{ item: rm3, quantity: 300, rate: 20 }], day(4));
    const grpo7 = addGrpo(7, vendors[3], [{ item: itemA, quantity: 50, rate: 110 }], day(5));
    const grpo8 = addGrpo(8, vendors[3], [{ item: rm2, quantity: 200, rate: 32 }], day(5));
    const grpo9 = addGrpo(9, vendors[4], [{ item: itemB, quantity: 30, rate: 210 }], day(6));
    const grpo10 = addGrpo(10, vendors[4], [{ item: itemC, quantity: 20, rate: 360 }], day(6));

    // A bill against a receipt clears GRNI; a bill with no receipt behind it is a cost as it stands.
    const bills = [];
    const billRefs = [];
    const addBill = (index, vendor, spec) => {
      const { date, taxMode = 'igst', grpo = null, purchaseLines = [], charges = 0, discountPct = 0 } = spec;
      const billId = oid();
      const lines = purchaseLines.map(({ item, quantity, rate }) => line(item, quantity, rate));
      const subTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      const discount = discountPct ? round2((subTotal * discountPct) / 100) : 0;
      const taxable = round2(subTotal - discount);
      const tax = taxSplit(taxable, taxMode);
      const total = round2(taxable + charges + tax.totalTax);

      bills.push({
        _id: billId,
        ...docBase(date, {
          ...tax,
          discount,
          appliesTo: discountPct ? 'TRANSACTION' : 'LINE_ITEM',
          discountConfig: discountPct ? { discountType: 'PERCENTAGE', discountValue: discountPct } : {},
          additionalCharges: charges ? [{ name: 'Freight inward', amount: charges, isTaxable: false, taxRate: 0 }] : [],
        }),
        billId: nextNumber('BILL'),
        vendor: vendor._id,
        addressId: vendor._id,
        billDate: date,
        dueDate: date,
        paymentTerms: 'Due on Receipt',
        status: index % 4 === 0 ? 'PARTIALLY_PAID' : 'OPEN',
        items: lines,
        grpoIds: grpo ? [grpo.id] : [],
        subTotal,
        total,
        paidAmount: 0,
        balanceAmount: total,
        purchaseOrders: [],
        creditsApplied: [],
        openingBalanceApplications: [],
        stockAddEnabled: false,
        stockHandledInBatch: true,
      });

      effect('ACCOUNTS_PAYABLE', 0, total);
      if (grpo) effect('GOODS_RECEIVED_NOT_INVOICED', subTotal, 0);
      else purchaseLines.forEach(({ quantity, rate }) => effect('COST_OF_GOODS_SOLD', round2(quantity * rate), 0));
      if (discount) effect('PURCHASE_DISCOUNTS', 0, discount);
      if (charges) effect('OTHER_EXPENSES', charges, 0);
      if (tax.igst) effect('INPUT_IGST', tax.igst, 0);
      if (tax.sgst) effect('INPUT_SGST', tax.sgst, 0);
      if (tax.cgst) effect('INPUT_CGST', tax.cgst, 0);
      billRefs.push({ id: billId, total });
      return { id: billId, total };
    };

    addBill(1, vendors[0], { date: day(7), grpo: grpo1, purchaseLines: [{ item: itemA, quantity: 100, rate: 100 }] });
    addBill(2, vendors[0], {
      date: day(7),
      grpo: grpo2,
      purchaseLines: [
        { item: rm1, quantity: 400, rate: 50 },
        { item: rm2, quantity: 500, rate: 30 },
      ],
    });
    addBill(3, vendors[1], {
      date: day(8),
      grpo: grpo3,
      taxMode: 'gst',
      purchaseLines: [{ item: itemB, quantity: 60, rate: 200 }],
    });
    addBill(4, vendors[1], { date: day(8), grpo: grpo4, purchaseLines: [{ item: itemC, quantity: 40, rate: 350 }] });
    addBill(5, vendors[2], {
      date: day(9),
      grpo: grpo5,
      taxMode: 'gst',
      purchaseLines: [{ item: itemD, quantity: 80, rate: 180 }],
    });
    addBill(6, vendors[2], { date: day(9), grpo: grpo6, purchaseLines: [{ item: rm3, quantity: 300, rate: 20 }] });
    addBill(7, vendors[3], { date: day(10), grpo: grpo7, purchaseLines: [{ item: itemA, quantity: 50, rate: 110 }] });
    addBill(8, vendors[3], { date: day(10), grpo: grpo8, purchaseLines: [{ item: rm2, quantity: 200, rate: 32 }] });
    // No receipt behind these: a service, an untracked consumable, and one carrying freight.
    addBill(9, vendors[5], { date: day(11), purchaseLines: [{ item: svc1, quantity: 3, rate: 600 }] });
    addBill(10, vendors[6], {
      date: day(11),
      taxMode: 'gst',
      purchaseLines: [{ item: consumable, quantity: 40, rate: 60 }],
      charges: 400,
    });
    addBill(11, vendors[7], { date: day(12), purchaseLines: [{ item: svc2, quantity: 2, rate: 1500 }], discountPct: 10 });
    addBill(12, vendors[4], { date: day(12), grpo: grpo9, purchaseLines: [{ item: itemB, quantity: 30, rate: 210 }] });
    addBill(13, vendors[4], { date: day(13), grpo: grpo10, purchaseLines: [{ item: itemC, quantity: 20, rate: 360 }] });

    // ---- sales -------------------------------------------------------------------------------
    const invoices = [];
    const invoiceRefs = [];
    const addInvoice = (index, customer, spec) => {
      const { date, taxMode = 'igst', saleLines = [], charges = 0, discountPct = 0 } = spec;
      const id = oid();
      let costTotal = 0;
      const lines = saleLines.map(({ item, quantity, rate }) => {
        if (item.trackInventory) {
          const { lines: batchLines, cost } = takeStock(item, quantity, 'INVOICE', id, date);
          costTotal = round2(costTotal + cost);
          return line(item, quantity, rate, batchLines);
        }
        return line(item, quantity, rate);
      });
      const subTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      const discount = discountPct ? round2((subTotal * discountPct) / 100) : 0;
      const taxable = round2(subTotal - discount);
      const tax = taxSplit(taxable, taxMode);
      const total = round2(taxable + charges + tax.totalTax);

      invoices.push({
        _id: id,
        ...docBase(date, {
          ...tax,
          discount,
          appliesTo: discountPct ? 'TRANSACTION' : 'LINE_ITEM',
          discountConfig: discountPct ? { discountType: 'PERCENTAGE', discountValue: discountPct } : {},
          additionalCharges: charges ? [{ name: 'Freight outward', amount: charges, isTaxable: false, taxRate: 0 }] : [],
        }),
        invoiceId: nextNumber('INVOICE'),
        customerId: customer._id,
        addressId: customer._id,
        invoiceDate: date,
        dueDate: date,
        terms: 'Due on Receipt',
        status: index % 5 === 0 ? 'PARTIALLY_PAID' : 'SENT',
        items: lines,
        subTotal,
        total,
        paidAmount: 0,
        balanceAmount: total,
        freightCharges: 0,
        salesOrders: [],
        deliveryChallanIds: [],
        creditsApplied: [],
        openingBalanceApplications: [],
        importInvoice: false,
        stockDeductEnabled: true,
      });

      effect('ACCOUNTS_RECEIVABLE', total, 0);
      effect('SALES', 0, subTotal);
      if (discount) effect('DISCOUNT', discount, 0);
      if (charges) effect('OTHER_CHARGES', 0, charges);
      if (tax.igst) effect('OUTPUT_IGST', 0, tax.igst);
      if (tax.sgst) effect('OUTPUT_SGST', 0, tax.sgst);
      if (tax.cgst) effect('OUTPUT_CGST', 0, tax.cgst);
      if (costTotal) {
        effect('COST_OF_GOODS_SOLD', costTotal, 0);
        effect('INVENTORY_ASSET', 0, costTotal);
      }
      invoiceRefs.push({ id, total });
      return { id, total };
    };

    addInvoice(1, customers[0], { date: day(14), saleLines: [{ item: itemA, quantity: 20, rate: 150 }] });
    addInvoice(2, customers[1], { date: day(14), taxMode: 'gst', saleLines: [{ item: itemB, quantity: 10, rate: 300 }] });
    addInvoice(3, customers[2], { date: day(15), saleLines: [{ item: svc1, quantity: 2, rate: 1000 }], charges: 500 });
    addInvoice(4, customers[3], { date: day(15), saleLines: [{ item: itemB, quantity: 10, rate: 300 }], discountPct: 10 });
    addInvoice(5, customers[4], {
      date: day(16),
      taxMode: 'gst',
      saleLines: [
        { item: itemC, quantity: 5, rate: 500 },
        { item: itemD, quantity: 8, rate: 250 },
      ],
    });
    addInvoice(6, customers[5], { date: day(16), saleLines: [{ item: itemA, quantity: 15, rate: 155 }] });
    addInvoice(7, customers[6], { date: day(17), saleLines: [{ item: svc2, quantity: 1, rate: 2500 }] });
    addInvoice(8, customers[7], {
      date: day(17),
      taxMode: 'gst',
      saleLines: [{ item: itemD, quantity: 12, rate: 250 }],
      charges: 250,
    });
    addInvoice(9, customers[8], { date: day(18), saleLines: [{ item: itemC, quantity: 6, rate: 520 }], discountPct: 5 });
    addInvoice(10, dualPartners[0], {
      date: day(18),
      saleLines: [
        { item: itemA, quantity: 10, rate: 150 },
        { item: svc1, quantity: 1, rate: 1000 },
      ],
    });

    // ---- returns -------------------------------------------------------------------------------
    const creditNotes = [];
    const addCreditNote = (index, customer, spec) => {
      const { date, taxMode = 'igst', returnLines = [] } = spec;
      const id = oid();
      let costTotal = 0;
      const lines = returnLines.map(({ item, quantity, rate, cost }) => {
        if (item.trackInventory && cost) {
          const batch = addStock(item, quantity, cost, 'CREDIT_NOTE', id, date);
          costTotal = round2(costTotal + quantity * cost);
          return line(item, quantity, rate, [asLine(batch, quantity)]);
        }
        return line(item, quantity, rate);
      });
      const subTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      const tax = taxSplit(subTotal, taxMode);
      const total = round2(subTotal + tax.totalTax);

      creditNotes.push({
        _id: id,
        ...docBase(date, tax),
        creditNoteId: nextNumber('CREDIT_NOTE'),
        customerId: customer._id,
        addressId: customer._id,
        creditNoteDate: date,
        status: index % 4 === 0 ? 'PARTIALLY_USED' : 'OPEN',
        type: 'CREDIT_NOTE',
        items: lines,
        subTotal,
        total,
        availableBalance: total,
        invoicesApplied: [],
        refunds: [],
      });

      effect('ACCOUNTS_RECEIVABLE', 0, total);
      effect('SALES', subTotal, 0);
      if (tax.igst) effect('OUTPUT_IGST', tax.igst, 0);
      if (tax.sgst) effect('OUTPUT_SGST', tax.sgst, 0);
      if (tax.cgst) effect('OUTPUT_CGST', tax.cgst, 0);
      if (costTotal) {
        effect('INVENTORY_ASSET', costTotal, 0);
        effect('COST_OF_GOODS_SOLD', 0, costTotal);
      }
    };

    addCreditNote(1, customers[0], { date: day(19), returnLines: [{ item: itemA, quantity: 5, rate: 150, cost: 100 }] });
    addCreditNote(2, customers[1], {
      date: day(19),
      taxMode: 'gst',
      returnLines: [{ item: itemB, quantity: 2, rate: 300, cost: 200 }],
    });
    addCreditNote(3, customers[4], {
      date: day(20),
      taxMode: 'gst',
      returnLines: [{ item: itemD, quantity: 3, rate: 250, cost: 180 }],
    });
    addCreditNote(4, customers[5], { date: day(20), returnLines: [{ item: itemA, quantity: 4, rate: 155, cost: 100 }] });
    // Nothing physical comes back on a service return.
    addCreditNote(5, customers[2], { date: day(21), returnLines: [{ item: svc1, quantity: 1, rate: 1000 }] });
    addCreditNote(6, customers[6], { date: day(21), returnLines: [{ item: svc2, quantity: 1, rate: 500 }] });
    addCreditNote(7, customers[7], {
      date: day(22),
      taxMode: 'gst',
      returnLines: [{ item: itemD, quantity: 2, rate: 250, cost: 180 }],
    });
    addCreditNote(8, customers[8], { date: day(22), returnLines: [{ item: itemC, quantity: 1, rate: 520, cost: 350 }] });

    const debitNotes = [];
    const addDebitNote = (index, vendor, spec) => {
      const { date, taxMode = 'igst', returnLines = [] } = spec;
      const id = oid();
      let stockCost = 0;
      let expenseTotal = 0;
      const lines = returnLines.map(({ item, quantity, rate }) => {
        if (item.trackInventory) {
          const { lines: batchLines, cost } = takeStock(item, quantity, 'DEBIT_NOTE', id, date);
          stockCost = round2(stockCost + cost);
          return line(item, quantity, rate, batchLines);
        }
        expenseTotal = round2(expenseTotal + quantity * rate);
        return line(item, quantity, rate);
      });
      const subTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      const tax = taxSplit(subTotal, taxMode);
      const total = round2(subTotal + tax.totalTax);

      debitNotes.push({
        _id: id,
        ...docBase(date, tax),
        debitNoteId: nextNumber('DEBIT_NOTE'),
        vendorId: vendor._id,
        customer: vendor._id,
        addressId: vendor._id,
        debitNoteDate: date,
        status: index % 4 === 0 ? 'PARTIALLY_USED' : 'OPEN',
        type: 'DEBIT_NOTE',
        items: lines,
        subTotal,
        total,
        availableBalance: total,
        billsApplied: [],
        refunds: [],
      });

      effect('ACCOUNTS_PAYABLE', total, 0);
      if (stockCost) effect('INVENTORY_ASSET', 0, stockCost);
      if (expenseTotal) effect('COST_OF_GOODS_SOLD', 0, expenseTotal);
      // Returning stock at a price above its cost leaves a margin against purchase discounts.
      const stockValue = round2(subTotal - expenseTotal);
      const difference = round2(stockValue - stockCost);
      if (difference) effect('PURCHASE_DISCOUNTS', difference < 0 ? -difference : 0, difference > 0 ? difference : 0);
      if (tax.igst) effect('INPUT_IGST', 0, tax.igst);
      if (tax.sgst) effect('INPUT_SGST', 0, tax.sgst);
      if (tax.cgst) effect('INPUT_CGST', 0, tax.cgst);
    };

    addDebitNote(1, vendors[0], { date: day(23), returnLines: [{ item: itemA, quantity: 5, rate: 100 }] });
    addDebitNote(2, vendors[1], { date: day(23), taxMode: 'gst', returnLines: [{ item: itemB, quantity: 3, rate: 200 }] });
    addDebitNote(3, vendors[2], { date: day(24), returnLines: [{ item: itemD, quantity: 4, rate: 180 }] });
    addDebitNote(4, vendors[2], { date: day(24), returnLines: [{ item: rm3, quantity: 10, rate: 20 }] });
    addDebitNote(5, vendors[3], { date: day(25), returnLines: [{ item: rm2, quantity: 20, rate: 32 }] });
    addDebitNote(6, vendors[5], { date: day(25), returnLines: [{ item: svc1, quantity: 1, rate: 600 }] });
    addDebitNote(7, vendors[6], { date: day(26), taxMode: 'gst', returnLines: [{ item: consumable, quantity: 5, rate: 60 }] });
    addDebitNote(8, vendors[4], { date: day(26), returnLines: [{ item: itemC, quantity: 2, rate: 360 }] });

    // ---- money out ------------------------------------------------------------------------------
    const expenses = [];
    const addExpense = (index, accountKey, amount, date, vendor = null) => {
      expenses.push({
        _id: oid(),
        ...base,
        seedTag: SEED_TAG,
        expenseId: nextNumber('EXPENSE'),
        referenceNumber: '',
        date,
        amount,
        expenseAccount: account(accountKey),
        paidThroughAccountId: PETTY,
        paidThrough: 'PETTY_CASH',
        customer: vendor ? vendor._id : null,
        currency,
        exchangeRate: 1,
        notes: `Seeded ${accountKey.toLowerCase().replace(/_/g, ' ')}`,
        attachments: [],
        commentHistory: [],
        isSplit: false,
        addedBy: userId,
        updatedBy: [],
        createdAt: date,
        updatedAt: date,
      });
      effect(accountKey, amount, 0);
      effect('PETTY_CASH', 0, amount);
    };
    addExpense(1, 'RENT_EXPENSE', 5000, day(27));
    addExpense(2, 'TELEPHONE_EXPENSE', 1200, day(27));
    addExpense(3, 'OFFICE_SUPPLIES', 800, day(27), vendors[5]);
    addExpense(4, 'TRAVEL_EXPENSE', 3400, day(28));
    addExpense(5, 'ADVERTISING_AND_MARKETING', 2500, day(28));
    addExpense(6, 'IT_AND_INTERNET_EXPENSES', 1800, day(28), vendors[6]);
    addExpense(7, 'REPAIRS_AND_MAINTENANCE', 950, day(29));
    addExpense(8, 'POSTAGE', 300, day(29));
    addExpense(9, 'BANK_FEES_AND_CHARGES', 150, day(29));
    addExpense(10, 'MEALS_AND_ENTERTAINMENT', 1100, day(30));

    // ---- money in and out ------------------------------------------------------------------------
    const paymentsReceived = [];
    // What the receipt settles is read back off the invoices it names, so the figure recorded and
    // the figure expected come from the same place and cannot drift apart.
    const addPaymentReceived = (index, customer, spec) => {
      const { date, applyTo = [], unused = 0 } = spec;
      const applications = applyTo.map(({ invoice, amount }) => ({ invoiceId: invoice.id, amountApplied: amount }));
      const applied = round2(applications.reduce((sum, entry) => sum + entry.amountApplied, 0));
      paymentsReceived.push({
        _id: oid(),
        ...base,
        seedTag: SEED_TAG,
        paymentReceivedId: nextNumber('PAYMENT_RECEIVED'),
        isSplit: false,
        referenceNumber: '',
        notes: 'Seeded receipt',
        addedBy: userId,
        customerId: customer._id,
        paymentDate: date,
        status: 'APPROVED',
        approvalDate: date,
        currency,
        exchangeRate: 1,
        depositToAccountId: index % 3 === 0 ? UNDEPOSITED : PETTY,
        paymentMode: index % 2 === 0 ? 'BANK_TRANSFER' : 'CHEQUE',
        amountReceived: round2(applied + unused),
        unusedAmount: unused,
        invoices: applications,
        openingBalanceTransactions: [],
        refunds: [],
        attachments: [],
        updatedBy: [],
        createdAt: date,
        updatedAt: date,
      });
      const depositKey = index % 3 === 0 ? 'UNDEPOSITED_FUNDS' : 'PETTY_CASH';
      effect(depositKey, round2(applied + unused), 0);
      if (applied) effect('ACCOUNTS_RECEIVABLE', 0, applied);
      if (unused) effect('UNEARNED_REVENUE', 0, unused);
    };
    // Settled in full, in part, split across two invoices, pure advance, and part-and-advance.
    addPaymentReceived(1, customers[0], { date: day(31), applyTo: [{ invoice: invoiceRefs[0], amount: invoiceRefs[0].total }] });
    addPaymentReceived(2, customers[1], { date: day(31), applyTo: [{ invoice: invoiceRefs[1], amount: 2000 }] });
    addPaymentReceived(3, customers[2], { date: day(31), applyTo: [{ invoice: invoiceRefs[2], amount: 1500 }] });
    addPaymentReceived(4, customers[3], { date: day(32), applyTo: [{ invoice: invoiceRefs[3], amount: 1000 }], unused: 500 });
    addPaymentReceived(5, customers[4], { date: day(32), unused: 2000 });
    addPaymentReceived(6, customers[5], { date: day(32), applyTo: [{ invoice: invoiceRefs[5], amount: 2600 }] });
    addPaymentReceived(7, customers[6], { date: day(33), unused: 1750 });
    addPaymentReceived(8, customers[7], { date: day(33), applyTo: [{ invoice: invoiceRefs[7], amount: 3000 }] });
    addPaymentReceived(9, customers[8], { date: day(33), applyTo: [{ invoice: invoiceRefs[8], amount: 1200 }], unused: 300 });
    addPaymentReceived(10, dualPartners[0], {
      date: day(34),
      applyTo: [
        { invoice: invoiceRefs[9], amount: 600 },
        { invoice: invoiceRefs[4], amount: 300 },
      ],
    });

    const paymentsMade = [];
    const addPaymentMade = (index, vendor, spec) => {
      const { date, applyTo = [], unused = 0 } = spec;
      const applications = applyTo.map(({ bill, amount }) => ({ billId: bill.id, amountApplied: amount }));
      const applied = round2(applications.reduce((sum, entry) => sum + entry.amountApplied, 0));
      paymentsMade.push({
        _id: oid(),
        ...base,
        seedTag: SEED_TAG,
        paymentMadeId: nextNumber('PAYMENT_MADE'),
        isSplit: false,
        referenceNumber: '',
        notes: 'Seeded payment',
        addedBy: userId,
        vendorId: vendor._id,
        paymentDate: date,
        status: 'APPROVED',
        approvalDate: date,
        currency,
        exchangeRate: 1,
        paidThroughAccountId: PETTY,
        paymentMode: index % 2 === 0 ? 'BANK_TRANSFER' : 'CHEQUE',
        amountPaid: round2(applied + unused),
        unusedAmount: unused,
        bills: applications,
        openingBalanceTransactions: [],
        refunds: [],
        attachments: [],
        updatedBy: [],
        createdAt: date,
        updatedAt: date,
      });
      if (applied) effect('ACCOUNTS_PAYABLE', applied, 0);
      if (unused) effect('PREPAID_EXPENSES', unused, 0);
      effect('PETTY_CASH', 0, round2(applied + unused));
    };
    addPaymentMade(1, vendors[0], { date: day(35), applyTo: [{ bill: billRefs[0], amount: billRefs[0].total }] });
    addPaymentMade(2, vendors[0], { date: day(35), applyTo: [{ bill: billRefs[1], amount: 5000 }] });
    addPaymentMade(3, vendors[1], { date: day(35), applyTo: [{ bill: billRefs[2], amount: 4200 }] });
    addPaymentMade(4, vendors[2], { date: day(36), applyTo: [{ bill: billRefs[4], amount: 3000 }], unused: 1000 });
    addPaymentMade(5, vendors[3], { date: day(36), unused: 2500 });
    addPaymentMade(6, vendors[4], { date: day(36), applyTo: [{ bill: billRefs[11], amount: 2200 }] });
    addPaymentMade(7, vendors[5], { date: day(37), applyTo: [{ bill: billRefs[8], amount: 1770 }] });
    addPaymentMade(8, vendors[6], { date: day(37), unused: 800 });
    addPaymentMade(9, vendors[7], { date: day(37), applyTo: [{ bill: billRefs[10], amount: 1500 }] });
    addPaymentMade(10, vendors[1], {
      date: day(38),
      applyTo: [{ bill: billRefs[3], amount: 900 }],
      unused: 100,
    });

    const bankTransfers = [];
    const addBankTransfer = (index, fromKey, toKey, amount, date) => {
      bankTransfers.push({
        _id: oid(),
        ...base,
        seedTag: SEED_TAG,
        fromAccountId: account(fromKey),
        toAccountId: account(toKey),
        amount,
        fromAmount: amount,
        toAmount: amount,
        fromCurrency: currency,
        toCurrency: currency,
        date,
        transactionType: 'TRANSFER',
        transactionStatus: 'APPROVED',
        approvedAt: date,
        transactionDescription: `Seeded transfer ${index}`,
        addedBy: userId,
        approvedBy: userId,
        updatedBy: [],
        createdAt: date,
        updatedAt: date,
      });
      effect(toKey, amount, 0);
      effect(fromKey, 0, amount);
    };
    addBankTransfer(1, 'PETTY_CASH', 'UNDEPOSITED_FUNDS', 2500, day(39));
    addBankTransfer(2, 'UNDEPOSITED_FUNDS', 'PETTY_CASH', 1200, day(39));
    addBankTransfer(3, 'PETTY_CASH', 'UNDEPOSITED_FUNDS', 3000, day(40));
    addBankTransfer(4, 'UNDEPOSITED_FUNDS', 'PETTY_CASH', 800, day(40));
    addBankTransfer(5, 'PETTY_CASH', 'UNDEPOSITED_FUNDS', 1500, day(41));
    addBankTransfer(6, 'UNDEPOSITED_FUNDS', 'PETTY_CASH', 2200, day(41));
    addBankTransfer(7, 'PETTY_CASH', 'UNDEPOSITED_FUNDS', 900, day(42));
    addBankTransfer(8, 'UNDEPOSITED_FUNDS', 'PETTY_CASH', 1100, day(42));

    // ---- stock counts ------------------------------------------------------------------------------
    const adjustments = [];
    const addAdjustment = (index, spec) => {
      const { date, item, quantity, rate, direction } = spec;
      const id = oid();
      let value;
      if (direction === 'in') {
        addStock(item, quantity, rate, 'INVENTORY_ADJUSTMENT', id, date);
        value = round2(quantity * rate);
        effect('INVENTORY_ASSET', value, 0);
        effect('DIMENSION_ADJUSTMENTS', 0, value);
      } else {
        const { cost } = takeStock(item, quantity, 'INVENTORY_ADJUSTMENT', id, date);
        value = cost;
        effect('DIMENSION_ADJUSTMENTS', value, 0);
        effect('INVENTORY_ASSET', 0, value);
      }
      adjustments.push({
        _id: id,
        ...base,
        seedTag: SEED_TAG,
        inventoryAdjustmentNumber: nextNumber('INVENTORY_ADJUSTMENT'),
        referenceNumber: '',
        createdBy: userId,
        approvedBy: userId,
        adjustmentDate: date,
        approvalDate: date,
        status: 'APPROVED',
        accountId: account('DIMENSION_ADJUSTMENTS'),
        reason: direction === 'in' ? 'Stock found on count' : 'Shrinkage on count',
        description: `Seeded adjustment ${index}`,
        items: [
          {
            itemId: item._id,
            currentStock: 0,
            updatedStock: direction === 'in' ? quantity : -quantity,
            adjustedStock: direction === 'in' ? quantity : -quantity,
            purchasePrice: rate,
          },
        ],
        updatedBy: [],
        createdAt: date,
        updatedAt: date,
      });
    };
    addAdjustment(1, { date: day(43), item: itemA, quantity: 10, rate: 100, direction: 'in' });
    addAdjustment(2, { date: day(43), item: itemB, quantity: 5, rate: 200, direction: 'in' });
    addAdjustment(3, { date: day(44), item: itemA, quantity: 4, rate: 100, direction: 'out' });
    addAdjustment(4, { date: day(44), item: itemC, quantity: 2, rate: 350, direction: 'out' });
    addAdjustment(5, { date: day(45), item: rm1, quantity: 25, rate: 50, direction: 'in' });
    addAdjustment(6, { date: day(45), item: rm2, quantity: 15, rate: 30, direction: 'out' });
    addAdjustment(7, { date: day(46), item: itemD, quantity: 6, rate: 180, direction: 'in' });
    addAdjustment(8, { date: day(46), item: itemD, quantity: 3, rate: 180, direction: 'out' });
    addAdjustment(9, { date: day(47), item: rm3, quantity: 20, rate: 20, direction: 'in' });
    addAdjustment(10, { date: day(47), item: rm3, quantity: 8, rate: 20, direction: 'out' });

    // ---- production ----------------------------------------------------------------------------------
    const productions = [];
    const addProduction = (index, spec) => {
      const { date, output, outputQty, consume, labour, overhead, scrap = null } = spec;
      const id = oid();

      let materialCost = 0;
      const consumed = consume.map(({ item, quantity }) => {
        const { cost } = takeStock(item, quantity, 'PRODUCTION_ORDER', id, date);
        materialCost = round2(materialCost + cost);
        effect('INVENTORY_ASSET', 0, cost);
        return { rawMaterialId: item._id, productionOrderSubmittedUnit: quantity, bomRRQty: 0, rejectQty: 0, returnQty: 0 };
      });

      let scrapValue = 0;
      if (scrap) {
        addStock(scrap.item, scrap.quantity, scrap.rate, 'PRODUCTION_ORDER', id, date);
        scrapValue = round2(scrap.quantity * scrap.rate);
        effect('INVENTORY_ASSET', scrapValue, 0);
      }

      // Finished goods carry everything that went in. Scrap does not reduce that: it is debited
      // to its own stock and credited to job costing, so it cancels itself out of the run.
      const finishedValue = round2(materialCost + labour + overhead);
      const unitCost = round2(finishedValue / outputQty);
      // The batch carries a rounded unit cost, so the run can be a few paise out either way.
      const bankedValue = round2(unitCost * outputQty);
      addStock(output, outputQty, unitCost, 'PRODUCTION_ORDER', id, date);
      effect('INVENTORY_ASSET', bankedValue, 0);
      effect('LABOR', 0, labour);
      effect('JOB_COSTING', 0, round2(overhead + scrapValue));
      const drift = round2(bankedValue - finishedValue);
      if (drift) effect('ROUND_OFF', drift < 0 ? -drift : 0, drift > 0 ? drift : 0);

      productions.push({
        _id: id,
        ...base,
        seedTag: SEED_TAG,
        productionOrderCode: nextNumber('PRODUCTION_ORDER'),
        createdBy: userId,
        productionOwner: userId,
        isSalesOrderBased: false,
        salesOrderId: null,
        productionWarehouseId: warehouse._id,
        inStockWarehouseId: warehouse._id,
        inventoryInwarehouseId: warehouse._id,
        manPower_inventoryTransfer: [],
        itemId: output._id,
        quantity: outputQty,
        productionDate: date,
        status: 'COMPLETED',
        productionManageMethod: 'BOM_BASED',
        totalFgSubmittedQty: outputQty,
        totalFgRejectedQty: 0,
        fgSubmittedQty: outputQty,
        fgRejectedQty: 0,
        stockHandledInBatch: true,
        isActive: true,
        batches: [],
        rawMaterials: consume.map(({ item, quantity }) => ({
          rawMaterialId: item._id,
          perItemRequiredUnit: round2(quantity / outputQty),
          productionOrderRequiredUnit: quantity,
          productionOrderSubmittedUnit: quantity,
          bomRRQty: 0,
          rejectQty: 0,
          returnQty: 0,
          batches: [],
        })),
        submissionHistory: [
          {
            submissionDate: date,
            fgSubmittedQty: outputQty,
            fgRejectedQty: 0,
            manpowerCost: [{ workerHours: round2(labour / 100), workerCost: labour }],
            additionalCost: { notes: 'Seeded overhead', amount: overhead },
            rawMaterialsConsumed: consumed,
          },
        ],
        updatedBy: [],
        createdAt: date,
        updatedAt: date,
      });
    };

    addProduction(1, {
      date: day(48),
      output: fg1,
      outputQty: 100,
      consume: [
        { item: rm1, quantity: 100 },
        { item: rm2, quantity: 100 },
      ],
      labour: 1000,
      overhead: 500,
    });
    addProduction(2, {
      date: day(48),
      output: fg2,
      outputQty: 50,
      consume: [
        { item: rm1, quantity: 50 },
        { item: rm3, quantity: 50 },
      ],
      labour: 800,
      overhead: 400,
    });
    addProduction(3, {
      date: day(49),
      output: fg1,
      outputQty: 40,
      consume: [{ item: rm2, quantity: 80 }],
      labour: 600,
      overhead: 200,
    });
    addProduction(4, {
      date: day(49),
      output: fg2,
      outputQty: 25,
      consume: [{ item: rm3, quantity: 60 }],
      labour: 500,
      overhead: 250,
    });
    // Some of what went in comes back as scrap, which lowers what the finished goods cost.
    addProduction(5, {
      date: day(50),
      output: fg1,
      outputQty: 60,
      consume: [{ item: rm1, quantity: 80 }],
      labour: 700,
      overhead: 300,
      scrap: { item: scrapItem, quantity: 20, rate: 5 },
    });
    addProduction(6, {
      date: day(50),
      output: fg2,
      outputQty: 30,
      consume: [{ item: rm2, quantity: 60 }],
      labour: 450,
      overhead: 150,
      scrap: { item: scrapItem, quantity: 10, rate: 5 },
    });
    addProduction(7, {
      date: day(51),
      output: fg1,
      outputQty: 20,
      consume: [{ item: rm3, quantity: 40 }],
      labour: 300,
      overhead: 100,
    });
    addProduction(8, {
      date: day(51),
      output: fg2,
      outputQty: 15,
      consume: [{ item: rm1, quantity: 30 }],
      labour: 250,
      overhead: 120,
    });

    // ---- write -----------------------------------------------------------------------------------------
    const writes = [
      ['booksCrm', 'customers', allPartners],
      ['booksCrm', 'items', items],
      ['booksCrm', 'itembatches', batches],
      ['booksCrm', 'iteminventories', itemInventories],
      ['booksCrm', 'openingbalancetransactions', partyOpeningBalances],
      ['books', 'accountopeningbalances', accountOpeningBalances],
      ['books', 'grpoorders', grpos],
      ['books', 'bills', bills],
      ['books', 'invoices', invoices],
      ['books', 'creditnotes', creditNotes],
      ['books', 'debitnotes', debitNotes],
      ['books', 'expenses', expenses],
      ['booksCrm', 'paymentreceiveds', paymentsReceived],
      ['books', 'paymentmades', paymentsMade],
      ['booksCrm', 'banktransferlogs', bankTransfers],
      ['books', 'inventoryadjustments', adjustments],
      ['books', 'productionorders', productions],
    ];

    let documentCount = 0;
    for (const [dbKey, collection, docs] of writes) {
      if (!docs.length) continue;
      documentCount += docs.length;
      if (apply) await db[dbKey].collection(collection).insertMany(docs);
      console.log(`   ${apply ? 'inserted' : 'would insert'} ${String(docs.length).padStart(4)}  ${collection}`);
    }

    // Move the company's numbering past what was just used, so the next document raised on screen
    // does not land on a number these already hold.
    console.log('');
    for (const [moduleName, cursor] of Object.entries(sequenceCursor)) {
      const setting = moduleSettings.find(row => row.moduleName === moduleName);
      const from = String(setting.nextSequence || setting.startingSequence || '1');
      if (apply) {
        await db.booksCrm.collection('modulesettings').updateOne({ companyId, moduleName }, { $set: { nextSequence: cursor } });
      }
      console.log(`   ${apply ? 'sequence' : 'would set'} ${moduleName.padEnd(22)} ${from} -> ${cursor}`);
    }

    // ---- the balance this should produce ---------------------------------------------------------------
    console.log(`\nEXPECTED TRIAL BALANCE from these ${documentCount} documents`);
    console.log(`${'ACCOUNT'.padEnd(34)}${'DEBIT'.padStart(14)}${'CREDIT'.padStart(14)}`);
    let debitTotal = 0;
    let creditTotal = 0;
    for (const [key, net] of Object.entries(expected).sort()) {
      if (!net) continue;
      const debit = net > 0 ? net : 0;
      const credit = net < 0 ? -net : 0;
      debitTotal = round2(debitTotal + debit);
      creditTotal = round2(creditTotal + credit);
      console.log(
        `${key.padEnd(34)}${(debit ? debit.toFixed(2) : '').padStart(14)}${(credit ? credit.toFixed(2) : '').padStart(14)}   ${nameOf(key)}`,
      );
    }
    console.log(
      `${'TOTAL'.padEnd(34)}${debitTotal.toLocaleString('en-IN').padStart(14)}${creditTotal.toLocaleString('en-IN').padStart(14)}`,
    );
    console.log(
      debitTotal === creditTotal
        ? '\nExpectation balances.'
        : '\nEXPECTATION DOES NOT BALANCE — the fixture is wrong, fix it before applying.',
    );

    console.log(
      apply
        ? `\nSeeded. Now run:  node migrations/backfillLedgerEntries.js ${companyId} --verify\n`
        : '\nNothing was written. Re-run with --apply.\n',
    );
  } catch (error) {
    console.error('Seed failed:', error.message);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

seed()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
