/**
 * Report: COMPLETED, BOM_BASED production orders that have no finished-goods batches.
 *
 * A BOM_BASED production order records its finished-goods stock on the top-level `batches`
 * array (pushed when a submission is processed - see submitProductionOrder() in
 * modules/production/addProduction/productionOrder.service.js). An order that ended up
 * status: COMPLETED with an empty/missing `batches` array is therefore suspicious - it was
 * marked done without ever recording the stock it was supposed to produce.
 *
 * Scoped to orders created in calendar year 2026 (createdAt).
 *
 * This script is READ-ONLY - it does not modify any data. It lists every matching order and
 * finishes with a company-wise count (including companyName) of how many were found.
 *
 * Usage:
 *   node migrations/reportCompletedBomBasedProductionOrdersWithoutBatches.js                    (all companies)
 *   node migrations/reportCompletedBomBasedProductionOrdersWithoutBatches.js --companyId=<id>    (one company)
 *
 * Against another environment, supply its connection through the environment rather than
 * editing .env, for example:
 *   ABSS_CLUSTER='<uri>' ABSS_BOOKS='<db>' ABSS_CORE_DEV='<db>' ABSS_BOOKS_CRM_DEV='<db>' \
 *   ABSS_CRM_DEV='<db>' ABSS_ADMIN='<db>' node migrations/reportCompletedBomBasedProductionOrdersWithoutBatches.js
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PRODUCTION_ORDER_STATUS_COMPLETED = 'COMPLETED';
const PRODUCTION_MANAGE_METHOD_BOM_BASED = 'BOM_BASED';
const CREATED_AT_YEAR_START = new Date('2026-01-01T00:00:00.000Z');
const CREATED_AT_YEAR_END = new Date('2027-01-01T00:00:00.000Z');

function parseArgs(argv) {
  const hit = argv.find(arg => arg.startsWith('--companyId='));
  const companyArg = hit === undefined ? undefined : hit.slice('--companyId='.length);

  if (companyArg !== undefined && !ObjectId.isValid(companyArg)) {
    throw new Error(`--companyId must be a valid ObjectId, got "${companyArg}"`);
  }

  return { companyId: companyArg ? new ObjectId(companyArg) : null };
}

function printSection(title, char = '─') {
  const line = char.repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

const report = async () => {
  let client;
  try {
    const { companyId: onlyCompanyId } = parseArgs(process.argv.slice(2));
    const db = await getConnection();
    client = db.client;

    printSection('reportCompletedBomBasedProductionOrdersWithoutBatches', '═');
    console.log(`\nScope: ${onlyCompanyId ? onlyCompanyId.toString() : 'ALL COMPANIES'}   (read-only)`);
    console.log(`createdAt window: 2026-01-01 to 2026-12-31`);

    const scope = {
      status: PRODUCTION_ORDER_STATUS_COMPLETED,
      productionManageMethod: PRODUCTION_MANAGE_METHOD_BOM_BASED,
      $or: [{ batches: { $exists: false } }, { batches: { $size: 0 } }],
      createdAt: { $gte: CREATED_AT_YEAR_START, $lt: CREATED_AT_YEAR_END },
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
    };

    const productionOrders = db.books.collection('productionorders');
    const orders = await productionOrders
      .find(scope)
      .project({
        productionOrderCode: 1,
        companyId: 1,
        itemId: 1,
        quantity: 1,
        fgSubmittedQty: 1,
        totalFgSubmittedQty: 1,
        status: 1,
        productionManageMethod: 1,
        batches: 1,
        productionDate: 1,
        createdAt: 1,
      })
      .toArray();

    if (!orders.length) {
      console.log('\n✅ No COMPLETED / BOM_BASED production orders with empty batches found.\n');
      return;
    }

    printSection('Matching production orders');
    console.table(
      orders.map(order => ({
        productionOrderId: order._id.toString(),
        productionOrderCode: order.productionOrderCode || '(none)',
        companyId: order.companyId ? order.companyId.toString() : '(none)',
        quantity: order.quantity ?? 0,
        fgSubmittedQty: order.fgSubmittedQty ?? 0,
        totalFgSubmittedQty: order.totalFgSubmittedQty ?? 0,
        batchesLength: (order.batches || []).length,
        productionDate: order.productionDate ? new Date(order.productionDate).toISOString().slice(0, 10) : '(none)',
        createdAt: order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 10) : '(none)',
      })),
    );

    const companyIds = [...new Set(orders.map(order => order.companyId?.toString()).filter(Boolean))].map(id => new ObjectId(id));
    const companies = await db.common
      .collection('companies')
      .find({ _id: { $in: companyIds } })
      .project({ name: 1 })
      .toArray();
    const companyNameById = new Map(companies.map(c => [c._id.toString(), c.name || '(unnamed company)']));

    const countByCompany = new Map();
    for (const order of orders) {
      const key = order.companyId ? order.companyId.toString() : '(none)';
      countByCompany.set(key, (countByCompany.get(key) || 0) + 1);
    }

    printSection('Count by company');
    console.table(
      [...countByCompany.entries()]
        .map(([companyId, count]) => ({
          companyName: companyId === '(none)' ? '(no company)' : companyNameById.get(companyId) || '(unknown company)',
          companyId,
          count,
        }))
        .sort((a, b) => b.count - a.count),
    );

    console.log(`\nTOTAL matching production orders: ${orders.length}\n`);
    console.log('⚠  This is a READ-ONLY report — nothing was modified.\n');
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
