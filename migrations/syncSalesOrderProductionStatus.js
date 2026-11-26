/**
 * Recomputes SalesOrder.productionOrderStatus from its linked ProductionOrders, mirroring
 * the logic in syncSalesOrderProductionStatus() (modules/production/addProduction/productionOrder.service.js).
 * Catches up sales orders whose status drifted from their production orders — e.g. rows
 * created before that sync existed, or missed because of a failed/edge-case call.
 *
 * A sales order's status is only ever moved to COMPLETED here (never reverted away from it),
 * matching the service function: every item on the order must have COMPLETED production
 * orders whose summed quantity is >= the item's ordered quantity.
 *
 * Reports by default and writes only with --apply. Idempotent: a sales order already at the
 * correct status is left untouched, so it can be re-run safely.
 *
 * Run: node migrations/syncSalesOrderProductionStatus.js                      (report, all companies)
 *      node migrations/syncSalesOrderProductionStatus.js <companyId>           (report, one company)
 *      node migrations/syncSalesOrderProductionStatus.js <companyId> --apply   (write)
 *      node migrations/syncSalesOrderProductionStatus.js --apply               (write, all companies)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const PRODUCTION_ORDER_STATUS_COMPLETED = 'COMPLETED';

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;

    const scope = targetCompanyId ? { companyId: targetCompanyId } : {};

    console.log(`\nScope: ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode: APPLYING CHANGES\n' : 'Mode: report only — pass --apply to write\n');

    const salesOrders = db.booksCrm.collection('salesorders');
    const productionOrders = db.books.collection('productionorders');

    const orders = await salesOrders
      .find({ ...scope, items: { $exists: true, $not: { $size: 0 } } })
      .project({ orderId: 1, companyId: 1, items: 1, productionOrderStatus: 1 })
      .toArray();

    console.log(`Sales orders in scope: ${orders.length}`);

    if (!orders.length) {
      console.log('Nothing to do.\n');
      return;
    }

    const orderIds = orders.map(order => order._id);
    const pos = await productionOrders
      .find({ salesOrderId: { $in: orderIds } })
      .project({ salesOrderId: 1, itemId: 1, quantity: 1, status: 1 })
      .toArray();

    const posBySalesOrderId = new Map();
    for (const po of pos) {
      const key = po.salesOrderId?.toString();
      if (!key) continue;
      if (!posBySalesOrderId.has(key)) posBySalesOrderId.set(key, []);
      posBySalesOrderId.get(key).push(po);
    }

    const toUpdate = [];
    let alreadyCompleted = 0;
    let notYetComplete = 0;

    for (const order of orders) {
      if (order.productionOrderStatus === PRODUCTION_ORDER_STATUS_COMPLETED) {
        alreadyCompleted += 1;
        continue;
      }

      const orderPos = posBySalesOrderId.get(order._id.toString()) || [];
      const allItemsCompleted = (order.items || []).every(item => {
        const completedQty = orderPos
          .filter(
            po =>
              po.itemId &&
              item.itemId &&
              po.itemId.toString() === item.itemId.toString() &&
              po.status === PRODUCTION_ORDER_STATUS_COMPLETED,
          )
          .reduce((sum, po) => sum + (po.quantity || 0), 0);
        return completedQty >= item.quantity;
      });

      if (allItemsCompleted) {
        toUpdate.push(order);
      } else {
        notYetComplete += 1;
      }
    }

    console.log(`   already COMPLETED         : ${alreadyCompleted}`);
    console.log(`   not yet fully produced     : ${notYetComplete}`);
    console.log(`   ${apply ? 'updating' : 'would update'} to COMPLETED : ${toUpdate.length}`);

    if (toUpdate.length) {
      console.log('\nSales orders affected:');
      toUpdate.forEach(order => console.log(`   ${order._id} (${order.orderId || 'no orderId'})`));
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to sync.\n');
      return;
    }

    let updated = 0;
    for (const order of toUpdate) {
      const result = await salesOrders.updateOne(
        { _id: order._id },
        { $set: { productionOrderStatus: PRODUCTION_ORDER_STATUS_COMPLETED } },
      );
      updated += result.modifiedCount;
    }

    console.log(`\nWRITTEN\n   sales orders synced to COMPLETED: ${updated}`);
    console.log('\nSync completed.\n');
  } catch (error) {
    console.error('Sync failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
