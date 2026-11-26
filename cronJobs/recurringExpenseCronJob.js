const cron = require('node-cron');
const moment = require('moment');
const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { MODULE_NAMES } = require('../utils/enum');
const { generateMultipleUniqueIdsForModules } = require('../utils/uniqueIdGenerator');
const { createQueue } = require('../config/queueConfig');
const logger = require('../config/logger');
const { validateExpenseAccounts } = require('../modules/purchase/expense/expense.service');
const ledgerService = require('../modules/accountant/ledger/ledger.service');
const { RECURRING_DOC_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');

let RecurringExpense = null;
let Expenses = null;
let Company = null;
let RecurringExpenseHistory = null;

const runRecurringExpensesCron = async () => {
  logger.info('cron for creating expense has been started..');
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Fetch all due expenses without a shared session — failures per-expense should not block others
    const expenses = await RecurringExpense.find({
      status: RECURRING_DOC_STATUS.ACTIVE,
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false }, neverExpires: true },
        { endDate: null, neverExpires: true },
      ],
    });

    const companyIds = [...new Set(expenses.map(expense => expense.companyId.toString()))];
    const companies = await Company.find({ _id: { $in: companyIds } }).lean();
    const companyMap = new Map();
    companies.forEach(company => {
      companyMap.set(company._id.toString(), company);
    });

    logger.info(`Found ${expenses.length} active recurring expenses`);

    for (const expense of expenses) {
      const isDue = isRecurringDue(expense.startDate, new Date(), expense.repeatEvery.frequency, expense.repeatEvery.period);
      const company = companyMap.get(expense.companyId.toString());

      if (!isDue) continue;

      if (
        !(
          (expense.neverExpires && !expense.endDate) ||
          (expense.endDate && moment.utc().startOf('day').isSameOrBefore(moment.utc(expense.endDate).startOf('day')))
        )
      ) {
        continue;
      }

      const now = new Date();
      const expenseDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      const alreadyCreated = await RecurringExpenseHistory.findOne({
        recurringExpenseId: expense._id,
        scheduledDate: expenseDate,
        status: 'SUCCESS',
      });
      if (alreadyCreated) {
        logger.info(`⏭️ Skipping expense ${expense._id} — already created for ${expenseDate.toISOString().split('T')[0]}`);
        continue;
      }

      // Each expense gets its own isolated session so a failure doesn't affect others
      const session = await RecurringExpense.db.startSession();
      session.startTransaction();

      const cycleNumber = (await RecurringExpenseHistory.countDocuments({ recurringExpenseId: expense._id })) + 1;

      try {
        logger.info(`Started creating expense for recurring: ${expense._id}`);

        if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

        const ids = await generateMultipleUniqueIdsForModules(
          Expenses,
          expense.companyId,
          [
            {
              moduleName: MODULE_NAMES.EXPENSE,
              idField: 'expenseId',
              defaultPrefix: 'EX',
              count: 1,
              resultKey: 'mainExpenseId',
            },
          ],
          session,
        );

        let shippingAddressId = null;
        if (expense?.addressId?.toString() === company?.address?._id?.toString()) {
          shippingAddressId = company?.address?._id;
        } else if (
          company?.additionalShippingAddresses?.some(address => address?._id?.toString() === expense?.addressId?.toString())
        ) {
          shippingAddressId = company?.additionalShippingAddresses?.find(
            address => address?._id?.toString() === expense?.addressId?.toString(),
          )?._id;
        }

        if (!shippingAddressId) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
        }

        await validateExpenseAccounts({
          companyId: expense.companyId,
          expenseAccountId: expense.expenseAccount,
          paidThroughAccountId: expense.paidThroughAccountId,
          session,
        });

        logger.info(`✅ Create expense for RecurringExpense ID: ${expense._id}`);

        const expenseObj = {
          companyId: expense.companyId,
          expenseId: ids.mainExpenseId,
          divisionId: expense.divisionId,
          branchId: expense.branchId,
          warehouseId: expense.warehouseId,
          expenseAccount: expense.expenseAccount,
          amount: expense.amount,
          paidThroughAccountId: expense.paidThroughAccountId,
          notes: expense.notes,
          customer: expense.customer,
          receipts: expense.receipts,
          attachments: expense.attachments,
          addressId: expense.addressId,
          addedBy: expense.addedBy,
          authorizedSignature: expense.authorizedSignature,
          termsAndConditions: expense.termsAndConditions,
          companyGstin: company?.gstNumber,
          companyLogo: company?.companyLogo,
          currency: expense.currency,
          exchangeRate: expense.exchangeRate,
          decimalPlaces: expense.decimalPlaces,
          date: expenseDate,
          commentHistory: [
            {
              message: `Expense created from recurring expense ${expense.recurringExpenseId}`,
              addedBy: expense.addedBy,
              createdAt: now,
              referenceType: 'RecurringExpense',
              referenceId: expense._id,
            },
          ],
        };

        const [created] = await Expenses.create([expenseObj], { session });
        logger.info('✅ Inserted expense:', created);

        await ledgerService.postExpenseJournal(
          { companyId: created.companyId, expense: created, addedBy: expense.addedBy },
          session,
        );

        const nextExecutionDate = getNextExecutionDate(
          expense.startDate,
          now,
          expense.repeatEvery.frequency,
          expense.repeatEvery.period,
        );

        const isLastExpense =
          !expense.neverExpires &&
          expense.endDate &&
          moment.utc(nextExecutionDate).startOf('day').isAfter(moment.utc(expense.endDate).startOf('day'));

        if (isLastExpense) {
          logger.info(`🏁 Last expense cycle reached for recurring ${expense._id} — marking as COMPLETED`);
        }

        await RecurringExpense.updateOne(
          { _id: expense._id },
          {
            $set: {
              currentExecutionDate: now,
              nextExecutionDate,
              ...(isLastExpense && { status: RECURRING_DOC_STATUS.COMPLETED }),
            },
            $push: {
              commentHistory: {
                message: `Expense ${created.expenseId} generated from recurring expense ${expense.recurringExpenseId}`,
                addedBy: expense.addedBy,
                createdAt: now,
                referenceType: 'Expense',
                referenceId: created._id,
              },
            },
          },
          { session, runValidators: true },
        );

        await RecurringExpenseHistory.create(
          [
            {
              companyId: expense.companyId,
              recurringExpenseId: expense._id,
              cycleNumber,
              scheduledDate: expenseDate,
              executedDate: now,
              nextExecutionDate,
              generatedExpenseId: created._id,
              generatedExpenseNumber: created.expenseId,
              status: 'SUCCESS',
            },
          ],
          { session },
        );

        const verify = await Expenses.findOne({ expenseId: expenseObj.expenseId }).session(session);
        logger.info('✅ Verified in DB:', verify ? true : false);

        await session.commitTransaction();
        logger.info(`✅ Expense created successfully for recurring ${expense._id}: ${expenseObj.expenseId}`);
      } catch (err) {
        await session.abortTransaction();

        if (err.code === 11000) {
          logger.info(`⏭️ Skipping recurring expense ${expense._id} — cycle already generated (concurrent run)`);
          continue;
        }

        logger.info(`❌ Transaction failed for recurring expense ${expense._id}:`, err.message);
        logger.info(`🚫 Transaction aborted for recurring expense: ${expense._id}`);

        await RecurringExpenseHistory.create([
          {
            companyId: expense.companyId,
            recurringExpenseId: expense._id,
            cycleNumber,
            scheduledDate: expenseDate,
            executedDate: new Date(),
            status: 'FAILED',
            errorMessage: err.message,
            metadata: { amount: expense.amount, paidThroughAccountId: expense.paidThroughAccountId },
          },
        ]).catch(e => logger.info('❌ Failed to write failure history:', e.message));
      } finally {
        session.endSession();
      }
    }

    logger.info('✅ Recurring expense cron completed');
  } catch (error) {
    logger.info({ error });
    throw error;
  }
};

const startCron = (booksModels, booksCrmModels, commonModels) => {
  RecurringExpense = booksModels.RecurringExpense;
  Expenses = booksModels.Expenses;
  Company = commonModels.Company;
  RecurringExpenseHistory = booksModels.RecurringExpenseHistory;

  logger.info('🧾 RecurringExpense:', RecurringExpense ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📄 Expenses:', Expenses ? '✅ Loaded' : '❌ Not loaded');
  logger.info('🏢 Company:', Company ? '✅ Loaded' : '❌ Not loaded');
  logger.info('📋 RecurringExpenseHistory:', RecurringExpenseHistory ? '✅ Loaded' : '❌ Not loaded');

  if (!RecurringExpense || !Expenses || !Company || !RecurringExpenseHistory) {
    logger.info('❌ Required models not available for cron');
    return;
  }

  logger.info('📅 Cron initialized');

  cron.schedule('0 0 * * *', async () => {
    try {
      const jobId = `recurring-expense-${new Date().toISOString().split('T')[0]}`;
      const job = await createQueue('recurring-expense').add('process-recurring-expenses', {}, { jobId });
      logger.info(`[Cron] 📥 Enqueued recurring-expense job id=${job.id}`);
    } catch (err) {
      console.error('[Cron] ❌ Failed to enqueue recurring-expense job:', err.message);
    }
  });
  // '0 0 * * *'  set this value to run everyday at 12 am
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

// Default export keeps backward-compat with server.js (`startRecurringExpensesCron(...)`)
module.exports = startCron;
// Named export used by the BullMQ worker to run the actual logic
module.exports.runRecurringExpensesCron = runRecurringExpensesCron;
