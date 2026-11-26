const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { LEDGER_SOURCE_MODULES } = require('@smit9313/abss-models-core/src/utils/enum');
const { ACCOUNT_CATEGORIES } = require('../../../utils/enum');
const { getBooksModels, getBooksCrmModels, getClientConnection } = require('../../../services/model.service');
const { ACCOUNT_MESSAGES } = require('../../../utils/messages');
const ledgerService = require('../ledger/ledger.service');
const { resolveTransactionCurrency } = require('../../../services/currencyResolver.service');

const runInTransaction = async work => {
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database connection not available');
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getCategories = async () =>
  Object.values(ACCOUNT_CATEGORIES).map(
    ({ code, displayName, accountType, allowSubAccount, managedIn, openingBalanceIn, allowPaymentAccount, bankType }) => ({
      code,
      displayName,
      accountType,
      allowSubAccount,
      managedIn,
      openingBalanceIn,
      allowPaymentAccount,
      bankAccountType: bankType,
    }),
  );

// Save (create or replace) an account's opening balance and its ledger journal.
// The previous journal is deleted first, so an edit leaves exactly one current journal.
const saveAccountOpeningBalance = async ({ companyId, accountId, amount, balanceType, openingBalanceDate }, userId, session) => {
  const { AccountOpeningBalance } = getBooksModels();
  const filter = { companyId, accountId };

  const existing = await AccountOpeningBalance.findOne(filter).session(session);
  if (existing) {
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE, sourceId: existing._id },
      session,
    );
  }

  const openingBalance = await AccountOpeningBalance.findOneAndUpdate(
    filter,
    {
      $set: { amount, balanceType, openingBalanceDate, updatedBy: userId },
      $setOnInsert: { companyId, accountId, addedBy: userId },
    },
    { session, upsert: true, new: true },
  );

  const { Account } = getBooksModels();
  const account = await Account.findById(accountId).select('currencyId').session(session).lean();
  const currency = await resolveTransactionCurrency({ companyId, currencyId: account?.currencyId });

  await ledgerService.postOpeningBalanceJournal(
    {
      companyId,
      accountId,
      amount: openingBalance.amount,
      balanceType: openingBalance.balanceType,
      postingDate: openingBalance.openingBalanceDate,
      sourceId: openingBalance._id,
      sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE,
      narration: 'Opening balance',
      addedBy: userId,
      currencyId: currency.currency,
      exchangeRate: currency.exchangeRate,
    },
    session,
  );

  return openingBalance;
};

// Remove an account's opening balance: delete its journal and the record.
const removeAccountOpeningBalance = async (companyId, accountId, session) => {
  const { AccountOpeningBalance } = getBooksModels();
  const filter = { companyId, accountId };

  const existing = await AccountOpeningBalance.findOne(filter).session(session);
  if (!existing) return;

  await ledgerService.deleteJournal(
    { companyId, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE, sourceId: existing._id },
    session,
  );
  await AccountOpeningBalance.deleteOne(filter, { session });
};

const buildAccountQuery = ({ companyId, isActive, includeInactive, category, isSystemAccount, excludeAccountId }) => {
  const conditions = { companyId: new mongoose.Types.ObjectId(companyId) };

  if (isActive !== undefined && isActive !== null) {
    conditions.isActive = isActive;
  } else if (!includeInactive) {
    conditions.isActive = true;
  }

  if (category) {
    conditions.category = { $in: category.split(',').filter(Boolean) };
  }

  // Leaving the account out also drops its sub-accounts from the tree, so it can't become its own parent.
  if (excludeAccountId) {
    conditions._id = { $ne: new mongoose.Types.ObjectId(excludeAccountId) };
  }

  if (isSystemAccount !== undefined && isSystemAccount !== null) {
    conditions.isSystemAccount = isSystemAccount;
  }

  return conditions;
};

const includeSearchParents = (accountDocs, search) => {
  if (!search?.trim()) return accountDocs;

  const searchText = search.trim().toLowerCase();
  const accountByIdForSearch = new Map(accountDocs.map(doc => [String(doc._id), doc]));
  const matchedAccountIds = new Set(
    accountDocs
      .filter(doc => {
        const accountName = doc.accountName?.toLowerCase() || '';
        const accountCode = doc.accountCode?.toLowerCase() || '';
        return accountName.includes(searchText) || accountCode.includes(searchText);
      })
      .map(doc => String(doc._id)),
  );

  const requiredAccountIds = new Set(matchedAccountIds);
  for (const accountId of matchedAccountIds) {
    let currentAccount = accountByIdForSearch.get(accountId);
    while (currentAccount?.parentAccountId) {
      const parentId = String(currentAccount.parentAccountId);
      if (requiredAccountIds.has(parentId)) {
        break;
      }
      requiredAccountIds.add(parentId);
      currentAccount = accountByIdForSearch.get(parentId);
    }
  }

  return accountDocs.filter(doc => requiredAccountIds.has(String(doc._id)));
};

const getParentNameById = async (Account, accountDocs) => {
  const parentIds = [
    ...new Set(
      accountDocs
        .map(doc => doc.parentAccountId)
        .filter(Boolean)
        .map(id => String(id)),
    ),
  ];

  const parents = parentIds.length
    ? await Account.find({
        _id: {
          $in: parentIds.map(id => new mongoose.Types.ObjectId(id)),
        },
      })
        .select('accountName')
        .lean()
    : [];

  return new Map(parents.map(parent => [String(parent._id), parent.accountName]));
};

const toAccountNode = (doc, parentNameById) => {
  const meta = ACCOUNT_CATEGORIES[doc.category] || {};

  return {
    id: String(doc._id),
    accountCode: doc.accountCode ?? null,
    accountName: doc.accountName,
    parentAccountId: doc.parentAccountId ? String(doc.parentAccountId) : null,
    parentAccountName: doc.parentAccountId ? parentNameById.get(String(doc.parentAccountId)) || null : null,
    isSystemAccount: doc.isSystemAccount,
    isActive: doc.isActive,
    systemAccountKey: doc.systemAccountKey ?? null,
    bankDetails: doc.bankDetails || null,
    managedIn: meta.managedIn ?? 'COA',
    children: [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

const nestAccountsByCategory = accountItems => {
  const rootsByCategory = {};
  const childrenByParent = {};
  const accountById = new Map();

  for (const { category, account } of accountItems) {
    accountById.set(account.id, account);
    if (account.parentAccountId) {
      if (!childrenByParent[account.parentAccountId]) {
        childrenByParent[account.parentAccountId] = [];
      }
      childrenByParent[account.parentAccountId].push(account);
    } else {
      if (!rootsByCategory[category]) {
        rootsByCategory[category] = [];
      }
      rootsByCategory[category].push(account);
    }
  }

  for (const [accountId, account] of accountById) {
    account.children = childrenByParent[accountId] || [];
  }

  return Object.values(ACCOUNT_CATEGORIES)
    .map(category => ({
      category: category.code,
      displayName: category.displayName,
      accountType: category.accountType,
      accounts: rootsByCategory[category.code] || [],
    }))
    .filter(group => group.accounts.length > 0);
};

const getAccounts = async filter => {
  const { Account, AccountOpeningBalance } = getBooksModels();
  const { isSplit = false, search, endDate: requestedEndDate } = filter;
  const conditions = buildAccountQuery(filter);
  const companyId = conditions.companyId;
  const balanceEndDate = requestedEndDate ? new Date(requestedEndDate) : null;

  const [accountDocs, balanceByAccountId, openingBalances] = await Promise.all([
    Account.find(conditions).sort({ accountName: 1 }).lean(),

    // Closing Balance on the chart-of-accounts list is the balance as of the end date (cumulative);
    // a start date must not scope it, or accounts show only their period movement.
    ledgerService.getAccountBalances({
      companyId,
      includeSplit: isSplit,
      upToDate: balanceEndDate,
    }),

    AccountOpeningBalance.find({ companyId }).select('accountId amount balanceType openingBalanceDate').lean(),
  ]);

  const filteredAccountDocs = includeSearchParents(accountDocs, search);
  const parentNameById = await getParentNameById(Account, filteredAccountDocs);
  const openingBalanceByAccountId = new Map(openingBalances.map(ob => [String(ob.accountId), ob]));

  return nestAccountsByCategory(
    filteredAccountDocs.map(doc => {
      const totals = balanceByAccountId.get(String(doc._id)) || {
        debit: 0,
        credit: 0,
      };
      const ledgerBalance = Math.round((totals.debit - totals.credit) * 100) / 100;
      const meta = ACCOUNT_CATEGORIES[doc.category] || {};
      const openingBalance = openingBalanceByAccountId.get(String(doc._id));
      const account = toAccountNode(doc, parentNameById);

      account.currentBalance = Math.abs(ledgerBalance);
      account.isDebit = ledgerBalance >= 0;
      account.openingBalanceIn = meta.openingBalanceIn ?? 'NONE';
      account.openingBalance = openingBalance
        ? {
            amount: openingBalance.amount,
            balanceType: openingBalance.balanceType,
            openingBalanceDate: openingBalance.openingBalanceDate,
          }
        : null;

      return { category: doc.category, account };
    }),
  );
};

const getAccountsDropdown = async filter => {
  const { Account } = getBooksModels();
  const accountDocs = await Account.find(buildAccountQuery(filter)).sort({ accountName: 1 }).lean();
  const parentNameById = await getParentNameById(Account, accountDocs);

  // Keep the original nested `accounts` tree so existing clients that flatten on their
  // side (e.g. the mobile app) keep working, and additionally expose ready-to-use flat
  // `options` (with a depth for indentation) for clients that render them directly.
  const nestedGroups = nestAccountsByCategory(
    accountDocs.map(doc => ({ category: doc.category, account: toAccountNode(doc, parentNameById) })),
  );

  // Each sub-account follows its parent; `depth` drives the indent on flat renderers.
  const toOptions = (accounts, depth) =>
    accounts.flatMap(account => {
      const label = account.accountCode ? `${account.accountName} (${account.accountCode})` : account.accountName;
      return [
        {
          label,
          title: label,
          value: account.id,
          accountName: account.accountName,
          systemAccountKey: account.systemAccountKey,
          depth,
        },
        ...toOptions(account.children, depth + 1),
      ];
    });

  return nestedGroups.map(group => ({
    category: group.category,
    displayName: group.displayName,
    accountType: group.accountType,
    label: group.displayName,
    title: group.displayName,
    accounts: group.accounts,
    options: toOptions(group.accounts, 0),
  }));
};

const getAccountsByCompany = async (companyIdInput, filters = {}) => {
  const { Account } = getBooksModels();
  const companyId = new mongoose.Types.ObjectId(companyIdInput);
  const query = { companyId, isActive: true };

  if (filters.category) query.category = filters.category;
  if (filters.parentAccountId) query.parentAccountId = filters.parentAccountId;
  if (filters.isSystemAccount !== undefined) {
    query.isSystemAccount = filters.isSystemAccount === true || filters.isSystemAccount === 'true';
  }

  const accountDocs = await Account.find(query).sort({ category: 1, accountName: 1 }).lean();
  const parentIds = [...new Set(accountDocs.map(doc => doc.parentAccountId).filter(Boolean))];
  const parents = parentIds.length
    ? await Account.find({ _id: { $in: parentIds } })
        .select('accountName')
        .lean()
    : [];
  const parentNameById = new Map(parents.map(parent => [String(parent._id), parent.accountName]));

  return accountDocs.map(doc => {
    const meta = ACCOUNT_CATEGORIES[doc.category] || {};
    return {
      id: String(doc._id),
      companyId: String(doc.companyId),
      accountCode: doc.accountCode ?? null,
      accountName: doc.accountName,
      category: doc.category,
      parentAccountId: doc.parentAccountId ? String(doc.parentAccountId) : null,
      parentAccountName: doc.parentAccountId ? parentNameById.get(String(doc.parentAccountId)) || null : null,
      isSystemAccount: doc.isSystemAccount,
      isActive: doc.isActive,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      categoryDisplayName: meta.displayName || doc.category,
      accountType: meta.accountType || null,
    };
  });
};

const getAccountById = async (accountId, companyId, activeOnly = true) => {
  const { Account, AccountOpeningBalance } = getBooksModels();
  const query = { _id: accountId, companyId };
  if (activeOnly) query.isActive = true;

  const doc = await Account.findOne(query).lean();
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, ACCOUNT_MESSAGES.FETCH_ONE_FAILURE);

  let parentAccountName = null;
  if (doc.parentAccountId) {
    const parent = await Account.findById(doc.parentAccountId).select('accountName').lean();
    parentAccountName = parent?.accountName || null;
  }

  const openingBalance = await AccountOpeningBalance.findOne({ companyId, accountId: doc._id }).lean();
  const meta = ACCOUNT_CATEGORIES[doc.category] || {};

  return {
    id: String(doc._id),
    companyId: String(doc.companyId),
    accountCode: doc.accountCode ?? null,
    accountName: doc.accountName,
    category: doc.category,
    parentAccountId: doc.parentAccountId ? String(doc.parentAccountId) : null,
    parentAccountName,
    isSystemAccount: doc.isSystemAccount,
    isActive: doc.isActive,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    categoryDisplayName: meta.displayName || doc.category,
    accountType: meta.accountType || null,
    openingBalanceIn: meta.openingBalanceIn ?? 'NONE',
    openingBalance: openingBalance
      ? {
          amount: openingBalance.amount,
          balanceType: openingBalance.balanceType,
          openingBalanceDate: openingBalance.openingBalanceDate,
        }
      : null,
  };
};

const createAccount = async (accountBody, userId) => {
  const { Account } = getBooksModels();

  if (!accountBody.companyId) throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.COMPANY_ID_REQUIRED);
  const categoryMeta = ACCOUNT_CATEGORIES[accountBody.category];
  if (!categoryMeta) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${ACCOUNT_MESSAGES.INVALID_CATEGORY}: ${accountBody.category}`);
  }
  if (accountBody.parentAccountId && !categoryMeta.allowSubAccount) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${ACCOUNT_MESSAGES.SUB_ACCOUNT_NOT_ALLOWED} (${categoryMeta.displayName})`);
  }
  if (accountBody.openingBalance && categoryMeta.openingBalanceIn !== 'COA') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `${ACCOUNT_MESSAGES.OPENING_BALANCE_NOT_APPLICABLE} (${categoryMeta.displayName})`,
    );
  }

  if (accountBody.parentAccountId) {
    const parent = await Account.findOne({
      _id: accountBody.parentAccountId,
      companyId: accountBody.companyId,
      isActive: true,
    }).lean();

    if (!parent) throw new ApiError(httpStatus.NOT_FOUND, ACCOUNT_MESSAGES.PARENT_NOT_FOUND);

    if (parent.category !== accountBody.category) {
      throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.PARENT_SAME_CATEGORY);
    }
  }

  const duplicate = await Account.findOne({
    companyId: accountBody.companyId,
    category: accountBody.category,
    accountName: accountBody.accountName,
    isActive: true,
  }).lean();

  if (duplicate) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${ACCOUNT_MESSAGES.DUPLICATE_ACCOUNT_NAME} (${accountBody.category})`);
  }

  const accountId = await runInTransaction(async session => {
    const [account] = await Account.create(
      [
        {
          accountName: accountBody.accountName,
          accountCode: accountBody.accountCode?.trim() || null,
          category: accountBody.category,
          parentAccountId: accountBody.parentAccountId || null,
          companyId: accountBody.companyId,
          isSystemAccount: false,
          isActive: true,
          addedBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );

    if (accountBody.openingBalance) {
      await saveAccountOpeningBalance(
        {
          companyId: accountBody.companyId,
          accountId: account._id,
          amount: accountBody.openingBalance.amount,
          balanceType: accountBody.openingBalance.balanceType,
          openingBalanceDate: accountBody.openingBalance.openingBalanceDate,
        },
        userId,
        session,
      );
    }

    return account._id;
  });

  return getAccountById(accountId, accountBody.companyId);
};

const updateAccount = async (accountId, companyId, updateBody, userId) => {
  const { Account, AccountOpeningBalance } = getBooksModels();
  const account = await Account.findOne({ _id: accountId, companyId });
  if (!account) throw new ApiError(httpStatus.NOT_FOUND, ACCOUNT_MESSAGES.FETCH_ONE_FAILURE);

  const targetCategory = updateBody.category !== undefined ? updateBody.category : account.category;
  const targetName = updateBody.accountName !== undefined ? updateBody.accountName : account.accountName;

  if (updateBody.category !== undefined && updateBody.category !== account.category) {
    const newCategoryMeta = ACCOUNT_CATEGORIES[updateBody.category];
    if (!newCategoryMeta) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${ACCOUNT_MESSAGES.INVALID_CATEGORY}: ${updateBody.category}`);
    }

    const childCount = await Account.countDocuments({ parentAccountId: accountId, isActive: true });
    if (childCount > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.HAS_CHILDREN_CATEGORY);
    }
  }

  if (updateBody.openingBalance !== undefined) {
    const categoryMeta = ACCOUNT_CATEGORIES[targetCategory];
    if (updateBody.openingBalance && categoryMeta.openingBalanceIn !== 'COA') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${ACCOUNT_MESSAGES.OPENING_BALANCE_NOT_APPLICABLE} (${categoryMeta.displayName})`,
      );
    }
  }

  // New category must not keep an opening balance it does not support.
  if (
    updateBody.category !== undefined &&
    updateBody.category !== account.category &&
    ACCOUNT_CATEGORIES[targetCategory].openingBalanceIn !== 'COA' &&
    updateBody.openingBalance !== null
  ) {
    const existingOpeningBalance = await AccountOpeningBalance.findOne({ companyId, accountId }).lean();
    if (existingOpeningBalance) {
      throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.REMOVE_OPENING_BALANCE_FIRST);
    }
  }

  if (updateBody.isActive !== undefined) {
    if (updateBody.isActive === false) {
      const childCount = await Account.countDocuments({ parentAccountId: accountId, isActive: true });
      if (childCount > 0) throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.HAS_CHILDREN_DEACTIVATE);
    }
  }

  if (updateBody.parentAccountId !== undefined || updateBody.category !== undefined) {
    const nextParentId = updateBody.parentAccountId !== undefined ? updateBody.parentAccountId : account.parentAccountId;

    if (nextParentId) {
      if (String(nextParentId) === String(accountId)) {
        throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.OWN_PARENT_FORBIDDEN);
      }
      if (!ACCOUNT_CATEGORIES[targetCategory]?.allowSubAccount) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `${ACCOUNT_MESSAGES.SUB_ACCOUNT_NOT_ALLOWED} (${ACCOUNT_CATEGORIES[targetCategory].displayName})`,
        );
      }

      const childCount = await Account.countDocuments({ parentAccountId: accountId, isActive: true });
      if (childCount > 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.HAS_CHILDREN_SUB_ACCOUNT);
      }

      const parent = await Account.findOne({ _id: nextParentId, companyId, isActive: true }).lean();
      if (!parent) throw new ApiError(httpStatus.NOT_FOUND, ACCOUNT_MESSAGES.PARENT_NOT_FOUND);
      if (parent.isSystemAccount) throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.SYSTEM_PARENT_FORBIDDEN);
      if (parent.category !== targetCategory) {
        throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.PARENT_SAME_CATEGORY);
      }
    }
  }

  if (targetName !== account.accountName || targetCategory !== account.category) {
    const duplicate = await Account.findOne({
      _id: { $ne: accountId },
      companyId: account.companyId,
      category: targetCategory,
      accountName: targetName,
      isActive: true,
    }).lean();

    if (duplicate) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${ACCOUNT_MESSAGES.DUPLICATE_ACCOUNT_NAME} (${targetCategory})`);
    }
  }

  if (updateBody.accountName !== undefined) account.accountName = updateBody.accountName;
  if (updateBody.accountCode !== undefined) account.accountCode = updateBody.accountCode?.trim() || null;
  if (updateBody.category !== undefined) account.category = updateBody.category;
  if (updateBody.isActive !== undefined) account.isActive = updateBody.isActive;
  if (updateBody.parentAccountId !== undefined || updateBody.category !== undefined) {
    const nextParentId = updateBody.parentAccountId !== undefined ? updateBody.parentAccountId : account.parentAccountId;
    account.parentAccountId = nextParentId || null;
  }

  await runInTransaction(async session => {
    account.updatedBy = userId;
    await account.save({ session });

    if (updateBody.openingBalance !== undefined) {
      if (!updateBody.openingBalance) {
        await removeAccountOpeningBalance(account.companyId, account._id, session);
      } else {
        await saveAccountOpeningBalance(
          {
            companyId: account.companyId,
            accountId: account._id,
            amount: updateBody.openingBalance.amount,
            balanceType: updateBody.openingBalance.balanceType,
            openingBalanceDate: updateBody.openingBalance.openingBalanceDate,
          },
          userId,
          session,
        );
      }
    }
  });

  return getAccountById(accountId, companyId, false);
};

const deleteAccount = async (accountId, companyId, userId) => {
  const { Account, ManualJournal, LedgerEntry, Expenses } = getBooksModels();
  const { Item, Customer } = getBooksCrmModels();
  const account = await Account.findOne({ _id: accountId, companyId });
  if (!account) throw new ApiError(httpStatus.NOT_FOUND, ACCOUNT_MESSAGES.FETCH_ONE_FAILURE);
  if (account.isSystemAccount) throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.SYSTEM_DELETE_FORBIDDEN);
  if (ACCOUNT_CATEGORIES[account.category]?.managedIn === 'BANKING') {
    throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.BANK_DELETED_FROM_BANKING);
  }

  const [postedEntry, journalEntry, expenseUsing, itemsUsing, contactsUsing] = await Promise.all([
    LedgerEntry.exists({ companyId, accountId }),
    // Journals raised before ledger posting existed have no entries yet, so they are checked too.
    ManualJournal.exists({ companyId, 'journalEntries.accountId': accountId }),
    // A billable expense line posts no entry to its account, so the line itself is checked.
    Expenses.exists({ companyId, 'lines.accountId': accountId }),
    Item.countDocuments({
      companyId,
      $or: [
        { 'salesInformation.salesAccountId': accountId },
        { 'purchaseInformation.purchaseAccountId': accountId },
        { inventoryAccountId: accountId },
      ],
    }),
    Customer.countDocuments({ companyId, accountId }),
  ]);

  if (postedEntry || journalEntry || expenseUsing) {
    throw new ApiError(httpStatus.BAD_REQUEST, ACCOUNT_MESSAGES.HAS_TRANSACTIONS_DELETE);
  }
  if (itemsUsing > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${ACCOUNT_MESSAGES.USED_BY_ITEMS_DELETE} (${itemsUsing})`);
  }
  if (contactsUsing > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${ACCOUNT_MESSAGES.USED_BY_CONTACTS_DELETE} (${contactsUsing})`);
  }

  await runInTransaction(async session => {
    await Account.updateMany(
      { parentAccountId: accountId, isActive: true },
      {
        $set: { parentAccountId: account.parentAccountId || null, updatedBy: userId },
      },
      { session },
    );

    account.isActive = false;
    account.updatedBy = userId;
    await account.save({ session });

    await removeAccountOpeningBalance(account.companyId, account._id, session);
  });

  return getAccountById(accountId, companyId, false);
};

module.exports = {
  getCategories,
  saveAccountOpeningBalance,
  removeAccountOpeningBalance,
  createAccount,
  getAccounts,
  getAccountsDropdown,
  getAccountsByCompany,
  getAccountById,
  updateAccount,
  deleteAccount,
};
