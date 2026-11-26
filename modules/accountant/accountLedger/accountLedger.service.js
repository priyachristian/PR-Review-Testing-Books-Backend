const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const ApiError = require('../../../utils/ApiError');
const { BUSINESS_ACCOUNT_LEDGER_MESSAGES } = require('../../../utils/messages');
const { getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const mongoose = require('mongoose');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { MODULE_NAMES } = require('../../../utils/enum');

const createLedger = async (ledgerBody, userId) => {
  const { AccountLedger } = getBooksModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();
  try {
    await session.startTransaction();

    ledgerBody.businessAccountLedgerMasterId = await generateUniqueId(
      AccountLedger,
      ledgerBody.companyId,
      MODULE_NAMES.ACCOUNT_PARTNER,
      'businessAccountLedgerMasterId',
      'ACCPA',
      session,
      ledgerBody.businessAccountLedgerMasterId,
    );

    const ledgerData = {
      ...ledgerBody,
      addedBy: userId,
      updatedBy: userId,
    };

    const ledger = await AccountLedger.create(ledgerData);
    await session.commitTransaction();
    return ledger;
  } catch (error) {
    throw error;
  } finally {
    session.endSession();
  }
};

const getLedgers = async (filter, options) => {
  const { AccountLedger } = getBooksModels();
  const { User } = getCommonModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search);
    query.$or = [{ personName: searchRegex }, { pan: searchRegex }, { phoneNo: searchRegex }, { email: searchRegex }];
  }

  const result = await AccountLedger.paginate(query, options);

  const userIds = [...new Set(result.results.flatMap(i => [i.addedBy, toUpdatedByUserIdString(i.updatedBy)].filter(Boolean)))];
  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName _id')
    .lean();

  const populatedResults = result.results.map(account => {
    const accountObj = account.toObject();
    accountObj.id = account._id;
    accountObj.addedBy = users.find(u => u._id.toString() === account.addedBy?.toString()) || null;
    const updatedById = toUpdatedByUserIdString(account.updatedBy);
    accountObj.updatedBy = updatedById ? users.find(u => u._id.toString() === updatedById) || null : null;

    accountObj.addedBy = accountObj.addedBy ? `${accountObj.addedBy.firstName} ${accountObj.addedBy.lastName}` : null;
    accountObj.updatedBy = accountObj.updatedBy ? `${accountObj.updatedBy.firstName} ${accountObj.updatedBy.lastName}` : null;

    return accountObj;
  });

  return {
    ...result,
    results: populatedResults,
  };
};

const getLedgerById = async (ledgerId, companyId) => {
  const { AccountLedger } = getBooksModels();

  const ledger = await AccountLedger.findOne({ _id: ledgerId, companyId });
  if (!ledger) {
    throw new ApiError(httpStatus.NOT_FOUND, BUSINESS_ACCOUNT_LEDGER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return ledger;
};

const updateLedger = async (ledgerId, ledgerBody, userId) => {
  const { AccountLedger } = getBooksModels();

  const ledger = await AccountLedger.findOne({ _id: ledgerId, companyId: ledgerBody.companyId });
  if (!ledger) {
    throw new ApiError(httpStatus.NOT_FOUND, BUSINESS_ACCOUNT_LEDGER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  Object.assign(ledger, ledgerBody);
  ledger.updatedBy = userId;

  await ledger.save();

  return ledger;
};

const deleteLedger = async (ledgerId, companyId) => {
  const { AccountLedger, Expenses, ManualJournal } = getBooksModels();
  const connection = await getClientConnection();

  const [expenseUsingLedger, manualJournalUsingLedger] = await Promise.all([
    Expenses.findOne({ companyId, party: ledgerId }),
    ManualJournal.findOne({ companyId, 'journalEntries.businessAccountLedgerMasterId': ledgerId }),
  ]);

  if (expenseUsingLedger || manualJournalUsingLedger) {
    throw new ApiError(httpStatus.BAD_REQUEST, BUSINESS_ACCOUNT_LEDGER_MESSAGES.DELETE_IN_USE);
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const ledger = await AccountLedger.findOne({ _id: ledgerId, companyId }).session(session);
    if (!ledger) {
      throw new ApiError(httpStatus.NOT_FOUND, BUSINESS_ACCOUNT_LEDGER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    await AccountLedger.deleteOne({ _id: ledgerId, companyId }, { session });
    await session.commitTransaction();
    return ledger;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getLedgersDropdown = async filter => {
  const { AccountLedger } = getBooksModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  const result = await AccountLedger.find(query);

  return result.map(account => {
    const accountObj = account.toObject();
    accountObj.id = account._id;
    return accountObj;
  });
};

module.exports = {
  createLedger: withTransientRetry(createLedger),
  getLedgerById,
  getLedgers,
  updateLedger,
  deleteLedger,
  getLedgersDropdown,
};
