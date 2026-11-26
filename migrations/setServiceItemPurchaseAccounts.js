/**
 * Sets purchaseAccountId on service / expense items confirmed with the company owner.
 * Maps item _id -> exact accountName from the company chart of accounts.
 *
 * Purchase account picker in the app lists EXPENSE, COGS, OTHER_EXPENSE only.
 * Fixed-asset rows use "Furniture and Equipment" (FIXED_ASSET) — valid for bill posting.
 *
 * Run AFTER seedMissingSystemAccounts.js for the company.
 *
 * Mapped companies (all are processed — no companyId arg needed):
 *   69c90d21c86df473a32b1e4a  Victo Sales Impex (Rajat Sir)
 *   67820d444d677e00038d732d  Victo Sales Impex (main)
 *   687b91fc8460b8b86179a04e  OM PLAST INDUSTRIES
 *   6a3fb40704d9061d517dee3b  Tekom Industries
 *
 * Run: node migrations/setServiceItemPurchaseAccounts.js            (dry run, all mapped companies)
 *      node migrations/setServiceItemPurchaseAccounts.js --apply    (write)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PURCHASE_ACCOUNT_CATEGORIES = ['EXPENSE', 'COGS', 'OTHER_EXPENSE'];

const COMPANY_LABELS = {
  // '69c90d21c86df473a32b1e4a': 'Victo Sales Impex PVT LTD (Rajat Sir)',
  '67820d444d677e00038d732d': 'Victo Sales Impex PVT LTD (main)',
  '687b91fc8460b8b86179a04e': 'OM PLAST INDUSTRIES',
  '6a3fb40704d9061d517dee3b': 'Tekom Industries Private Limited',
  '67e158c40275d5000312cb9b': 'Dudhat ind',
  '6836d653f550bf7dae8ccfb4': 'JBRSYS TECH PVT LTD',
  '6837e7b40bdd2ab7af998221': 'Demo Infolanze',
  '683ee17943a85e163fbfe18d': 'ADAPTIVE BUSINESS SUPPORT SYSTEMS LLP',
  '689ef38cfb7b8117868bf512': 'ABSS',
};

// companyId -> { item _id: accountName }
const COMPANY_ITEM_PURCHASE_ACCOUNTS = {
  '67e158c40275d5000312cb9b': {
    '67f657bdf80c6e0004311c7b': 'Materials', // 16 RM-HOUSING SIDE ALLEN KEY NUTBOLT
  },

  '6836d653f550bf7dae8ccfb4': {
    '693c48a86551edc79e979702': 'Rent Expense', // I-00016 Rent
  },

  '6837e7b40bdd2ab7af998221': {
    '687a2e1d1a7e619e61582e97': 'Other Expenses', // I-00005 INFRA
  },

  '683ee17943a85e163fbfe18d': {
    '686b620e60df8b5c887219cd': 'IT and Internet Expenses', // I-00004 JULY - 2026 - ABSS Crm and Books ser
    '688aec9d5bc50299a1ead787': 'IT and Internet Expenses', // I-00005 ABSS software development cost
    '688aed0f5bc50299a1ead915': 'IT and Internet Expenses', // I-00006 AMC Cost Per Month
    '689c381bb22cf98d01eed7b3': 'IT and Internet Expenses', // I-00007 E invoice and E way bill Development
  },

  '689ef38cfb7b8117868bf512': {
    '68b7e91fd77ec7bf04d932f4': 'Materials', // I-00002 Wire
  },

  '69c90d21c86df473a32b1e4a': {
    '69c90ee58b437c029607c4a4': 'Consultant Expense', // I-00248 PROFESSIONAL FEE
    '69c90ee58b437c029607c4a5': 'Labor', // I-00249 Anil Tiwari
    '69c90ee58b437c029607c4a6': 'Labor', // I-00250 Jitendra bhai
    '69c90ee58b437c029607c4a7': 'Other Expenses', // I-00251 Nirali Ben -loan processing
    '69c90ee58b437c029607c4a8': 'Other Expenses', // I-00252 DUDHAT FUND USE FOR VICTO
    '69c90ee58b437c029607c4a9': 'Other Expenses', // I-00253 218 VICTO BAKROL OFFICE EXP
    '69c90ee58b437c029607c4aa': 'Labor', // I-00254 ASHISH SONAKI
    '69c90ee58b437c029607c4cf': 'Other Expenses', // I-00291 Stall Rent
    '69c90ee58b437c029607c4d0': 'Other Expenses', // I-00292 Transport Exp
    '69c90ee58b437c029607c4d1': 'Materials', // I-00293 Crown Led
    '69c90ee58b437c029607c4dd': 'Other Expenses', // I-00305 Reimbursement of Exp
    '69c90ee58b437c029607c4de': 'Materials', // I-00306 STATIONARY AND PRINTING EXP.12%
    '69c90ee58b437c029607c4df': 'Materials', // I-00307 STATIONARY AND PRINTING EXP. 18 %
    '69c90ee58b437c029607c4e1': 'Other Expenses', // I-00309 SOFTWARE CHARGES
    '69c90ee58b437c029607c4e2': 'Other Expenses', // I-00310 ADVIRSMENT FOR NEWS PAPER
    '69c90ee58b437c029607c4e4': 'Materials', // I-00312 CR SHEET
    '69c90ee58b437c029607c4e5': 'Materials', // I-00313 HARDWARE ITEM
    '69c90ee58b437c029607c54e': 'Other Expenses', // I-00418 REIMBURSEMENT OF EXP
    '69c90ee58b437c029607c577': 'Other Expenses', // I-00460 DUDHAT INDUSTRIES PRIVATE LIMITED - Loan
    '69c90ee58b437c029607c5e0': 'Labor', // I-00568 kaushik Valand
    '69c90ee58b437c029607c614': 'Materials', // I-00620 MOULD (FOR MAKING LED FLOOD LIGHT
    '69c90ee58b437c029607c6a1': 'Other Expenses', // I-00761 E INVOICE ND E WAY BILL DEVLOPMANET
    '69c90ee58b437c029607c6ca': 'Consultant Expense', // I-00802 Professional Fees with Taxble
    '69c90ee58b437c029607c700': 'Materials', // I-00856 Amron A Quanta 26 Ah
    '69c90ee58b437c029607c79d': 'Other Expenses', // I-01013 ADVIRSMENT FOR NEWS PAPER (NON TAX)
    '69c90ee58b437c029607c79f': 'Other Expenses', // I-01015 INTERNET EXP
    '69c90ee58b437c029607c7a1': 'Other Expenses', // I-01017 KCMP7
    '69c90ee58b437c029607c7a7': 'Other Expenses', // I-01023 PRINTER RENT
    '69c90ee58b437c029607c7bc': 'Other Expenses', // I-01044 POST AND COURIER EXPENSES
    '69c90ee58b437c029607c812': 'Other Expenses', // I-01130 AGENCY CHARGES
    '69c90ee58b437c029607c82a': 'Other Expenses', // I-01154 Container Charges
    '69c90ee58b437c029607c89a': 'Materials', // I-01266 HARDWARE ITEM 5 %
    '69c90ee58b437c029607c9bd': 'Furniture and Equipment', // I-01557 MICROSCOPE
    '69c90ee58b437c029607c9be': 'Furniture and Equipment', // I-01558 DISPLAY SCREEN
    '69c90ee58b437c029607c9bf': 'Furniture and Equipment', // I-01559 SLICER
    '69c90ee58b437c029607c9c0': 'Furniture and Equipment', // I-01560 POLISHING MACHINE
    '69c90ee58b437c029607c9c1': 'Furniture and Equipment', // I-01561 HIPOT TEST MACHINE
    '69c90ee58b437c029607c9c2': 'Furniture and Equipment', // I-01562 LAB MIXER
    '69c90ee58b437c029607c9c3': 'Furniture and Equipment', // I-01563 LAB THREE-ROLL MACHINE
    '69c90ee58b437c029607c9cd': 'Other Expenses', // I-01573 CONTAINER HANDLING CHARGES ALL
    '69c90ee58b437c029607c9db': 'Other Expenses', // I-01587 HOTEL EXP
    '69c90ee58b437c029607c9de': 'Materials', // I-01590 ELECTRICAL MATERIALS EXP
  },

  '67820d444d677e00038d732d': {
    '6867a12bb9f5d86a495a0e64': 'Consultant Expense', // I-00248
    '6867b102b9f5d86a495a4836': 'Labor', // I-00249
    '6867c9e81a66b4579b5bc6ba': 'Labor', // I-00250
    '6867cbb31a66b4579b5bca05': 'Other Expenses', // I-00251
    '6867cc6f1a66b4579b5bcdaf': 'Other Expenses', // I-00252
    '6867cd5fb9f5d86a495a7598': 'Other Expenses', // I-00253
    '6867d2aeb9f5d86a495a8718': 'Labor', // I-00254
    '687234f13e1721907b1e35e0': 'Other Expenses', // I-00291
    '68723bed3e1721907b1e498b': 'Other Expenses', // I-00292
    '68723e06afaece8828328df3': 'Materials', // I-00293
    '6875f5bde02f43f6d26da7be': 'Other Expenses', // I-00305
    '6875f9fee02f43f6d26db069': 'Materials', // I-00306
    '6875fa40e02f43f6d26db587': 'Materials', // I-00307
    '687623f38b441c1e5ef4b116': 'Other Expenses', // I-00309
    '6876279f8b441c1e5ef4baec': 'Other Expenses', // I-00310
    '68762c81fd7fdff11bf8da59': 'Materials', // I-00312
    '6876382c8b441c1e5ef4e58c': 'Materials', // I-00313
    '68849ba898ce0caff683c9ca': 'Other Expenses', // I-00418
    '688855a205eadd48f135cea8': 'Other Expenses', // I-00460
    '6899c979ca1ec11627646376': 'Labor', // I-00568
    '68ac533f9743e7fc0d564313': 'Materials', // I-00620
    '68ce93656539ccfdefff0568': 'Other Expenses', // I-00761
    '68d635375cbe005c9cdbf7c7': 'Consultant Expense', // I-00802
    '68e8a17157c2891dcc1fee40': 'Materials', // I-00856
    '692822abec8cbe78d58de20e': 'Other Expenses', // I-01013
    '6928358e9291f5efdc0a3ed7': 'Other Expenses', // I-01015
    '69284831e15cd49f1a642e71': 'Other Expenses', // I-01017
    '69294558aa9485ac3c057872': 'Other Expenses', // I-01023
    '692d238f85fb168b72738ef6': 'Other Expenses', // I-01044
    '693be236fb57f3e8523072e5': 'Other Expenses', // I-01130
    '6941527118de4408c7262640': 'Other Expenses', // I-01154
    '69538b6a0133f15f59875198': 'Materials', // I-01266
    '69a041173874a2e8a3be7cbc': 'Furniture and Equipment', // I-01557
    '69a041689738cfc1979120db': 'Furniture and Equipment', // I-01558
    '69a041953874a2e8a3be837b': 'Furniture and Equipment', // I-01559
    '69a041d09738cfc19791245d': 'Furniture and Equipment', // I-01560
    '69a041fa9738cfc197912931': 'Furniture and Equipment', // I-01561
    '69a042219738cfc197912c46': 'Furniture and Equipment', // I-01562
    '69a042493874a2e8a3be8ed0': 'Furniture and Equipment', // I-01563
    '69a7ec0e3d237080587fbda3': 'Other Expenses', // I-01573
    '69abc54bee24d80803dbdc4f': 'Other Expenses', // I-01587
    '69aeaff6021981e4f2e09a46': 'Materials', // I-01590
    '6a5b28325423ed5e54d5d301': 'Other Expenses', // I-02372 ATTEDENCE SOFTWARE
  },

  '687b91fc8460b8b86179a04e': {
    '69184d7e068d8df28df23a2c': 'Other Expenses', // I-00140 SOFTWARE SERIVCE EXP
    '691ab92f546c6d67bd035f65': 'Other Expenses', // I-00141 POST AND COURIER EXP
    '691e9e4dea5a5e08c40669bf': 'Furniture and Equipment', // I-00142 CONTRUCTION PLANT
    '691eba2889cf291167709572': 'Furniture and Equipment', // I-00143 PLANT ND MACHINERY
    '691ed506ea5a5e08c4073b6d': 'Consultant Expense', // I-00144 Professional Fees with Taxble
    '691edfd7338659402a0aa979': 'Other Expenses', // I-00145 TRAVELLING EXP
    '691ee00de95dd7b4c956cf92': 'Other Expenses', // I-00146 TRAVELLING EXP WITH GST
    '69a042de3874a2e8a3be93b0': 'Furniture and Equipment', // I-00300 MICROSCOPE
    '69a0449a3874a2e8a3beb20a': 'Furniture and Equipment', // I-00301 DISPLAY SCREEN
    '69a0476c3874a2e8a3bebeee': 'Furniture and Equipment', // I-00303 POLISHING MACHINE
  },

  '6a3fb40704d9061d517dee3b': {
    '6a55c8a72838fdf233e084af': 'Other Expenses', // TKM-00037 ENTERPRISE (APP: BOOKS)
    '6a55d952357a247e56a53e6b': 'Other Expenses', // TKM-00038 Warehouse
    '6a55db8a357a247e56a5632c': 'Other Expenses', // TKM-00039 CRM Pro (monthly)
    '6a55dc312838fdf233e25d83': 'Other Expenses', // TKM-00040 Users
    '6a6b15cb561dd040aa5120d6': 'Other Expenses', // TKM-00048 postpaid plan
  },
};

const processCompany = async (db, companyKey, apply) => {
  const itemPurchaseMap = COMPANY_ITEM_PURCHASE_ACCOUNTS[companyKey];
  const companyId = new ObjectId(companyKey);
  const items = db.booksCrm.collection('items');
  const accounts = db.books.collection('accounts');

  const itemIds = Object.keys(itemPurchaseMap).map(id => new ObjectId(id));
  const accountNames = [...new Set(Object.values(itemPurchaseMap))];

  console.log('\n================================================================');
  console.log(`Company: ${companyKey} — ${COMPANY_LABELS[companyKey] || '?'}`);
  console.log(`Items in map: ${itemIds.length}\n`);

  const accountRows = await accounts
    .find({ companyId, accountName: { $in: accountNames } })
    .project({ accountName: 1, category: 1 })
    .toArray();
  const accountByName = new Map(accountRows.map(row => [row.accountName, row]));

  const missingNames = accountNames.filter(name => !accountByName.has(name));
  if (missingNames.length) {
    console.log('BLOCKED — these account names are missing in the company COA:');
    missingNames.forEach(name => console.log(`   ${name}`));
    console.log('Run seedMissingSystemAccounts.js --apply first. Skipping this company.');
    return { wouldSet: 0, wouldOverwrite: 0, alreadySame: 0, blocked: true };
  }

  for (const name of accountNames) {
    const row = accountByName.get(name);
    if (!PURCHASE_ACCOUNT_CATEGORIES.includes(row.category)) {
      console.log(
        `NOTE: "${name}" is category ${row.category} — not in item purchase dropdown, but will be set on item for bills.`,
      );
    }
  }

  const found = await items
    .find({ companyId, _id: { $in: itemIds } })
    .project({ itemNo: 1, itemName: 1, purchaseInformation: 1 })
    .toArray();

  const foundById = new Map(found.map(row => [String(row._id), row]));
  const notFound = itemIds.filter(id => !foundById.has(String(id)));

  let wouldSet = 0;
  let alreadySame = 0;
  let wouldOverwrite = 0;

  console.log(
    `\n${'ITEM ID'.padEnd(26)}${'ITEM NO'.padEnd(12)}${'NAME'.padEnd(28)}${'ACCOUNT'.padEnd(26)}${'CAT'.padEnd(14)}ACTION`,
  );
  for (const itemIdStr of Object.keys(itemPurchaseMap)) {
    const item = foundById.get(itemIdStr);
    const accountName = itemPurchaseMap[itemIdStr];
    const account = accountByName.get(accountName);

    if (!item) {
      console.log(
        `${itemIdStr.padEnd(26)}${'—'.padEnd(12)}${'(not found)'.padEnd(28)}${accountName.padEnd(26)}${account.category.padEnd(14)}SKIP`,
      );
      continue;
    }

    const currentId = item.purchaseInformation?.purchaseAccountId;
    const targetId = account._id;
    const same = currentId && String(currentId) === String(targetId);
    let action = 'SET';
    if (same) {
      action = 'OK';
      alreadySame += 1;
    } else if (currentId) {
      action = 'REPLACE';
      wouldOverwrite += 1;
      wouldSet += 1;
    } else {
      wouldSet += 1;
    }

    console.log(
      `${itemIdStr.padEnd(26)}${(item.itemNo || '—').padEnd(12)}${(item.itemName || '').slice(0, 27).padEnd(28)}${accountName.padEnd(26)}${account.category.padEnd(14)}${action}`,
    );

    if (apply && !same) {
      await items.updateOne({ _id: item._id, companyId }, { $set: { 'purchaseInformation.purchaseAccountId': targetId } });
    }
  }

  if (notFound.length) {
    console.log(`\nNOT FOUND in company (${notFound.length}): ${notFound.map(id => id.toString()).join(', ')}`);
  }

  console.log(`\nSummary: ${wouldSet} to set (${wouldOverwrite} overwrite), ${alreadySame} already correct`);
  return { wouldSet, wouldOverwrite, alreadySame, blocked: false };
};

const migrate = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');

    const db = await getConnection();
    client = db.client;

    const companyKeys = Object.keys(COMPANY_ITEM_PURCHASE_ACCOUNTS);
    console.log(apply ? 'Mode: APPLY' : 'Mode: dry run — pass --apply to write');
    console.log(`Purchase account UI categories: ${PURCHASE_ACCOUNT_CATEGORIES.join(', ')}`);
    console.log(`Mapped companies: ${companyKeys.length}`);

    const totals = { wouldSet: 0, wouldOverwrite: 0, alreadySame: 0, blocked: 0 };
    for (const companyKey of companyKeys) {
      const result = await processCompany(db, companyKey, apply);
      totals.wouldSet += result.wouldSet;
      totals.wouldOverwrite += result.wouldOverwrite;
      totals.alreadySame += result.alreadySame;
      if (result.blocked) totals.blocked += 1;
    }

    console.log('\n================================================================');
    console.log(
      `TOTAL across ${companyKeys.length} companies: ${totals.wouldSet} to set (${totals.wouldOverwrite} overwrite), ${totals.alreadySame} already correct, ${totals.blocked} blocked`,
    );
    if (!apply) console.log('Nothing written. Re-run with --apply to update items.');
    else console.log(`Updated ${totals.wouldSet} item(s) across all companies.`);
  } catch (error) {
    console.error('setServiceItemPurchaseAccounts failed:', error);
    throw error;
  } finally {
    if (client) await client.close();
  }
};

migrate();
