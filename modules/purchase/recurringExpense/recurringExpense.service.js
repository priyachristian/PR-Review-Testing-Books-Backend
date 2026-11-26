const mongoose = require('mongoose');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels, getBooksCrmModels, getCommonModels, getClientConnection } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { MODULE_NAMES, ACCOUNT_CATEGORIES, PAYMENT_ACCOUNT_CATEGORIES } = require('../../../utils/enum');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const moment = require('moment');
const { RECURRING_EXPENSE_MESSAGES, COMPANY_MESSAGES } = require('../../../utils/messages');
const { validateExpenseAccounts } = require('../expense/expense.service');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { RECURRING_EXPENSE_STATUS, RECURRING_DOC_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
/**
 * Create a new recurring expense
 * @param {Object} expenseBody
 * @param {String} userId
 * @param {Array} uploadedFiles
 * @returns {Promise<RecurringExpense>}
 */
const createRecurringExpense = async (expenseBody, userId, uploadedFiles = []) => {
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  session.startTransaction();
  try {
    const { RecurringExpense } = getBooksModels();
    const { Company } = getCommonModels();
    const company = await Company.findById(expenseBody.companyId).session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    let shippingAddressId = null;
    if (expenseBody?.addressId === company?.address?._id?.toString()) {
      shippingAddressId = company?.address?._id;
    } else if (company?.additionalShippingAddresses?.some(address => address?._id?.toString() === expenseBody?.addressId)) {
      shippingAddressId = company?.additionalShippingAddresses?.find(
        address => address?._id?.toString() === expenseBody?.addressId,
      )?._id;
    }

    if (!shippingAddressId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles || [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: expenseBody.companyId,
    });

    expenseBody.recurringExpenseId = await generateUniqueId(
      RecurringExpense,
      expenseBody.companyId,
      MODULE_NAMES.RECURRING_EXPENSE,
      'recurringExpenseId',
      'RECE',
      session,
      expenseBody.recurringExpenseId,
    );

    const now = new Date();

    const nextExecutionDate = getNextExecutionDate(
      expenseBody.startDate,
      now,
      expenseBody.repeatEvery.frequency,
      expenseBody.repeatEvery.period,
    );

    const { currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
      companyId: expenseBody.companyId,
      vendorId: expenseBody.vendor || null,
    });
    const currencyDoc = await getCurrency(expenseBody.companyId, currency);

    const commentHistory = [
      {
        message: `Recurring Expense created for ${currencyDoc?.symbol || '₹'}${expenseBody.amount || 0}`,
        addedBy: userId,
        createdAt: new Date(),
      },
    ];

    const { Account } = getBooksModels();
    const expenseAccountDoc = await Account.findOne({
      _id: expenseBody.expenseAccount,
      companyId: expenseBody.companyId,
      isActive: true,
      category: { $in: [ACCOUNT_CATEGORIES.EXPENSE.code, ACCOUNT_CATEGORIES.COGS.code, ACCOUNT_CATEGORIES.OTHER_EXPENSE.code] },
    }).session(session);
    if (!expenseAccountDoc) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Expense account not found or not an expense account');
    }
    const paidThroughAccountDoc = await Account.findOne({
      _id: expenseBody.paidThroughAccountId,
      companyId: expenseBody.companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).session(session);
    if (!paidThroughAccountDoc) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Paid through account not found or not a money account');
    }

    const recurringExpense = {
      ...expenseBody,
      receipts: allAttachments,
      currency,
      exchangeRate: expenseBody.exchangeRate ?? 1,
      decimalPlaces,
      authorizedSignature: company?.authorizedSignature,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
      addedBy: userId,
      nextExecutionDate,
      commentHistory,
      updatedBy: userId,
    };
    const expense = await RecurringExpense.create([recurringExpense], { session });
    await session.commitTransaction();
    return enrichDocumentCurrency(expenseBody.companyId, expense[0].toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Get a list of recurring expenses with pagination
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<QueryResult>}
 */
const queryRecurringExpenses = async (filter, options) => {
  const { RecurringExpense } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Account } = getBooksModels();
  const { Division, Branch } = getBooksCrmModels();
  const { User } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  if (filter.recurringExpenseDate) {
    query.recurringExpenseDate = {
      $gte: new Date(filter.recurringExpenseDate),
      $lte: new Date(filter.recurringExpenseDate),
    };
  }

  if (filter.startDate && filter.endDate) {
    query.recurringExpenseDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  // Status filtering
  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search);
    const matchingBranch = await Branch.find({ name: searchRegex }).select('_id');
    const matchingDivision = await Division.find({ name: searchRegex }).select('_id');
    const branchIds = matchingBranch.map(div => div._id);
    const divisionIds = matchingDivision.map(div => div._id);

    const customers = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }],
      },
      { _id: 1 },
    );

    const customerIds = customers.map(customer => customer._id.toString());

    const expenseAccount = await Account.find({ companyId, accountName: searchRegex });
    const paidThroughAccounts = await Account.find({
      companyId,
      accountName: searchRegex,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).select('_id');

    query.$or = [
      { expenseAccount: { $in: expenseAccount } },
      { paidThroughAccountId: { $in: paidThroughAccounts.map(account => account._id) } },
      { customer: { $in: customerIds } },
      { branchId: { $in: branchIds } },
      { divisionId: { $in: divisionIds } },
    ];
  }

  const result = await RecurringExpense.paginate(query, options);

  // Get all unique customer and vendor IDs from the results
  const customerIds = [...new Set(result.results.map(expense => expense.customer))];
  const vendorIds = [...new Set(result.results.map(expense => expense.vendor))];
  const divisionIds = [...new Set(result.results.map(expense => expense.divisionId))];
  const branchIds = [...new Set(result.results.map(expense => expense.branchId))];
  const accountIds = [
    ...new Set([
      ...result.results.map(expense => expense.expenseAccount),
      ...result.results.map(expense => expense.paidThroughAccountId),
    ]),
  ];
  const addedByIds = [...new Set(result.results.map(expense => expense.addedBy))];
  const updatedByIds = [...new Set(result.results.map(expense => toUpdatedByUserIdString(expense.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];

  // Fetch all customers and vendors in one query
  const customers = await Customer.find({
    _id: { $in: [...customerIds, ...vendorIds] },
  })
    .select('customerDisplayName')
    .lean();

  // Create maps for quick lookups
  const customerMap = customers.reduce((acc, customer) => {
    acc[customer._id.toString()] = customer;
    return acc;
  }, {});

  // Create maps for quick lookups
  const division = await Division.find({
    _id: { $in: divisionIds },
  })
    .select('name')
    .lean();

  const divisionMap = division.reduce((acc, division) => {
    acc[division._id.toString()] = division;
    return acc;
  }, {});

  const branch = await Branch.find({
    _id: { $in: branchIds },
  })
    .select('name')
    .lean();

  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName')
    .lean();

  const branchMap = branch.reduce((acc, branch) => {
    acc[branch._id.toString()] = branch;
    return acc;
  }, {});

  const account = await Account.find({
    _id: { $in: accountIds },
  })
    .select('accountName')
    .lean();

  const accountMap = account.reduce((acc, account) => {
    acc[account._id.toString()] = account;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  // Populate the results with customer and vendor data
  const populatedResults = result.results.map(expense => {
    const expenseObj = expense.toObject();
    expenseObj.customer = customerMap[expense.customer?.toString()] || null;
    expenseObj.divisionId = divisionMap[expense.divisionId?.toString()] || null;
    expenseObj.branchId = branchMap[expense.branchId?.toString()] || null;
    expenseObj.expenseAccount = accountMap[expense.expenseAccount?.toString()] || null;
    expenseObj.paidThroughAccountId = accountMap[expense.paidThroughAccountId?.toString()] || null;

    expenseObj.id = expenseObj._id;

    expenseObj.addedBy = userMap[expense.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(expenseObj.updatedBy);
    expenseObj.updatedBy = updatedById ? (userMap[updatedById] ?? null) : null;
    return expenseObj;
  });

  return {
    ...result,
    results: await enrichDocumentCurrency(String(filter.companyId), populatedResults),
  };
};

/**
 * Get a recurring expense by ID
 * @param {ObjectId} id
 * @returns {Promise<RecurringExpense>}
 */
const getRecurringExpenseById = async (id, companyId) => {
  const { RecurringExpense, RecurringExpenseHistory, Account } = getBooksModels();
  const { Customer, Branch, Division, Warehouse } = getBooksCrmModels();
  const { User, Company } = getCommonModels();

  const data = await RecurringExpense.findOne({ _id: id, companyId });
  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_EXPENSE_MESSAGES.FETCH_NOT_FOUND);
  }
  const account = await Account.findById(data?.expenseAccount).select('accountName');
  const paidThroughAccount = data?.paidThroughAccountId
    ? await Account.findById(data.paidThroughAccountId).select('accountName accountCode')
    : null;
  const addedBy = await User.findById(data.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(data.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findById(data.branchId).select('name');
  const division = await Division.findById(data.divisionId).select('name');
  const warehouse = await Warehouse.findById(data.warehouseId).select('name');
  const customer = await Customer.findById(data?.customer)
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails')
    .lean();

  let commentHistoryWithUser = [];
  if (data.commentHistory?.length) {
    const userIds = data.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = data.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy,
      };
    });
  }

  const expenseObj = data.toObject();
  expenseObj.addedBy = addedBy;
  expenseObj.updatedBy = updatedBy;
  expenseObj.expenseAccountName = account?.accountName || null;
  expenseObj.paidThroughAccountId = paidThroughAccount;
  expenseObj.paidThroughAccountName = paidThroughAccount?.accountName || null;
  expenseObj.customer = customer;
  expenseObj.commentHistory = commentHistoryWithUser;
  expenseObj.branchName = branch?.name || null;
  expenseObj.divisionName = division?.name || null;
  expenseObj.warehouseName = warehouse?.name || null;

  const history = await RecurringExpenseHistory.find({ recurringExpenseId: id }).sort({ createdAt: -1 }).lean();
  expenseObj.history = history;

  return enrichDocumentCurrency(companyId, expenseObj);
};

/**
 * Update a recurring expense
 * @param {ObjectId} expenseId
 * @param {Object} updateBody
 * @param {ObjectId} userId
 * @param {Array} uploadedFiles
 * @returns {Promise<RecurringExpense>}
 */
const updateRecurringExpenseById = async (expenseId, updateBody, userId, uploadedFiles = []) => {
  const { RecurringExpense } = getBooksModels();
  const { Company } = getCommonModels();
  const expense = await RecurringExpense.findById(expenseId);
  if (!expense) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_EXPENSE_MESSAGES.FETCH_NOT_FOUND);
  }
  const company = await Company.findById(expense.companyId);
  if (!company) throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);

  const allAttachments = await handleFileUpdate({
    newFiles: uploadedFiles || [],
    currentUrls: updateBody.receipts || [],
    existingUrls: expense.receipts || [],
    userId,
    companyId: expense.companyId,
  });

  expense.updatedBy = userId;

  if (updateBody.vendor && String(updateBody.vendor) !== String(expense.vendor)) {
    const { currency, decimalPlaces } = await resolveTransactionCurrency({
      companyId: expense.companyId,
      vendorId: updateBody.vendor,
    });
    updateBody.currency = currency;
    updateBody.decimalPlaces = decimalPlaces;
  }
  updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

  const currencyDoc = await getCurrency(expense.companyId, updateBody.currency || expense.currency);

  const oldAmount = expense.amount || 0;
  const newAmount = updateBody.amount ?? oldAmount;

  let updateMsg = 'Recurring Expense updated.';
  if (oldAmount !== newAmount) {
    updateMsg = `Recurring Expense updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldAmount} to ${currencyDoc?.symbol || '₹'}${newAmount}`;
  }

  expense.commentHistory = expense.commentHistory || [];
  expense.commentHistory.push({
    message: updateMsg,
    addedBy: userId,
    createdAt: new Date(),
  });

  if (updateBody.expenseAccount) {
    const { Account } = getBooksModels();
    const expenseAccountDoc = await Account.findOne({
      _id: updateBody.expenseAccount,
      companyId: expense.companyId,
      isActive: true,
      category: { $in: [ACCOUNT_CATEGORIES.EXPENSE.code, ACCOUNT_CATEGORIES.COGS.code, ACCOUNT_CATEGORIES.OTHER_EXPENSE.code] },
    });
    if (!expenseAccountDoc) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Expense account not found or not an expense account');
    }
  }
  if (updateBody.paidThroughAccountId) {
    const { Account } = getBooksModels();
    const paidThroughAccountDoc = await Account.findOne({
      _id: updateBody.paidThroughAccountId,
      companyId: expense.companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    });
    if (!paidThroughAccountDoc) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Paid through account not found or not a money account');
    }
  }

  Object.assign(expense, {
    ...updateBody,
    receipts: allAttachments,
    authorizedSignature: company?.authorizedSignature,
    companyGstin: company?.gstNumber,
    companyLogo: company?.companyLogo,
  });
  await expense.save();
  return enrichDocumentCurrency(expense.companyId, expense.toJSON());
};

/**
 * Delete a recurring expense by ID
 * @param {ObjectId} expenseId
 * @returns {Promise<RecurringExpense>}
 */
const deleteRecurringExpenseById = async (expenseId, companyId) => {
  const { RecurringExpense, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const expense = await RecurringExpense.findOneAndDelete({ _id: expenseId, companyId }, { session });
    if (!expense) {
      throw new ApiError(httpStatus.NOT_FOUND, RECURRING_EXPENSE_MESSAGES.FETCH_NOT_FOUND);
    }

    await Expenses.updateMany(
      { companyId, 'commentHistory.referenceId': expense._id },
      { $set: { 'commentHistory.$[target].isDeleted': true } },
      { arrayFilters: [{ 'target.referenceId': expense._id }], session },
    );

    await session.commitTransaction();
    return expense;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

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

const createExpenseFromRecurringDoc = async (recurringExpenseHistoryId, userId, companyId) => {
  const { RecurringExpense, Expenses, RecurringExpenseHistory } = getBooksModels();
  const connection = await getClientConnection();
  const { Company } = getCommonModels();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const recurringExpenseHistory = await RecurringExpenseHistory.findOne({ _id: recurringExpenseHistoryId, companyId }).session(
      session,
    );
    if (!recurringExpenseHistory) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Recurring expense history record not found');
    }
    if (recurringExpenseHistory.status !== 'FAILED') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Expense can only be created from a failed history record');
    }

    const recurringExpense = await RecurringExpense.findOne({
      _id: recurringExpenseHistory.recurringExpenseId,
      companyId,
    }).session(session);
    if (!recurringExpense) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Recurring expense template not found');
    }

    const now = new Date();
    const expenseDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const company = await Company.findById(companyId).session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    const ids = await generateMultipleUniqueIdsForModules(
      Expenses,
      companyId,
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

    const nextExecutionDate = getNextExecutionDate(
      recurringExpenseHistory.scheduledDate,
      recurringExpenseHistory?.executedDate,
      recurringExpense.repeatEvery.frequency,
      recurringExpense.repeatEvery.period,
    );

    let shippingAddressId = null;
    if (recurringExpense?.addressId?.toString() === company?.address?._id?.toString()) {
      shippingAddressId = company?.address?._id;
    } else if (
      company?.additionalShippingAddresses?.some(address => address?._id?.toString() === recurringExpense?.addressId?.toString())
    ) {
      shippingAddressId = company?.additionalShippingAddresses?.find(
        address => address?._id?.toString() === recurringExpense?.addressId?.toString(),
      )?._id;
    }

    if (!shippingAddressId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
    }

    await validateExpenseAccounts({
      companyId: recurringExpense.companyId,
      expenseAccountId: recurringExpense.expenseAccount,
      paidThroughAccountId: recurringExpense.paidThroughAccountId,
      session,
    });

    const expenseObj = {
      companyId: recurringExpense.companyId,
      expenseId: ids.mainExpenseId,
      divisionId: recurringExpense.divisionId,
      branchId: recurringExpense.branchId,
      warehouseId: recurringExpense.warehouseId,
      expenseAccount: recurringExpense.expenseAccount,
      total: recurringExpense.amount,
      paidThroughAccountId: recurringExpense.paidThroughAccountId,
      notes: recurringExpense.notes,
      party: recurringExpense.customer,
      receipts: recurringExpense.receipts,
      attachments: recurringExpense.attachments,
      addressId: recurringExpense.addressId,
      addedBy: userId,
      authorizedSignature: recurringExpense.authorizedSignature,
      termsAndConditions: recurringExpense.termsAndConditions,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
      currency: recurringExpense.currency,
      exchangeRate: recurringExpense.exchangeRate,
      decimalPlaces: recurringExpense.decimalPlaces,
      date: expenseDate,
      commentHistory: [
        {
          message: `Expense created from recurring expense ${recurringExpense.recurringExpenseId}`,
          addedBy: userId,
          referenceType: 'RecurringExpense',
          referenceId: recurringExpense?._id,
          createdAt: new Date(),
        },
      ],
    };

    const [created] = await Expenses.create([expenseObj], { session });

    await ledgerService.postExpenseJournal({ companyId: created.companyId, expense: created, addedBy: userId }, session);

    await RecurringExpense.updateOne(
      { _id: recurringExpense._id },
      {
        $push: {
          commentHistory: {
            message: `Expense ${created.expenseId} generated from recurring expense ${recurringExpense.recurringExpenseId}`,
            addedBy: userId,
            createdAt: new Date(),
            referenceType: 'Expense',
            referenceId: created._id,
          },
        },
      },
      { session, runValidators: true },
    );

    await RecurringExpenseHistory.updateOne(
      { _id: recurringExpenseHistoryId },
      {
        $set: {
          generatedExpenseId: created._id,
          generatedExpenseNumber: ids.mainExpenseId,
          status: RECURRING_EXPENSE_STATUS.SUCCESS,
          nextExecutionDate,
        },
        $unset: {
          errorMessage: '',
          metadata: '',
        },
      },
      {
        session,
      },
    );

    await session.commitTransaction();
    return created;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateRecurringExpenseStatus = async (expenseId, status, userId, companyId) => {
  const { RecurringExpense, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const expense = await RecurringExpense.findOne({ _id: expenseId, companyId }).session(session);
    if (!expense) {
      throw new ApiError(httpStatus.NOT_FOUND, RECURRING_EXPENSE_MESSAGES.FETCH_NOT_FOUND);
    }

    const oldStatus = expense.status;

    if ([RECURRING_DOC_STATUS.COMPLETED, RECURRING_DOC_STATUS.CANCELLED].includes(oldStatus)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot change the status of a ${String(oldStatus).toLowerCase()} recurring expense`,
      );
    }

    if (status === RECURRING_DOC_STATUS.CANCELLED) {
      await Expenses.updateMany(
        { companyId, 'commentHistory.referenceId': expense._id },
        { $set: { 'commentHistory.$[target].isCancelled': true } },
        { arrayFilters: [{ 'target.referenceId': expense._id }], session },
      );
    }

    expense.commentHistory = expense.commentHistory || [];
    expense.commentHistory.push({
      message: `Status changed from ${oldStatus} to ${status}.`,
      addedBy: userId,
      createdAt: new Date(),
    });

    expense.status = status;
    expense.updatedBy = userId;

    await expense.save({ session });
    await session.commitTransaction();
    return expense;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  createRecurringExpense: withTransientRetry(createRecurringExpense),
  queryRecurringExpenses,
  getRecurringExpenseById,
  updateRecurringExpenseById,
  deleteRecurringExpenseById,
  createExpenseFromRecurringDoc: withTransientRetry(createExpenseFromRecurringDoc),
  updateRecurringExpenseStatus,
};
