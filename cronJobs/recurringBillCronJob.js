const cron = require('node-cron');
const moment = require('moment');
const mongoose = require('mongoose');
const { MODULE_NAMES, BILL_STATUSES, LEDGER_SOURCE_MODULES } = require('../utils/enum');
const { generateMultipleUniqueIdsForModules } = require('../utils/uniqueIdGenerator');
const { getInventoryConfig } = require('../utils/inventoryConfig');
const { defaultWarehouseEntry } = require('../utils/defaultWarehouseEntry');
const { defaultBranchEntry } = require('../utils/defaultCustomerBranchEntry');
const { handleWarehouseStock, checkCompanyStockLevels, flushCompanyStockLevels } = require('../services/warehouseBatch.service');
const { createQueue } = require('../config/queueConfig');
const logger = require('../config/logger');
const { calculateDueDate, calculateFinalPrice } = require('../services/calculateDiscount.service');
const { validateVendorForModule, updateBranchCurrentBalance } = require('../services/customerValidation.service');
const ledgerService = require('../modules/accountant/ledger/ledger.service');
const { RECURRING_DOC_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');

let RecurringBill = null;
let Bill = null;
let Item = null;
let Customer = null;
let Branch = null;
let Company = null;
let RecurringBillHistory = null;
let PaymentTerm = null;

const runRecurringBillCron = async () => {
  logger.info('cron for creating bill has been started..');
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Fetch all due bills without a shared session — failures per-bill should not block others
    const bills = await RecurringBill.find({
      status: RECURRING_DOC_STATUS.ACTIVE,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    });

    const companyIds = [...new Set(bills.map(bill => bill.companyId.toString()))];
    const companies = await Company.find({ _id: { $in: companyIds } }).lean();
    const companyMap = new Map();
    companies.forEach(company => {
      companyMap.set(company._id.toString(), company);
    });

    logger.info(`Found ${bills.length} active recurring bills`);

    for (const bill of bills) {
      const isDue = isRecurringDue(bill.startDate, new Date(), bill.repeatEvery.frequency, bill.repeatEvery.period);
      const company = companyMap.get(bill.companyId.toString());

      if (!isDue) continue;

      if (
        !(
          (bill.neverExpires && !bill.endDate) ||
          (bill.endDate && moment.utc().startOf('day').isSameOrBefore(moment.utc(bill.endDate).startOf('day')))
        )
      ) {
        continue;
      }

      const now = new Date();
      const billDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      const alreadyCreated = await RecurringBillHistory.findOne({
        recurringBillId: bill._id,
        scheduledDate: billDate,
        status: 'SUCCESS',
      });
      if (alreadyCreated) {
        logger.info(`⏭️ Skipping bill ${bill._id} — already created for ${billDate.toISOString().split('T')[0]}`);
        continue;
      }

      // Each bill gets its own isolated session so a failure doesn't affect others
      const session = await RecurringBill.db.startSession();
      session.startTransaction();

      const cycleNumber = (await RecurringBillHistory.countDocuments({ recurringBillId: bill._id })) + 1;

      try {
        logger.info(`Started creating bill for recurring: ${bill._id}`);

        const customer = await Customer.findOne({
          _id: new mongoose.Types.ObjectId(bill.vendorId.toString()),
          'branch.branchId': bill.branchId,
        }).session(session);

        if (customer == null || customer == undefined) {
          await defaultBranchEntry(bill.vendorId, bill.branchId, session);
        }

        await validateVendorForModule({
          vendorId: bill.vendorId,
          branchId: bill.branchId,
          companyId: bill.companyId,
          totalAmount: bill.total,
          addressId: bill.addressId,
          moduleName: MODULE_NAMES.BILL,
          session,
          customerId: bill.customerId,
          models: { Customer, Branch },
        });

        const ids = await generateMultipleUniqueIdsForModules(
          Bill,
          bill.companyId,
          [
            {
              moduleName: MODULE_NAMES.BILL,
              idField: 'billId',
              defaultPrefix: 'BILL',
              count: 1,
              resultKey: 'mainBillId',
            },
          ],
          session,
        );

        const inventoryConfig = await getInventoryConfig(bill.companyId, MODULE_NAMES.BILL, session);

        if (bill?.items?.length > 0) {
          await defaultWarehouseEntry(
            {
              itemArray: bill.items,
              warehouseId: bill.warehouseId,
              branchId: bill.branchId,
              divisionId: bill.divisionId,
              companyId: bill.companyId,
              isActive: true,
            },
            session,
          );
        }

        logger.info(`✅ Create bill for RecurringBill ID: ${bill._id}`);

        const paymentTerm = bill.paymentTermsId ? await PaymentTerm.findById(bill.paymentTermsId).session(session).lean() : null;

        const billObj = {
          items: bill.items,
          subTotal: bill.subTotal,
          sgst: bill.sgst,
          cgst: bill.cgst,
          igst: bill.igst,
          totalTax: bill.totalTax,
          total: bill.total,
          divisionId: bill.divisionId,
          branchId: bill.branchId,
          warehouseId: bill.warehouseId,
          additionalCharges: bill.additionalCharges,
          tax: bill.tax,
          companyId: bill.companyId,
          vendor: bill.vendorId,
          billId: ids.mainBillId,
          dueDate: calculateDueDate(paymentTerm),
          paymentTermsId: bill.paymentTermsId,
          customerNotes: bill.customerNotes,
          termsAndConditions: bill.termsAndConditions,
          authorizedSignature: bill.authorizedSignature,
          status: BILL_STATUSES.DRAFT,
          attachments: bill.billFile,
          inventoryConfig,
          addedBy: bill.addedBy,
          balanceAmount: bill.total,
          billDate,
          addressId: bill.addressId,
          customerId: bill.customerId,
          isRoundOff: bill.isRoundOff,
          roundOffAmount: bill.roundOffAmount,
          companyGstin: company?.gstNumber,
          companyLogo: company?.companyLogo,
          discountConfig: bill?.discountConfig,
          currency: bill.currency,
          exchangeRate: bill.exchangeRate,
          decimalPlaces: bill.decimalPlaces,
          commentHistory: [
            {
              message: `Bill created from recurring bill ${bill.recurringBillId}`,
              addedBy: bill.addedBy,
              referenceType: 'RecurringBill',
              referenceId: bill?._id,
              createdAt: new Date(),
            },
          ],
          recurringBillId: bill?._id,
        };

        // Destructure directly — if create throws, the per-bill catch handles it
        const [created] = await Bill.create([billObj], { session });
        logger.info('✅ Inserted bill:', created);

        const nextExecutionDate = getNextExecutionDate(bill.startDate, now, bill.repeatEvery.frequency, bill.repeatEvery.period);

        const isLastBill =
          !bill.neverExpires &&
          bill.endDate &&
          moment.utc(nextExecutionDate).startOf('day').isSameOrAfter(moment.utc(bill.endDate).startOf('day'));

        if (isLastBill) {
          logger.info(`🏁 Last bill cycle reached for recurring ${bill._id} — marking as COMPLETED`);
        }

        await RecurringBill.updateOne(
          { _id: bill._id },
          {
            $set: {
              currentExecutionDate: now,
              nextExecutionDate,
              ...(isLastBill && { status: RECURRING_DOC_STATUS.COMPLETED }),
            },
            $push: {
              commentHistory: {
                message: `Bill ${created.billId} generated from recurring bill ${bill.recurringBillId}`,
                addedBy: bill.addedBy,
                createdAt: new Date(),
                referenceType: 'Bill',
                referenceId: created._id,
              },
            },
          },
          { session },
        );

        await RecurringBillHistory.create(
          [
            {
              companyId: bill.companyId,
              recurringBillId: bill._id,
              cycleNumber,
              scheduledDate: billDate,
              executedDate: now,
              nextExecutionDate,
              generatedBillId: created._id,
              generatedBillNumber: created.billId,
              status: 'SUCCESS',
            },
          ],
          { session },
        );

        if (inventoryConfig.stockAddEnabled && !bill.customerId) {
          for (let item of created.items) {
            const finalPurchasePrice = calculateFinalPrice(item);

            // `item` already is the saved line, so batches land on the right line when an item repeats.
            const billItem = item;

            const warehouseStockObj = {
              action: 'addStock',
              stockData: {
                itemId: item.itemId,
                companyId: created.companyId,
                divisionId: created.divisionId,
                branchId: created.branchId,
                warehouseId: created.warehouseId,
                quantity: item.quantity,
                itemUnitId: item.itemUnitId,
                purchasePrice: finalPurchasePrice,
                vendorBatchNo: item?.vendorBatchNo,
                vendorBatchExpiry: item?.vendorBatchExpiry,
                sourceType: MODULE_NAMES.BILL,
                sourceId: created._id,
                addedBy: created.addedBy,
              },
              session,
            };

            const batchSummary = await handleWarehouseStock(warehouseStockObj);
            if (!batchSummary?.skipped && batchSummary) {
              const batchToAdd = {
                batchNo: batchSummary.batchNo,
                quantity: batchSummary.quantity,
                purchasePrice: batchSummary.purchasePrice,
                warehouseId: created.warehouseId,
                itemBatchId: batchSummary?._id,
              };

              if (billItem) {
                if (!billItem.batches) billItem.batches = [];
                billItem.batches.push(batchToAdd);
              }
            }
          }

          await checkCompanyStockLevels({
            itemIds: created.items.map(item => item.itemId),
            companyId: created.companyId,
            docType: MODULE_NAMES.BILL,
            docId: created._id,
            docNo: created.billId,
            userId: created.addedBy,
            session,
          });

          await Bill.updateOne({ _id: created._id }, { $set: { items: created.items } }, { session });
        }

        await updateBranchCurrentBalance({
          customerId: bill.vendorId,
          branchId: bill.branchId,
          amount: bill.total,
          session,
        });

        // Guard against double-posting if this cron run is ever retried for the same bill.
        await ledgerService.deleteJournal(
          { companyId: bill.companyId, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: created._id },
          session,
        );
        await ledgerService.postBillJournal({ companyId: bill.companyId, bill: created, addedBy: bill.addedBy }, session);

        const verify = await Bill.findOne({ billId: billObj.billId }).session(session);
        logger.info('✅ Verified in DB:', verify ? true : false);

        await flushCompanyStockLevels(session);

        await session.commitTransaction();
        logger.info(`✅ Bill created successfully for recurring ${bill._id}: ${billObj.billId}`);
      } catch (err) {
        logger.info(`❌ Transaction failed for recurring bill ${bill._id}:`, err.message);
        await session.abortTransaction();
        logger.info(`🚫 Transaction aborted for recurring bill: ${bill._id}`);

        await RecurringBillHistory.create([
          {
            companyId: bill.companyId,
            recurringBillId: bill._id,
            cycleNumber,
            scheduledDate: billDate,
            executedDate: new Date(),
            status: 'FAILED',
            errorMessage: err.message,
            metadata: bill.items,
          },
        ]).catch(e => logger.info('❌ Failed to write failure history:', e.message));
      } finally {
        session.endSession();
      }
    }

    logger.info('✅ Recurring bill cron completed');
  } catch (error) {
    logger.info({ error });
    throw error;
  }
};

const startCron = (booksModels, booksCrmModels, commonModels) => {
  RecurringBill = booksModels.RecurringBills;
  Bill = booksModels.Bill;
  Item = booksCrmModels.Item;
  Customer = booksCrmModels.Customer;
  Branch = booksCrmModels.Branch;
  Company = commonModels.Company;
  RecurringBillHistory = booksModels.RecurringBillHistory;
  PaymentTerm = booksCrmModels.PaymentTerm;

  logger.info('🧾 RecurringBill:', RecurringBill ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📄 Bill:', Bill ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📦 Item:', Item ? '✅ Loaded' : '❌ Not loaded');
  logger.info('👤 Customer:', Customer ? '✅ Loaded' : '❌ Not loaded');
  logger.info('🏬 Branch:', Branch ? '✅ Loaded' : '❌ Not loaded');
  logger.info('🏢 Company:', Company ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📋 RecurringBillHistory:', RecurringBillHistory ? '✅ Loaded' : '❌ Not loaded');
  logger.info('💳 PaymentTerm:', PaymentTerm ? '✅ Loaded' : '❌ Not loaded');

  if (!RecurringBill || !Bill || !Item || !Customer || !Branch || !Company || !RecurringBillHistory || !PaymentTerm) {
    logger.info('❌ Required models not available for cron');
    return;
  }

  logger.info('📅 Cron initialized');

  cron.schedule('0 0 * * *', async () => {
    try {
      const jobId = `recurring-bill-${new Date().toISOString().split('T')[0]}`;
      const job = await createQueue('recurring-bill').add('process-recurring-bills', {}, { jobId });
      logger.info(`[Cron] 📥 Enqueued recurring bill job id=${job.id}`);
    } catch (err) {
      console.error('[Cron] ❌ Failed to enqueue recurring bill job:', err.message);
    }
  });
};

function isRecurringDue(startDate, currentDate, frequency, period) {
  const start = moment.utc(startDate).startOf('day');
  const current = moment.utc(currentDate).startOf('day');

  if (current.isBefore(start)) return false;

  switch (period) {
    case 'Day(s)': {
      const daysDiff = current.diff(start, 'days');
      return daysDiff % frequency === 0;
    }
    case 'Week(s)': {
      const next = moment.utc(start).add(frequency, 'weeks');
      while (next.isSameOrBefore(current)) {
        if (next.isSame(current)) return true;
        next.add(frequency, 'weeks');
      }
      return false;
    }
    case 'Month(s)': {
      const next = moment.utc(start).add(frequency, 'months');
      while (next.isSameOrBefore(current)) {
        if (next.isSame(current)) return true;
        next.add(frequency, 'months');
      }
      return false;
    }
    case 'Year(s)': {
      const next = moment.utc(start).add(frequency, 'years');
      while (next.isSameOrBefore(current)) {
        if (next.isSame(current)) return true;
        next.add(frequency, 'years');
      }
      return false;
    }
    default:
      return false;
  }
}

function getNextExecutionDate(startDate, lastExecutionDate, frequency, period) {
  const base = moment.utc(startDate).startOf('day');
  let next = base;

  while (next.isSameOrBefore(moment.utc(lastExecutionDate))) {
    switch (period) {
      case 'Day(s)':
        next.add(frequency, 'days');
        break;
      case 'Week(s)':
        next.add(frequency, 'weeks');
        break;
      case 'Month(s)':
        next.add(frequency, 'months');
        break;
      case 'Year(s)':
        next.add(frequency, 'years');
        break;
    }
  }

  return next.toDate();
}

// Default export keeps backward-compat with server.js (`startBillCron(...)`)
module.exports = startCron;
// Named export used by the BullMQ worker to run the actual logic
module.exports.runRecurringBillCron = runRecurringBillCron;
