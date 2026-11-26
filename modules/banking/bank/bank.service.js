const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels, getBooksCrmModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const {
  BANK_TYPES,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  LEDGER_SOURCE_MODULES,
  PAYMENT_ACCOUNT_CATEGORIES,
  BANK_TYPE_BY_ACCOUNT_CATEGORY,
  ACCOUNT_CATEGORY_BY_BANK_TYPE,
  SOURCE_DOCUMENTS,
} = require('../../../utils/enum');
const { BANK_MESSAGES } = require('../../../utils/messages');
const { BALANCE_TYPES } = require('@smit9313/abss-models-core/src/utils/enum');
const { getCurrency, resolveTransactionCurrency } = require('../../../services/currencyResolver.service');
const ledgerService = require('../../accountant/ledger/ledger.service');
const accountService = require('../../accountant/chartOfAccount/account.service');
const bankTransformer = require('./bank.transformer');

// Bank-category account filter shared by the list and the dropdown.
const buildBankAccountFilter = async filter => {
  const accountFilter = { companyId: filter.companyId, isActive: true };

  if (filter.accountType) {
    const categories = filter.accountType.split(',').map(type => ACCOUNT_CATEGORY_BY_BANK_TYPE[type.trim()]);
    accountFilter.category = { $in: categories.filter(Boolean) };
  } else {
    accountFilter.category = { $in: PAYMENT_ACCOUNT_CATEGORIES };
  }

  if (filter.isPrimary !== undefined) accountFilter['bankDetails.isPrimary'] = filter.isPrimary;

  return accountFilter;
};

const toBankView = (account, { currencyDoc = null, openingBalance = 0, availableBalance = 0 } = {}) => ({
  id: account._id?.toString(),
  companyId: account.companyId,
  accountId: account._id,
  accountType: BANK_TYPE_BY_ACCOUNT_CATEGORY[account.category] || account.category,
  accountName: account.accountName,
  accountCode: account.accountCode,
  accountNumber: account.bankDetails?.accountNumber || '',
  bankName: account.bankDetails?.bankName || '',
  ifsc: account.bankDetails?.ifsc || '',
  branch: account.bankDetails?.branch || '',
  gstinUin: account.bankDetails?.gstinUin || '',
  isPrimary: account.bankDetails?.isPrimary === true,
  description: account.description || '',
  openingBalance,
  availableBalance,
  currency: currencyDoc,
  divisionId: account.divisionId,
  branchId: account.branchId,
  isSystemAccount: account.isSystemAccount === true,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

// A money account a banking flow moves funds to/from. Category-checked.
const resolveCounterpartAccount = async (companyId, accountId, allowedCategories, session) => {
  const { Account } = getBooksModels();
  const account = await Account.findOne({ _id: accountId, companyId, isActive: true })
    .session(session || null)
    .lean();
  if (!account) throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.COUNTERPART_ACCOUNT_NOT_FOUND);
  if (!allowedCategories.includes(account.category)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${account.accountName} ${BANK_MESSAGES.COUNTERPART_CATEGORY_NOT_ALLOWED}`);
  }
  return account;
};

const createNewBank = async (bankBody, userId) => {
  const { Account } = getBooksModels();
  const { companyId } = bankBody;

  const category = ACCOUNT_CATEGORY_BY_BANK_TYPE[bankBody.accountType];
  if (!category) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid account type: ${bankBody.accountType}`);
  }

  if (bankBody.accountNumber) {
    const accountNumberExists = await Account.findOne({
      companyId,
      'bankDetails.accountNumber': bankBody.accountNumber,
      isActive: true,
    }).lean();
    if (accountNumberExists) {
      throw new ApiError(httpStatus.CONFLICT, BANK_MESSAGES.ACCOUNT_NO_EXISTS);
    }
  }

  // Only one Petty Cash account per company (system generated at company creation).
  if (bankBody.accountType === BANK_TYPES.PETTY_CASH) {
    const pettyCashExists = await Account.findOne({ companyId, category, isActive: true }).select('_id').lean();
    if (pettyCashExists) {
      throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.PETTY_CASH_EXISTS);
    }
  }

  const duplicate = await Account.findOne({
    companyId,
    category,
    accountName: bankBody.accountName,
    ...(bankBody.accountType === BANK_TYPES.BANK && { 'bankDetails.accountNumber': bankBody.accountNumber }),
    isActive: true,
  }).lean();
  if (duplicate) {
    throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.BANK_EXISTS);
  }

  if (!(await getCurrency(companyId, bankBody.currency))) {
    throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.INVALID_CURRENCY);
  }

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  let account;
  const openingBalance = Number(bankBody.openingBalance) || 0;
  try {
    await session.startTransaction();

    [account] = await Account.create(
      [
        {
          companyId,
          accountName: bankBody.accountName,
          accountCode: bankBody.accountCode?.trim() || null,
          category,
          currencyId: bankBody.currency,
          bankDetails: {
            accountNumber: bankBody.accountNumber || '',
            bankName: bankBody.bankName || '',
            ifsc: bankBody.ifsc || '',
            branch: bankBody.branch || '',
            gstinUin: bankBody.gstinUin || '',
            isPrimary: bankBody.isPrimary === true,
          },
          description: bankBody.description || '',
          divisionId: bankBody.divisionId || null,
          branchId: bankBody.branchId || null,
          isActive: true,
          addedBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );

    if (openingBalance) {
      await accountService.saveAccountOpeningBalance(
        {
          companyId,
          accountId: account._id,
          amount: Math.abs(openingBalance),
          balanceType: openingBalance > 0 ? BALANCE_TYPES.DEBIT : BALANCE_TYPES.CREDIT,
          openingBalanceDate: new Date(),
        },
        userId,
        session,
      );
    }

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }

  const currencyDoc = await getCurrency(companyId, account.currencyId);
  return toBankView(account.toObject(), { currencyDoc, openingBalance, availableBalance: openingBalance });
};

const getBanksByCompanyId = async (query, filter, options) => {
  const { Account, AccountOpeningBalance } = getBooksModels();

  const accountFilter = await buildBankAccountFilter(filter);
  accountFilter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    accountFilter.$or = [
      { accountName: searchRegex },
      { accountCode: searchRegex },
      { description: searchRegex },
      { 'bankDetails.accountNumber': searchRegex },
      { 'bankDetails.bankName': searchRegex },
      { 'bankDetails.ifsc': searchRegex },
      { 'bankDetails.branch': searchRegex },
    ];
  }

  const accounts = await Account.paginate(accountFilter, options);

  // Company-wide totals use base currency; individual account balances use each account's own currency.
  const allMatchingIds = await Account.find(accountFilter).distinct('_id');
  const [baseBalances, balances] = await Promise.all([
    ledgerService.getAccountBalances({ companyId: filter.companyId }),
    ledgerService.getAccountBalances({ companyId: filter.companyId, accountIds: allMatchingIds, inAccountCurrency: true }),
  ]);
  const totalOfAvailableBalance = allMatchingIds.reduce((sum, id) => {
    const totals = baseBalances.get(String(id));
    return sum + Math.round(((totals?.debit || 0) - (totals?.credit || 0)) * 100) / 100;
  }, 0);

  const accountIds = accounts.results.map(account => account._id);
  const [currencies, openingBalances] = await Promise.all([
    getCurrency(filter.companyId, accounts.results.map(account => account.currencyId).filter(Boolean)),
    AccountOpeningBalance.find({ companyId: filter.companyId, accountId: { $in: accountIds } }).lean(),
  ]);
  const currencyById = new Map((currencies || []).map(currency => [String(currency._id), currency]));
  const openingBalanceByAccountId = new Map(openingBalances.map(doc => [String(doc.accountId), doc]));

  return {
    ...accounts,
    results: accounts.results.map(account => {
      const openingBalanceDoc = openingBalanceByAccountId.get(String(account._id));
      const openingBalance =
        openingBalanceDoc?.balanceType === BALANCE_TYPES.CREDIT ? -openingBalanceDoc.amount : openingBalanceDoc?.amount || 0;
      const totals = balances.get(String(account._id));
      return toBankView(account.toObject ? account.toObject() : account, {
        currencyDoc: currencyById.get(String(account.currencyId)) || null,
        openingBalance,
        availableBalance: Math.round(((totals?.debit || 0) - (totals?.credit || 0)) * 100) / 100,
      });
    }),
    totalOfAvailableBalance: Math.round(totalOfAvailableBalance * 100) / 100,
  };
};

const updateBankById = async (accountId, updateData, userId) => {
  const { Account, AccountOpeningBalance } = getBooksModels();
  const account = await Account.findOne({ _id: accountId, companyId: updateData.companyId });
  if (!account || !PAYMENT_ACCOUNT_CATEGORIES.includes(account.category)) {
    throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (updateData.accountNumber) {
    const accountNumberExists = await Account.findOne({
      companyId: account.companyId,
      'bankDetails.accountNumber': updateData.accountNumber,
      _id: { $ne: accountId },
      isActive: true,
    }).lean();
    if (accountNumberExists) {
      throw new ApiError(httpStatus.CONFLICT, BANK_MESSAGES.ACCOUNT_NO_EXISTS);
    }
  }

  if (updateData.currency) {
    if (!(await getCurrency(account.companyId, updateData.currency))) {
      throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.INVALID_CURRENCY);
    }
    account.currencyId = updateData.currency;
  }

  if (updateData.accountName !== undefined) account.accountName = updateData.accountName;
  if (updateData.accountCode !== undefined) account.accountCode = updateData.accountCode?.trim() || null;
  if (updateData.description !== undefined) account.description = updateData.description;
  if (updateData.divisionId !== undefined) account.divisionId = updateData.divisionId || null;
  if (updateData.branchId !== undefined) account.branchId = updateData.branchId || null;

  account.bankDetails = account.bankDetails || {};
  if (updateData.accountNumber !== undefined) account.bankDetails.accountNumber = updateData.accountNumber;
  if (updateData.bankName !== undefined) account.bankDetails.bankName = updateData.bankName;
  if (updateData.ifsc !== undefined) account.bankDetails.ifsc = updateData.ifsc;
  if (updateData.branch !== undefined) account.bankDetails.branch = updateData.branch;
  if (updateData.gstinUin !== undefined) account.bankDetails.gstinUin = updateData.gstinUin;
  if (updateData.isPrimary !== undefined) account.bankDetails.isPrimary = updateData.isPrimary === true;

  account.updatedBy = userId;

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database connection not available');
  }

  const session = await connection.startSession();
  let openingBalance;
  try {
    await session.startTransaction();

    const existingOpeningBalance = await AccountOpeningBalance.findOne({
      companyId: account.companyId,
      accountId: account._id,
    }).session(session);
    openingBalance =
      existingOpeningBalance?.balanceType === BALANCE_TYPES.CREDIT
        ? -existingOpeningBalance.amount
        : existingOpeningBalance?.amount || 0;

    // Editing the opening balance = replace it (journal handled by the shared
    // account flow) and shift the running balance by the difference.
    if (updateData.openingBalance !== undefined && Number(updateData.openingBalance) !== openingBalance) {
      const newOpeningBalance = Number(updateData.openingBalance) || 0;

      if (newOpeningBalance) {
        await accountService.saveAccountOpeningBalance(
          {
            companyId: account.companyId,
            accountId: account._id,
            amount: Math.abs(newOpeningBalance),
            balanceType: newOpeningBalance > 0 ? BALANCE_TYPES.DEBIT : BALANCE_TYPES.CREDIT,
            openingBalanceDate: existingOpeningBalance?.openingBalanceDate || new Date(),
          },
          userId,
          session,
        );
      } else {
        await accountService.removeAccountOpeningBalance(account.companyId, account._id, session);
      }

      openingBalance = newOpeningBalance;
    }

    await account.save({ session });
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }

  const [currencyDoc, balances] = await Promise.all([
    getCurrency(account.companyId, account.currencyId),
    ledgerService.getAccountBalances({ companyId: account.companyId, accountId: account._id, inAccountCurrency: true }),
  ]);
  const totals = balances.get(String(account._id));
  return toBankView(account.toObject(), {
    currencyDoc,
    openingBalance,
    availableBalance: Math.round(((totals?.debit || 0) - (totals?.credit || 0)) * 100) / 100,
  });
};

const deleteBankById = async (accountId, companyId) => {
  const { Account } = getBooksModels();

  const account = await Account.findOne({ _id: accountId, companyId });
  if (!account || !PAYMENT_ACCOUNT_CATEGORIES.includes(account.category)) {
    throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  if (account.isSystemAccount) {
    throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.SYSTEM_BANK_DELETE_FORBIDDEN);
  }

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database connection not available');
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    await accountService.removeAccountOpeningBalance(account.companyId, account._id, session);

    account.isActive = false;
    await account.save({ session });

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return account;
};

const transferAmount = async (updateData, userId, companyId) => {
  const { BankTransferLog } = getBooksCrmModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { fromAccountId, toAccountId, amount, fromAmount, date, exchangeRate } = updateData;

    if (String(fromAccountId) === String(toAccountId)) {
      throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.TRANSFER_SAME_ACCOUNT);
    }

    const fromAccount = await resolveCounterpartAccount(companyId, fromAccountId, PAYMENT_ACCOUNT_CATEGORIES, session);
    const toAccount = await resolveCounterpartAccount(companyId, toAccountId, PAYMENT_ACCOUNT_CATEGORIES, session);

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).select('baseCurrency').session(session);
    const fromCurrencyDoc = await getCurrency(companyId, fromAccount.currencyId || company?.baseCurrency);
    const toCurrencyDoc = await getCurrency(companyId, toAccount.currencyId || company?.baseCurrency);
    const fromCurrency = fromCurrencyDoc?.code || '';
    const toCurrency = toCurrencyDoc?.code || '';
    const isMultiCurrency = fromCurrency !== toCurrency;

    if (isMultiCurrency && (!exchangeRate || exchangeRate <= 0)) {
      throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.EXCHANGE_RATE_REQUIRED);
    }

    const toAmount = Math.round(amount * 100) / 100;
    const sourceAmount = !isMultiCurrency ? toAmount : Math.round((fromAmount || amount / exchangeRate) * 100) / 100;

    await BankTransferLog.create(
      [
        {
          companyId,
          fromAccountId,
          toAccountId,
          amount: toAmount,
          currency: toCurrencyDoc?._id,
          fromAmount: sourceAmount,
          fromCurrency,
          fromCurrencyId: fromCurrencyDoc?._id,
          toAmount,
          toCurrency,
          toCurrencyId: toCurrencyDoc?._id,
          exchangeRate: isMultiCurrency ? exchangeRate : null,
          transactionType: TRANSACTION_TYPES.TRANSFER,
          transactionStatus: TRANSACTION_STATUS.PENDING,
          transferredBy: userId,
          transactionDescription: `Transfer from ${fromAccount.accountName} to ${toAccount.accountName}`,
          date,
        },
      ],
      { session },
    );

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const withdrawOrDeposit = async (data, userId, companyId) => {
  const { BankTransferLog } = getBooksCrmModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database connection not available');
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { transactionType, fromAccountId, toAccountId, amount, fromAmount, exchangeRate } = data;

    if (String(fromAccountId) === String(toAccountId)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        transactionType === TRANSACTION_TYPES.DEPOSIT ? BANK_MESSAGES.DEPOSIT_SAME_ACCOUNT : BANK_MESSAGES.WITHDRAW_SAME_ACCOUNT,
      );
    }

    // Deposit: cash -> bank. Withdrawal: bank -> cash.
    const isDeposit = transactionType === TRANSACTION_TYPES.DEPOSIT;
    const fromAccount = await resolveCounterpartAccount(companyId, fromAccountId, PAYMENT_ACCOUNT_CATEGORIES, session);
    const toAccount = await resolveCounterpartAccount(companyId, toAccountId, PAYMENT_ACCOUNT_CATEGORIES, session);

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).select('baseCurrency').session(session);
    const fromCurrencyDoc = await getCurrency(companyId, fromAccount.currencyId || company?.baseCurrency);
    const toCurrencyDoc = await getCurrency(companyId, toAccount.currencyId || company?.baseCurrency);
    const fromCurrency = fromCurrencyDoc?.code || '';
    const toCurrency = toCurrencyDoc?.code || '';
    const isMultiCurrency = fromCurrency !== toCurrency;

    if (isMultiCurrency && (!exchangeRate || exchangeRate <= 0)) {
      throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.EXCHANGE_RATE_REQUIRED);
    }

    const toAmount = Math.round(amount * 100) / 100;
    const sourceAmount = !isMultiCurrency ? toAmount : Math.round((fromAmount || amount / exchangeRate) * 100) / 100;

    await BankTransferLog.create(
      [
        {
          companyId,
          fromAccountId,
          toAccountId,
          currency: isDeposit ? toCurrencyDoc?._id : fromCurrencyDoc?._id,
          amount: toAmount,
          fromAmount: sourceAmount,
          fromCurrency,
          fromCurrencyId: fromCurrencyDoc?._id,
          toAmount,
          toCurrency,
          toCurrencyId: toCurrencyDoc?._id,
          exchangeRate: isMultiCurrency ? exchangeRate : null,
          transactionType,
          date: data.date,
          transactionDescription: data.transactionDescription,
          transferredBy: userId,
        },
      ],
      { session },
    );
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getTransactions = async query => {
  const { BankTransferLog } = getBooksCrmModels();

  let filter = { companyId: new mongoose.Types.ObjectId(query.companyId) };
  if (query.bankId) {
    const accountId = new mongoose.Types.ObjectId(query.bankId);
    filter = { ...filter, $or: [{ fromAccountId: accountId }, { toAccountId: accountId }] };
  }
  if (query.transactionType) filter.transactionType = query.transactionType;

  const paginationQuery = { ...query };
  delete paginationQuery.bankId;
  paginationQuery.sortBy = paginationQuery.sortBy ? `${paginationQuery.sortBy}, date:desc` : 'date:desc';
  const transactions = await BankTransferLog.paginate(filter, paginationQuery);

  const { results } = transactions;
  if (!results.length) return bankTransformer.paginatedTransactions(transactions);

  const accountIds = [...new Set(results.flatMap(t => [t.fromAccountId, t.toAccountId]).filter(Boolean))];
  const userIds = [...new Set(results.map(t => t.transferredBy).filter(Boolean))];
  const { Account } = getBooksModels();
  const { User } = getCommonModels();

  const [currencies, accounts, users] = await Promise.all([
    getCurrency(
      query.companyId,
      results.flatMap(t => [t.currency, t.fromCurrencyId, t.toCurrencyId]),
    ),
    Account.find({ _id: { $in: accountIds } })
      .select('accountName')
      .lean(),
    User.find({ _id: { $in: userIds } })
      .select('firstName lastName email')
      .lean(),
  ]);

  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));
  const accountNameById = new Map(accounts.map(a => [String(a._id), a.accountName]));
  const userById = new Map(users.map(u => [String(u._id), u]));

  return bankTransformer.paginatedTransactions({
    ...transactions,
    results: results.map(t => {
      const row = t.toObject ? t.toObject() : t;
      return {
        ...row,
        transferredBy: userById.get(String(row.transferredBy)) || null,
        currency: currencyMap.get(String(row.currency)) || '',
        fromCurrency: currencyMap.get(String(row.fromCurrencyId)) || '',
        toCurrency: currencyMap.get(String(row.toCurrencyId)) || '',
        fromAccountName: accountNameById.get(String(row.fromAccountId)) || '',
        toAccountName: accountNameById.get(String(row.toAccountId)) || '',
      };
    }),
  });
};

const getTransactionById = async (transactionId, companyId) => {
  const { BankTransferLog } = getBooksCrmModels();
  const { Account } = getBooksModels();
  const { User } = getCommonModels();

  const transaction = await BankTransferLog.findOne({
    _id: transactionId,
    companyId,
  }).lean();

  if (!transaction) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Transaction not found');
  }

  const comments = Array.isArray(transaction.commentHistory) ? transaction.commentHistory : [];
  const accountIds = [transaction.fromAccountId, transaction.toAccountId].filter(Boolean).map(String);
  const currencyIds = [transaction.currency, transaction.fromCurrencyId, transaction.toCurrencyId].filter(Boolean).map(String);
  const userIds = [transaction.transferredBy, transaction.approvedBy, ...comments.map(comment => comment.addedBy)]
    .filter(Boolean)
    .map(String);
  const uniqueAccountIds = [...new Set(accountIds)];
  const uniqueCurrencyIds = [...new Set(currencyIds)];
  const uniqueUserIds = [...new Set(userIds)];
  const [accounts, currencies, users] = await Promise.all([
    uniqueAccountIds.length
      ? Account.find({
          _id: { $in: uniqueAccountIds },
          companyId,
        })
          .select('accountName accountCode bankDetails currencyId')
          .lean()
      : [],
    uniqueCurrencyIds.length ? getCurrency(companyId, uniqueCurrencyIds) : [],
    uniqueUserIds.length
      ? User.find({
          _id: { $in: uniqueUserIds },
        })
          .select('firstName lastName email')
          .lean()
      : [],
  ]);

  const accountMap = new Map(accounts.map(account => [String(account._id), account]));
  const currencyMap = new Map(currencies.map(currency => [String(currency._id), currency]));
  const userMap = new Map(users.map(user => [String(user._id), user]));
  const mapAccount = accountRef => {
    if (!accountRef) {
      return null;
    }
    const accountId = String(accountRef);
    const account = accountMap.get(accountId);
    if (!account) {
      return null;
    }
    return {
      _id: account._id,
      accountName: account.accountName || null,
      accountCode: account.accountCode || null,
      bankName: account.bankDetails?.bankName || null,
      accountNumber: account.bankDetails?.accountNumber || null,
      currency: account.currencyId || null,
    };
  };

  const mapUser = userId => {
    if (!userId) {
      return null;
    }
    return userMap.get(String(userId)) || null;
  };
  const commentHistory = comments.map(comment => ({
    ...comment,
    addedBy: mapUser(comment.addedBy),
  }));

  return {
    ...transaction,
    fromAccountId: mapAccount(transaction.fromAccountId),
    toAccountId: mapAccount(transaction.toAccountId),
    transferredBy: mapUser(transaction.transferredBy),
    approvedBy: mapUser(transaction.approvedBy),
    commentHistory,
    currency: currencyMap.get(String(transaction.currency)) || null,
    fromCurrency: currencyMap.get(String(transaction.fromCurrencyId)) || null,
    toCurrency: currencyMap.get(String(transaction.toCurrencyId)) || null,
  };
};

// Ledger source module for a bank transaction, split by type so deposits/withdrawals/transfers show up distinctly.
const getBankSourceModule = transactionType => {
  if (transactionType === TRANSACTION_TYPES.DEPOSIT) return LEDGER_SOURCE_MODULES.BANK_DEPOSIT;
  if (transactionType === TRANSACTION_TYPES.WITHDRAWAL) return LEDGER_SOURCE_MODULES.BANK_WITHDRAWAL;
  return LEDGER_SOURCE_MODULES.BANK_TRANSFER;
};

const approveTransaction = async (body, userId, companyId) => {
  const { BankTransferLog } = getBooksCrmModels();
  const { Account } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  await session.startTransaction();
  const { transactionId, notes } = body;
  try {
    const transaction = await BankTransferLog.findOne({ _id: transactionId, companyId }).session(session);

    if (!transaction) {
      throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.TRANSACTION_NOT_FOUND);
    }
    if (transaction.transactionStatus === TRANSACTION_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.TRANSACTION_ALREADY_APPROVED);
    }

    // Money moves on approval: credit the source, debit the destination.
    const fromAmount = transaction.fromAmount || transaction.amount;
    const toAmount = transaction.toAmount || transaction.amount;

    // Post to the ledger: debit the destination, credit the source; each leg is in its own currency at its own rate to base, so a cross-currency transfer still balances and any conversion spread lands in Exchange Gain or Loss.
    const [toBase, fromBase, fromAccount, toAccount] = await Promise.all([
      resolveTransactionCurrency({ companyId, currencyId: transaction.toCurrencyId }),
      resolveTransactionCurrency({ companyId, currencyId: transaction.fromCurrencyId }),
      Account.findOne({ _id: transaction.fromAccountId, companyId }).select('accountName').session(session).lean(),
      Account.findOne({ _id: transaction.toAccountId, companyId }).select('accountName').session(session).lean(),
    ]);

    const narration = `${fromAccount?.accountName || ''} to ${toAccount?.accountName || ''}`;

    await ledgerService.postBankTransferJournal(
      {
        companyId,
        postingDate: transaction.date,
        sourceId: transaction._id,
        narration,
        addedBy: userId,
        debitAccountId: transaction.toAccountId,
        debitAmount: toAmount,
        debitCurrencyId: transaction.toCurrencyId,
        debitExchangeRate: toBase.exchangeRate,
        creditAccountId: transaction.fromAccountId,
        creditAmount: fromAmount,
        creditCurrencyId: transaction.fromCurrencyId,
        creditExchangeRate: fromBase.exchangeRate,
        sourceModule: getBankSourceModule(transaction.transactionType),
      },
      session,
    );

    transaction.transactionStatus = TRANSACTION_STATUS.APPROVED;
    transaction.approvedBy = userId;
    transaction.approvedAt = new Date();
    if (notes !== undefined) {
      transaction.approvalNote = notes;
    }

    const approvalMessage =
      transaction.transactionType === TRANSACTION_TYPES.TRANSFER && transaction.fromCurrency !== transaction.toCurrency
        ? `Transaction approved: ${fromAmount} ${transaction.fromCurrency} → ${toAmount} ${transaction.toCurrency}`
        : `Transaction approved with amount ${toAmount} ${transaction.toCurrency || ''}`.trim();

    transaction.commentHistory.push({
      message: approvalMessage,
      addedBy: userId,
    });

    await transaction.save({ session });
    await session.commitTransaction();
    return transaction;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const rejectTransaction = async (body, userId, companyId) => {
  const { BankTransferLog } = getBooksCrmModels();
  const { notes, transactionId } = body;

  const transaction = await BankTransferLog.findOne({ _id: transactionId, companyId });
  if (!transaction) throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.TRANSACTION_NOT_FOUND);
  if (transaction.transactionStatus === TRANSACTION_STATUS.REJECTED) {
    throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.TRANSACTION_ALREADY_REJECTED);
  }

  transaction.transactionStatus = TRANSACTION_STATUS.REJECTED;
  if (notes !== undefined) transaction.approvalNote = notes;

  transaction.commentHistory.push({
    message: `Transaction rejected with amount ${transaction.amount}`,
    addedBy: userId,
  });

  await transaction.save();
};

const cancelTransaction = async (body, userId, companyId) => {
  const { BankTransferLog } = getBooksCrmModels();
  const connection = await getClientConnection();
  const { notes, transactionId } = body;

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  await session.startTransaction();

  try {
    const transaction = await BankTransferLog.findOne({ _id: transactionId, companyId }).session(session);

    if (!transaction) {
      throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.TRANSACTION_NOT_FOUND);
    }
    if (transaction.transactionStatus === TRANSACTION_STATUS.CANCELLED) {
      throw new ApiError(httpStatus.BAD_REQUEST, BANK_MESSAGES.TRANSACTION_ALREADY_CANCELLED);
    }

    const wasApproved = transaction.transactionStatus === TRANSACTION_STATUS.APPROVED;

    if (wasApproved) {
      // Reverse the ledger entry posted at approval (no-op if it was never posted — the
      // cross-currency case, which never moved a balance anywhere to begin with).
      await ledgerService.deleteJournal(
        { companyId, sourceModule: getBankSourceModule(transaction.transactionType), sourceId: transaction._id },
        session,
      );
    }

    transaction.transactionStatus = TRANSACTION_STATUS.CANCELLED;
    if (notes !== undefined) transaction.approvalNote = notes;

    const amount = transaction.toAmount || transaction.fromAmount || transaction.amount;
    const currency = transaction.toCurrency || transaction.fromCurrency || '';
    transaction.commentHistory.push({
      message: wasApproved
        ? `Approved transaction cancelled, amount ${amount} ${currency} reverted`.trim()
        : `Transaction cancelled with amount ${amount} ${currency}`.trim(),
      addedBy: userId,
    });

    await transaction.save({ session });
    await session.commitTransaction();
    return transaction;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const bankDropdown = async filter => {
  const { Account } = getBooksModels();

  const accountFilter = await buildBankAccountFilter(filter);

  const accounts = await Account.find(accountFilter).lean();
  const [currencies, balances] = await Promise.all([
    getCurrency(filter.companyId, accounts.map(account => account.currencyId).filter(Boolean)),
    ledgerService.getAccountBalances({
      companyId: filter.companyId,
      accountIds: accounts.map(account => account._id),
      inAccountCurrency: true,
    }),
  ]);
  const currencyById = new Map((currencies || []).map(currency => [String(currency._id), currency]));

  return accounts.map(account => {
    const totals = balances.get(String(account._id));
    return toBankView(account, {
      currencyDoc: currencyById.get(String(account.currencyId)) || null,
      availableBalance: Math.round(((totals?.debit || 0) - (totals?.credit || 0)) * 100) / 100,
    });
  });
};

const getBankById = async (id, companyId) => {
  const { Account, AccountOpeningBalance } = getBooksModels();
  const account = await Account.findOne({ _id: id, companyId }).lean();
  if (!account || !PAYMENT_ACCOUNT_CATEGORIES.includes(account.category)) {
    throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const [currencyDoc, openingBalanceDoc, balances] = await Promise.all([
    account.currencyId ? getCurrency(companyId, account.currencyId) : null,
    AccountOpeningBalance.findOne({ companyId, accountId: account._id }).lean(),
    ledgerService.getAccountBalances({ companyId, accountId: account._id, inAccountCurrency: true }),
  ]);
  const openingBalance =
    openingBalanceDoc?.balanceType === BALANCE_TYPES.CREDIT ? -openingBalanceDoc.amount : openingBalanceDoc?.amount || 0;
  const totals = balances.get(String(account._id));

  return toBankView(account, {
    currencyDoc,
    openingBalance,
    availableBalance: Math.round(((totals?.debit || 0) - (totals?.credit || 0)) * 100) / 100,
  });
};

const getLedgerEntryAmount = (row, accountCurrencyId) => {
  let amount;
  if (row.currencyId && String(row.currencyId) === String(accountCurrencyId)) {
    amount = row.foreignAmount != null ? row.foreignAmount : row.debit || row.credit;
  } else {
    amount = row.debit || row.credit;
  }
  return Math.round((amount || 0) * 100) / 100;
};

const getBankStatement = async ({
  companyId,
  accountId,
  page = 1,
  limit = 10,
  pagination = true,
  startDate = null,
  endDate = null,
  branchId = null,
  divisionId = null,
  isSplit = false,
  sortOrder = 'asc',
}) => {
  const { Account, AccountOpeningBalance, LedgerEntry } = getBooksModels();

  const account = await Account.findOne({
    _id: accountId,
    companyId,
  }).lean();

  if (!account) {
    throw new ApiError(httpStatus.NOT_FOUND, BANK_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const filter = {
    companyId,
    accountId,
  };

  if (!isSplit) {
    filter.isSplit = false;
  }
  if (branchId) {
    filter.branchId = branchId;
  }
  if (divisionId) {
    filter.divisionId = divisionId;
  }
  if (startDate || endDate) {
    filter.postingDate = {};
    if (startDate) {
      filter.postingDate.$gte = new Date(startDate);
    }
    if (endDate) {
      filter.postingDate.$lte = new Date(endDate);
    }
  }

  const scope = {
    companyId,
    accountId,
    branchId,
    divisionId,
    includeSplit: isSplit,
  };

  const paginationEnabled = ![false, 'false'].includes(pagination);
  const pageNum = page && Number(page) > 0 ? Number(page) : 1;
  const limitNum = limit && Number(limit) > 0 ? Number(limit) : 10;

  const [balances, openingBalanceDoc, result] = await Promise.all([
    ledgerService.getAccountBalances({
      ...scope,
      upToDate: endDate,
      inAccountCurrency: true,
    }),

    startDate
      ? null
      : AccountOpeningBalance.findOne({
          companyId,
          accountId,
        }).lean(),

    LedgerEntry.paginate(filter, {
      page: pageNum,
      limit: limitNum,
      sortBy: sortOrder === 'desc' ? 'postingDate:desc,createdAt:desc' : 'postingDate:asc,createdAt:asc',
      pagination: paginationEnabled,
    }),
  ]);

  const totals = balances.get(String(accountId)) || {
    debit: 0,
    credit: 0,
  };

  const closingBalance = Math.round((totals.debit - totals.credit) * 100) / 100;

  let openingBalance;

  if (startDate) {
    const openingBalances = await ledgerService.getAccountBalances({
      ...scope,
      beforeDate: startDate,
      inAccountCurrency: true,
    });

    const opening = openingBalances.get(String(accountId)) || {
      debit: 0,
      credit: 0,
    };

    openingBalance = Math.round((opening.debit - opening.credit) * 100) / 100;
  } else if (openingBalanceDoc?.balanceType === BALANCE_TYPES.CREDIT) {
    openingBalance = -openingBalanceDoc.amount;
  } else {
    openingBalance = openingBalanceDoc?.amount || 0;
  }

  const currentPage = result.page || pageNum;
  const currentLimit = result.limit || limitNum;
  const skipped = paginationEnabled ? (currentPage - 1) * currentLimit : 0;

  let skippedAmount = 0;
  if (skipped > 0) {
    const amountExpr = {
      $let: {
        vars: {
          rawAmount: {
            $cond: [
              {
                $and: [{ $ne: ['$currencyId', null] }, { $eq: ['$currencyId', account.currencyId] }],
              },
              {
                $cond: [
                  { $ne: ['$foreignAmount', null] },
                  '$foreignAmount',
                  { $cond: [{ $gt: ['$debit', 0] }, '$debit', { $ifNull: ['$credit', 0] }] },
                ],
              },
              { $cond: [{ $gt: ['$debit', 0] }, '$debit', { $ifNull: ['$credit', 0] }] },
            ],
          },
        },
        in: {
          $cond: [{ $gt: ['$debit', 0] }, '$$rawAmount', { $multiply: ['$$rawAmount', -1] }],
        },
      },
    };

    const match = {
      ...filter,
      companyId: new mongoose.Types.ObjectId(companyId),
      accountId: new mongoose.Types.ObjectId(accountId),
    };
    if (match.branchId && mongoose.Types.ObjectId.isValid(match.branchId)) {
      match.branchId = new mongoose.Types.ObjectId(match.branchId);
    }
    if (match.divisionId && mongoose.Types.ObjectId.isValid(match.divisionId)) {
      match.divisionId = new mongoose.Types.ObjectId(match.divisionId);
    }

    const skippedAgg = await LedgerEntry.aggregate([
      { $match: match },
      { $sort: sortOrder === 'desc' ? { postingDate: -1, createdAt: -1 } : { postingDate: 1, createdAt: 1 } },
      { $limit: skipped },
      { $group: { _id: null, net: { $sum: amountExpr } } },
    ]);

    skippedAmount = Math.round((skippedAgg[0]?.net || 0) * 100) / 100;
  }
  const runningSeed = startDate ? openingBalance : 0;
  const broughtForward =
    sortOrder === 'desc'
      ? Math.round((closingBalance - skippedAmount) * 100) / 100
      : Math.round((runningSeed + skippedAmount) * 100) / 100;
  let runningBalance = broughtForward;
  const { documentById, partyNameById } = await ledgerService.describeEntrySources(result.results);

  const entries = result.results.map(entry => {
    const source = documentById.get(String(entry.sourceId)) || {};
    const amount = getLedgerEntryAmount(entry, account.currencyId);
    let entryBalance;
    if (sortOrder === 'desc') {
      entryBalance = runningBalance;
      if (entry.debit > 0) {
        runningBalance = Math.round((runningBalance - amount) * 100) / 100;
      } else {
        runningBalance = Math.round((runningBalance + amount) * 100) / 100;
      }
    } else {
      if (entry.debit > 0) {
        runningBalance = Math.round((runningBalance + amount) * 100) / 100;
      } else {
        runningBalance = Math.round((runningBalance - amount) * 100) / 100;
      }
      entryBalance = runningBalance;
    }
    return {
      id: String(entry._id),
      date: entry.postingDate,
      documentNo: source.documentNo || null,
      partyName: source.partyId ? partyNameById.get(source.partyId) || null : null,
      type: SOURCE_DOCUMENTS[entry.sourceModule]?.label || entry.sourceModule,
      sourceModule: entry.sourceModule,
      sourceId: String(entry.sourceId),
      narration: entry.narration || null,
      effectType: entry.debit > 0 ? 'IN' : 'OUT',
      amount,
      availableBalance: entryBalance,
      branchId: entry.branchId || null,
      divisionId: entry.divisionId || null,
    };
  });

  const carriedOver = entries.length ? runningBalance : broughtForward;

  return {
    account: {
      openingBalance,
      closingBalance,
      totalDebit: totals.debit,
      totalCredit: totals.credit,
    },
    entries,
    page: currentPage,
    limit: paginationEnabled ? currentLimit : result.totalResults || entries.length,
    totalPages: paginationEnabled ? result.totalPages || 1 : 1,
    totalResults: result.totalResults,
    broughtForward,
    carriedOver,
  };
};

const getPrimaryBank = async (companyId, session) => {
  const { Account } = getBooksModels();
  let query = Account.findOne({
    companyId,
    category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    'bankDetails.isPrimary': true,
    isActive: true,
  });
  if (session) {
    query = query.session(session);
  }
  const account = await query.lean();
  return account ? toBankView(account) : null;
};

const getPrimaryBankDetails = async accountId => {
  const { Account } = getBooksModels();
  const account = await Account.findById(accountId).lean();
  return account ? toBankView(account) : null;
};

module.exports = {
  createNewBank,
  getBanksByCompanyId,
  updateBankById,
  deleteBankById,
  transferAmount,
  bankDropdown,
  getBankById,
  withdrawOrDeposit,
  getTransactions,
  getTransactionById,
  approveTransaction,
  rejectTransaction,
  cancelTransaction,
  getPrimaryBank,
  getPrimaryBankDetails,
  getBankStatement,
};
