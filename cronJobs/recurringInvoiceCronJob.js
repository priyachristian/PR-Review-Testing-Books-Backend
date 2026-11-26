const cron = require('node-cron');
const moment = require('moment');
const mongoose = require('mongoose');
const { MODULE_NAMES, SALES_ORDER_INVOICE_STATUS, LEDGER_SOURCE_MODULES } = require('../utils/enum');
const { generateMultipleUniqueIdsForModules } = require('../utils/uniqueIdGenerator');
const { defaultBranchEntry } = require('../utils/defaultCustomerBranchEntry');
const { getInventoryConfig, validateStockAvailability } = require('../utils/inventoryConfig');
const { defaultWarehouseEntry } = require('../utils/defaultWarehouseEntry');
const { handleWarehouseStock, checkCompanyStockLevels, flushCompanyStockLevels } = require('../services/warehouseBatch.service');
const { createQueue } = require('../config/queueConfig');
const { getPrimaryBank } = require('../modules/banking/bank/bank.service');
const logger = require('../config/logger');
const { calculateDueDate, calculateFinalPrice } = require('../services/calculateDiscount.service');
const { validateCustomerForModule, updateBranchCurrentBalance } = require('../services/customerValidation.service');
const ledgerService = require('../modules/accountant/ledger/ledger.service');
const { sendTransactionNotification } = require('../utils/transactionNotification');
const { processIncentiveEarn } = require('../modules/setting/incentiveScheme/incentiveScheme.service');
const {
  RECURRING_INVOICE_STATUS,
  RECURRING_DOC_STATUS,
  NOTIFICATION_TYPE,
} = require('@smit9313/abss-models-core/src/utils/enum');

let RecurringInvoice = null;
let Invoice = null;
let Item = null;
let Customer = null;
let Branch = null;
let Company = null;
let RecurringInvoiceHistory = null;
let PaymentTerm = null;

const runRecurringInvoiceCron = async () => {
  logger.info('cron for creating invoice has been started..');
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Fetch all due invoices without a shared session — failures per-invoice should not block others
    const invoices = await RecurringInvoice.find({
      status: RECURRING_DOC_STATUS.ACTIVE,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    });

    const companyIds = [...new Set(invoices.map(invoice => invoice.companyId.toString()))];
    const companies = await Company.find({ _id: { $in: companyIds } }).lean();
    const companyMap = new Map();
    companies.forEach(company => {
      companyMap.set(company._id.toString(), company);
    });

    logger.info(`Found ${invoices.length} active recurring invoices`);

    for (const invoice of invoices) {
      const isDue = isRecurringDue(invoice.startDate, new Date(), invoice.repeatEvery.frequency, invoice.repeatEvery.period);
      const company = companyMap.get(invoice.companyId.toString());

      if (!isDue) continue;

      if (
        !(
          (invoice.neverExpires && !invoice.endDate) ||
          (invoice.endDate && moment.utc().startOf('day').isSameOrBefore(moment.utc(invoice.endDate).startOf('day')))
        )
      ) {
        continue;
      }

      const now = new Date();
      const invoiceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      const alreadyCreated = await RecurringInvoiceHistory.findOne({
        recurringInvoiceId: invoice._id,
        scheduledDate: invoiceDate,
        status: 'SUCCESS',
      });
      if (alreadyCreated) {
        logger.info(`⏭️ Skipping invoice ${invoice._id} — already created for ${invoiceDate.toISOString().split('T')[0]}`);
        continue;
      }

      // Each invoice gets its own isolated session so a failure doesn't affect others
      const session = await RecurringInvoice.db.startSession();
      session.startTransaction();

      const cycleNumber = (await RecurringInvoiceHistory.countDocuments({ recurringInvoiceId: invoice._id })) + 1;

      try {
        logger.info(`Started creating invoice for recurring: ${invoice._id}`);

        const ids = await generateMultipleUniqueIdsForModules(
          Invoice,
          invoice.companyId,
          [
            {
              moduleName: MODULE_NAMES.INVOICE,
              idField: 'invoiceId',
              defaultPrefix: 'INV',
              count: 1,
              resultKey: 'mainInvoiceId',
            },
          ],
          session,
        );

        const customer = await Customer.findOne({
          _id: new mongoose.Types.ObjectId(invoice.customerId.toString()),
          'branch.branchId': invoice.branchId,
        }).session(session);

        if (customer == null || customer == undefined) {
          await defaultBranchEntry(invoice.customerId, invoice.branchId, session);
        }

        await validateCustomerForModule({
          customerId: invoice.customerId,
          branchId: invoice.branchId,
          companyId: invoice.companyId,
          totalAmount: invoice.total,
          addressId: invoice.addressId,
          moduleName: MODULE_NAMES.INVOICE,
          session,
          models: { Customer, Branch, Invoice },
        });

        if (invoice?.items?.length > 0) {
          await defaultWarehouseEntry(
            {
              itemArray: invoice.items,
              warehouseId: invoice.warehouseId,
              branchId: invoice.branchId,
              divisionId: invoice.divisionId,
              companyId: invoice.companyId,
            },
            session,
          );
        }

        const inventoryConfig = await getInventoryConfig(invoice.companyId, MODULE_NAMES.INVOICE, session);

        logger.info({ inventoryConfig });

        if (inventoryConfig?.stockCheckEnabled || inventoryConfig?.stockDeductEnabled) {
          logger.info('checking stock availability........................');
          // Throws on failure — caught by the per-invoice catch block below
          await validateStockAvailability(
            { items: invoice.items, companyId: invoice.companyId, warehouseId: invoice.warehouseId },
            session,
          );
        }

        logger.info(`✅ Create invoice for RecurringInvoice ID: ${invoice._id}`);

        const bank = await getPrimaryBank(invoice.companyId, session);

        const paymentTerm = invoice.paymentTermsId
          ? await PaymentTerm.findById(invoice.paymentTermsId).session(session).lean()
          : null;

        const invoiceObj = {
          items: invoice.items,
          subTotal: invoice.subTotal,
          sgst: invoice.sgst,
          cgst: invoice.cgst,
          igst: invoice.igst,
          totalTax: invoice.totalTax,
          total: invoice.total,
          divisionId: invoice.divisionId,
          branchId: invoice.branchId,
          warehouseId: invoice.warehouseId,
          additionalCharges: invoice.additionalCharges,
          tax: invoice.tax,
          companyId: invoice.companyId,
          customerId: invoice.customerId,
          invoiceId: ids.mainInvoiceId,
          referenceNumber: invoice.referenceNumber,
          dueDate: calculateDueDate(paymentTerm),
          paymentTermsId: invoice.paymentTermsId,
          subject: invoice.subject,
          customerNotes: invoice.customerNotes,
          termsAndConditions: invoice.termsAndConditions,
          authorizedSignature: invoice.authorizedSignature,
          attachments: invoice.attachments,
          priceListId: invoice.priceListId,
          status: SALES_ORDER_INVOICE_STATUS.DRAFT,
          balanceAmount: invoice.total,
          inventoryConfig,
          invoiceDate,
          addressId: invoice.addressId,
          addedBy: invoice.addedBy,
          isRoundOff: invoice.isRoundOff,
          roundOffAmount: invoice.roundOffAmount,
          companyGstin: company?.gstNumber,
          companyLogo: company?.companyLogo,
          bankAccountId: bank?.accountId,
          appliesTo: invoice?.appliesTo,
          discountConfig: invoice?.discountConfig,
          currency: invoice.currency,
          exchangeRate: invoice.exchangeRate,
          decimalPlaces: invoice.decimalPlaces,
          commentHistory: [
            {
              message: `Invoice created from recurring invoice ${invoice.recurringInvoiceId}`,
              addedBy: invoice?.userId,
              createdAt: new Date(),
              referenceType: 'RecurringInvoice',
              referenceId: invoice._id,
            },
          ],
          recurringInvoiceId: invoice?._id,
        };

        logger.info({ invoiceObj });

        // Destructure directly — if create throws, the per-invoice catch handles it
        const [created] = await Invoice.create([invoiceObj], { session });
        logger.info('✅ Inserted invoice:', created);

        const nextExecutionDate = getNextExecutionDate(
          invoice.startDate,
          now,
          invoice.repeatEvery.frequency,
          invoice.repeatEvery.period,
        );

        const isLastInvoice =
          !invoice.neverExpires &&
          invoice.endDate &&
          moment.utc(nextExecutionDate).startOf('day').isSameOrAfter(moment.utc(invoice.endDate).startOf('day'));

        if (isLastInvoice) {
          logger.info(`🏁 Last invoice cycle reached for recurring ${invoice._id} — marking as COMPLETED`);
        }

        await RecurringInvoice.updateOne(
          { _id: invoice._id },
          {
            $set: {
              currentExecutionDate: now,
              nextExecutionDate,
              ...(isLastInvoice && { status: RECURRING_DOC_STATUS.COMPLETED }),
            },
            $push: {
              commentHistory: {
                message: `Invoice ${created.invoiceId} generated from recurring invoice ${invoice.recurringInvoiceId}`,
                addedBy: invoice.addedBy,
                createdAt: new Date(),
                referenceType: 'Invoice',
                referenceId: created._id,
              },
            },
          },
          { session },
        );

        await RecurringInvoiceHistory.create(
          [
            {
              companyId: invoice.companyId,
              recurringInvoiceId: invoice._id,
              cycleNumber,
              scheduledDate: invoiceDate,
              executedDate: now,
              nextExecutionDate,
              generatedInvoiceId: created._id,
              generatedInvoiceNumber: created.invoiceId,
              status: 'SUCCESS',
            },
          ],
          { session },
        );

        if (inventoryConfig?.stockDeductEnabled) {
          for (let item of created.items) {
            const finalSellingPrice = calculateFinalPrice(item);

            const warehouseStockObj = {
              action: 'deductStock',
              stockData: {
                itemId: item.itemId,
                companyId: invoice.companyId,
                branchId: invoice.branchId,
                warehouseId: invoice.warehouseId,
                quantity: item.quantity,
                itemUnitId: item.itemUnitId,
                deductedSourceType: MODULE_NAMES.INVOICE,
                deductedSourceId: created._id,
                sellingPrice: finalSellingPrice,
              },
              session,
            };

            const deductionSummary = await handleWarehouseStock(warehouseStockObj);

            if (!item.batches) item.batches = [];
            item.batches.push(...deductionSummary);
          }

          await checkCompanyStockLevels({
            itemIds: created.items.map(item => item.itemId),
            companyId: invoice.companyId,
            docType: MODULE_NAMES.INVOICE,
            docId: created._id,
            docNo: created.invoiceId,
            userId: created.addedBy,
            session,
          });

          await Invoice.updateOne({ _id: created._id }, { $set: { items: created.items } }, { session });
        }

        await updateBranchCurrentBalance({
          customerId: invoice.customerId,
          branchId: invoice.branchId,
          amount: invoice.total,
          session,
        });

        // Guard against double-posting if this cron run is ever retried for the same invoice.
        await ledgerService.deleteJournal(
          { companyId: invoice.companyId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: created._id },
          session,
        );
        await ledgerService.postInvoiceJournal(
          { companyId: invoice.companyId, invoice: created, addedBy: invoice.addedBy },
          session,
        );

        const verify = await Invoice.findOne({ invoiceId: invoiceObj.invoiceId }).session(session);
        logger.info('✅ Verified in DB:', verify ? true : false);

        await flushCompanyStockLevels(session);

        await session.commitTransaction();
        logger.info(`✅ Invoice created successfully for recurring ${invoice._id}: ${invoiceObj.invoiceId}`);

        sendTransactionNotification({
          customerId: invoice.customerId,
          companyId: invoice.companyId,
          notificationType: NOTIFICATION_TYPE.INVOICE_CREATED,
          entityId: created._id,
          entityDisplayId: created.invoiceId,
          triggeredByUserId: invoice.addedBy,
        });

        processIncentiveEarn(invoice.companyId, invoice.addedBy, 'INVOICE', created._id, created.total, created.items);
      } catch (err) {
        logger.info(`❌ Transaction failed for recurring invoice ${invoice._id}:`, err.message);
        await session.abortTransaction();
        logger.info(`🚫 Transaction aborted for recurring invoice: ${invoice._id}`);

        await RecurringInvoiceHistory.create([
          {
            companyId: invoice.companyId,
            recurringInvoiceId: invoice._id,
            cycleNumber,
            scheduledDate: invoiceDate,
            executedDate: new Date(),
            status: 'FAILED',
            errorMessage: err.message,
            metadata: invoice.items,
          },
        ]).catch(e => logger.info('❌ Failed to write failure history:', e.message));
      } finally {
        session.endSession();
      }
    }

    logger.info('✅ Recurring invoice cron completed');
  } catch (error) {
    logger.info({ error });
    throw error;
  }
};

const startCron = (booksModels, getBooksCrmModels, commonModels) => {
  RecurringInvoice = booksModels.RecurringInvoice;
  Invoice = booksModels.Invoice;
  Item = getBooksCrmModels.Item;
  Customer = getBooksCrmModels.Customer;
  Branch = getBooksCrmModels.Branch;
  Company = commonModels.Company;
  RecurringInvoiceHistory = booksModels.RecurringInvoiceHistory;
  PaymentTerm = getBooksCrmModels.PaymentTerm;

  logger.info('🧾 RecurringInvoice:', RecurringInvoice ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📄 Invoice:', Invoice ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📦 Item:', Item ? '✅ Loaded' : '❌ Not loaded');
  logger.info('👤 Customer:', Customer ? '✅ Loaded' : '❌ Not loaded');
  logger.info('🏬 Branch:', Branch ? '✅ Loaded' : '❌ Not loaded');
  logger.info('🏢 Company:', Company ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📋 RecurringInvoiceHistory:', RecurringInvoiceHistory ? '✅ Loaded' : '❌ Not loaded');
  logger.info('💳 PaymentTerm:', PaymentTerm ? '✅ Loaded' : '❌ Not loaded');

  if (!RecurringInvoice || !Invoice || !Item || !Customer || !Branch || !Company || !RecurringInvoiceHistory || !PaymentTerm) {
    logger.info('❌ Required models not available for cron');
    return;
  }

  logger.info('📅 Cron initialized');

  cron.schedule('0 0 * * *', async () => {
    try {
      const jobId = `recurring-invoice-${new Date().toISOString().split('T')[0]}`;
      const job = await createQueue('recurring-invoice').add('process-recurring-invoices', {}, { jobId });
      logger.info(`[Cron] 📥 Enqueued recurring-invoice job id=${job.id}`);
    } catch (err) {
      console.error('[Cron] ❌ Failed to enqueue recurring-invoice job:', err.message);
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

module.exports = startCron;
// Named export used by the BullMQ worker to run the actual logic
module.exports.runRecurringInvoiceCron = runRecurringInvoiceCron;
