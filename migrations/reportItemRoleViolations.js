/**
 * Read-only report: would sellable / purchasable enforcement reject anything that exists?
 *
 * The item dropdowns now filter by role (sellable on sales screens, purchasable on
 * purchase screens), but the API is reachable directly, so documents may already hold
 * items that could not play that role. This counts them, so the decision to enforce at
 * document level is made on facts rather than assumption.
 *
 * Writes nothing.
 *
 * Run: node migrations/reportItemRoleViolations.js              (all companies)
 *      node migrations/reportItemRoleViolations.js <companyId>   (one company)
 *
 * Against another environment, supply its connection through the environment rather
 * than editing .env, for example:
 *   ABSS_CLUSTER='<uri>' ABSS_BOOKS='<db>' ABSS_CORE_DEV='<db>' ABSS_BOOKS_CRM_DEV='<db>' \
 *   ABSS_CRM_DEV='<db>' ABSS_ADMIN='<db>' node migrations/reportItemRoleViolations.js
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const SALES_DOCUMENTS = [
  { db: 'booksCrm', collection: 'quotes', label: 'Quotes' },
  { db: 'booksCrm', collection: 'salesorders', label: 'Sales Orders' },
  { db: 'books', collection: 'invoices', label: 'Invoices' },
  { db: 'books', collection: 'deliverychallans', label: 'Delivery Challans' },
  { db: 'books', collection: 'creditnotes', label: 'Credit Notes' },
];

const PURCHASE_DOCUMENTS = [
  { db: 'books', collection: 'purchaseorders', label: 'Purchase Orders' },
  { db: 'books', collection: 'grpoorders', label: 'GRPOs' },
  { db: 'books', collection: 'bills', label: 'Bills' },
  { db: 'books', collection: 'debitnotes', label: 'Debit Notes' },
];

const countDocumentsUsing = async (db, targets, itemIds, scope) => {
  let total = 0;
  for (const target of targets) {
    const count = itemIds.length
      ? await db[target.db].collection(target.collection).countDocuments({ ...scope, 'items.itemId': { $in: itemIds } })
      : 0;
    console.log(`   ${target.label.padEnd(20)}: ${count}`);
    total += count;
  }
  return total;
};

const report = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const targetCompanyId = process.argv[2] ? new ObjectId(process.argv[2]) : null;
    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};
    console.log(`\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}   (read-only)`);
    console.log(`Cluster: ${(process.env.ABSS_CLUSTER || '').replace(/\/\/.*@/, '//***@').split('/?')[0]}\n`);

    const items = db.booksCrm.collection('items');
    const notSellable = (
      await items
        .find({ ...scope, 'salesInformation.isSellable': { $ne: true } })
        .project({ _id: 1 })
        .toArray()
    ).map(item => item._id);
    const notPurchasable = (
      await items
        .find({ ...scope, 'purchaseInformation.isPurchasable': { $ne: true } })
        .project({ _id: 1 })
        .toArray()
    ).map(item => item._id);

    console.log(`items NOT sellable    : ${notSellable.length}`);
    console.log(`items NOT purchasable : ${notPurchasable.length}\n`);

    console.log('SALES documents containing a NOT-sellable item:');
    const salesTotal = await countDocumentsUsing(db, SALES_DOCUMENTS, notSellable, scope);

    console.log('\nPURCHASE documents containing a NOT-purchasable item:');
    const purchaseTotal = await countDocumentsUsing(db, PURCHASE_DOCUMENTS, notPurchasable, scope);

    console.log(`\nTOTAL sales docs affected   : ${salesTotal}`);
    console.log(`TOTAL purchase docs affected: ${purchaseTotal}`);
    console.log(
      salesTotal === 0 && purchaseTotal === 0
        ? '\nSafe: document level enforcement would reject nothing that exists today.\n'
        : '\nEnforcement would have blocked these documents when they were created.\n',
    );
  } catch (error) {
    console.error('Report failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

report();
