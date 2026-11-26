const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels, getBooksCrmModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getExpenseAddressCondition, getCompanyAddressResolver } = require('../../../utils/addressLocationFilter');
const { MODULE_NAMES, ACCOUNT_CATEGORIES, PAYMENT_ACCOUNT_CATEGORIES, LEDGER_SOURCE_MODULES } = require('../../../utils/enum');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const mongoose = require('mongoose');
const { handleFileUpdate, deleteFilesFromS3 } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { EXPENSE_MESSAGES } = require('../../../utils/messages');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const logger = require('../../../config/logger');
const { LEDGER_PARTY_TYPES, PAYMENT_STATUS, EXPENSE_BILLABLE_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const { validateCustomerForModule, updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const { multipleDefaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const expenseTransformers = require('./expense.transformer');

// Both kinds of account must exist, be active, and be the right kind before an expense can post against them.
const validateExpenseAccounts = async ({
  companyId,
  expenseAccountId,
  expenseAccountIds = [expenseAccountId],
  paidThroughAccountId,
  session,
}) => {
  const { Account } = getBooksModels();

  const uniqueAccountIds = [...new Set(expenseAccountIds.map(String))];
  const expenseAccountCount = await Account.countDocuments({
    _id: { $in: uniqueAccountIds },
    companyId,
    isActive: true,
    category: { $in: [ACCOUNT_CATEGORIES.EXPENSE.code, ACCOUNT_CATEGORIES.COGS.code, ACCOUNT_CATEGORIES.OTHER_EXPENSE.code] },
  }).session(session);
  if (expenseAccountCount !== uniqueAccountIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Expense account not found or not an expense account');
  }

  // A vendor's billable expense was paid by the vendor, so it has no paid-through account.
  if (!paidThroughAccountId) return;

  const paidThroughAccountDoc = await Account.findOne({
    _id: paidThroughAccountId,
    companyId,
    isActive: true,
    category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
  }).session(session);
  if (!paidThroughAccountDoc) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Paid through account not found or not a money account');
  }
};

/**
 * Create an expense
 * @param {Object} expenseBody
 * @param {String} userId
 * @param {Array} uploadedFiles
 * @returns {Promise<Expense>}
 */
const createExpense = async (expenseBody, userId, uploadedFiles = []) => {
  const { Expenses, Invoice } = getBooksModels();
  const { Customer, Branch } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: expenseBody.companyId,
    });

    expenseBody.expenseId = await generateUniqueId(
      Expenses,
      expenseBody.companyId,
      MODULE_NAMES.EXPENSE,
      'expenseId',
      'EX',
      session,
      expenseBody.expenseId,
    );

    const company = await Company.findById(expenseBody.companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    if (expenseBody.lines?.length) {
      // A Ledger party has no Customer record, so party stays empty for it.
      const party = await Customer.findById(expenseBody.party || null)
        .select('Role otherDetails.gstTreatment')
        .session(session)
        .lean();
      Object.assign(expenseBody, expenseTransformers.buildExpenseFields(expenseBody, party));

      if (expenseBody.isBillable) {
        if (!expenseBody.partyType) {
          throw new ApiError(httpStatus.BAD_REQUEST, EXPENSE_MESSAGES.BILLABLE_PARTY_REQUIRED);
        }

        // We pay a customer's billable expense ourselves, so it needs the account it was paid from.
        if (expenseBody.partyType === LEDGER_PARTY_TYPES.CUSTOMER && !expenseBody.paidThroughAccountId) {
          throw new ApiError(httpStatus.BAD_REQUEST, EXPENSE_MESSAGES.PAID_THROUGH_REQUIRED);
        }

        // The balance update does nothing without a branch entry on the party.
        await multipleDefaultBranchEntry(expenseBody.party, [expenseBody.branchId], session);

        // Only a customer's billable expense raises what they owe, so only that one is checked.
        if (expenseBody.partyType === LEDGER_PARTY_TYPES.CUSTOMER) {
          await validateCustomerForModule({
            customerId: expenseBody.party,
            branchId: expenseBody.branchId,
            companyId: expenseBody.companyId,
            totalAmount: expenseBody.total,
            moduleName: MODULE_NAMES.EXPENSE,
            session,
            models: { Customer, Branch, Invoice },
            skipAddressCheck: true,
          });
        }
      }
    }

    await validateExpenseAccounts({
      companyId: expenseBody.companyId,
      ...(expenseBody.lines?.length
        ? { expenseAccountIds: expenseBody.lines.map(line => line.accountId) }
        : { expenseAccountId: expenseBody.expenseAccount }),
      paidThroughAccountId: expenseBody.paidThroughAccountId,
      session,
    });

    const { currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
      companyId: expenseBody.companyId,
      customerId: expenseBody.party || null,
    });
    const bodyTotal = Number(expenseBody.total);
    const bodyExchangeRate = Number(expenseBody.exchangeRate);
    expenseBody.total = Number.isFinite(bodyTotal) ? bodyTotal : expenseBody.total;
    expenseBody.exchangeRate = Number.isFinite(bodyExchangeRate) ? bodyExchangeRate : exchangeRate;
    const currencyDoc = await getCurrency(expenseBody.companyId, currency);

    const commentHistory = [
      {
        message: `Expense created for ${currencyDoc?.symbol || '₹'}${expenseBody.total}`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'Expense',
        referenceId: null,
      },
    ];

    const expenseData = {
      ...expenseBody,
      currency,
      exchangeRate: expenseBody.exchangeRate ?? 1,
      decimalPlaces,
      receipts: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      addedBy: userId,
      updatedBy: userId,
      commentHistory,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    const [expense] = await Expenses.create([expenseData], { session });

    await ledgerService.postExpenseJournal({ companyId: expense.companyId, expense, addedBy: userId }, session);

    // Billable raises the party's balance: the customer owes us, or we owe the vendor who paid it.
    if (expense.isBillable) {
      await updateBranchCurrentBalance({
        customerId: expense.party,
        branchId: expense.branchId,
        amount: expense.total,
        session,
      });
    }

    await session.commitTransaction();
    return enrichDocumentCurrency(expenseBody.companyId, expense.toJSON());
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
 * Get all expenses with filters and options
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<Array<Expense>>}
 */
const getAllExpenses = async (query, filter, options) => {
  const { Customer } = getBooksCrmModels();
  const { Expenses, Account, AccountLedger } = getBooksModels();
  const { Division, Branch } = getBooksCrmModels();
  const { User, Company } = getCommonModels();
  const companyId = filter.companyId;

  filter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  if (query.partyId) {
    filter.party = new mongoose.Types.ObjectId(query.partyId);
  }

  if (query.startDate && query.endDate) {
    filter.date = {
      $gte: new Date(query.startDate),
      $lte: new Date(query.endDate),
    };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      filter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      filter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) filter.addedBy = { $in: addedByIds };
  }

  if (query.date) {
    filter.date = {
      $gte: new Date(query.date),
      $lte: new Date(query.date),
    };
  }

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
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

    const vendors = await Customer.find({ companyId, customerDisplayName: searchRegex });
    const expenseAccount = await Account.find({ companyId, accountName: searchRegex });
    const paidThroughAccounts = await Account.find({
      companyId,
      accountName: searchRegex,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).select('_id');

    const vendorIds = vendors.map(vendor => vendor._id);
    const customerIds = customers.map(customer => customer._id);

    filter.$or = [
      { expenseAccount: { $in: expenseAccount } },
      { paidThroughAccountId: { $in: paidThroughAccounts.map(account => account._id) } },
      { party: { $in: customerIds } },
      { vendor: { $in: vendorIds } },
      { branchId: { $in: branchIds } },
      { divisionId: { $in: divisionIds } },
    ];
  }

  // addressType + Country/State/City filters: billTo -> vendor billing address; else addressId is one of company.address / company.additionalShippingAddresses
  const addressCondition = await getExpenseAddressCondition(Customer, Company, companyId, query);
  if (addressCondition) {
    (filter.$and ||= []).push(addressCondition);
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await Expenses.countDocuments(filter) };
  }

  // Get the paginated results
  const result = await Expenses.paginateWithTotal(filter, options);

  // Get all unique customer and vendor IDs from the results
  const partyIds = [...new Set(result.results.map(expense => expense.party))];
  const vendorIds = [...new Set(result.results.map(expense => expense.vendor))];
  const divisionIds = [...new Set(result.results.map(expense => expense.divisionId))];
  const branchIds = [...new Set(result.results.map(expense => expense.branchId))];
  const accountIds = [
    ...new Set([
      ...result.results.map(expense => expense.expenseAccount),
      ...result.results.map(expense => expense.paidThroughAccountId),
    ]),
  ];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  // Fetch all customers and vendors in one query
  const customers = await Customer.find({
    _id: { $in: [...partyIds, ...vendorIds] },
  })
    .select('customerDisplayName')
    .lean();

  // Create maps for quick lookups
  const customerMap = customers.reduce((acc, customer) => {
    acc[customer._id.toString()] = customer;
    return acc;
  }, {});

  // Same as ledger describeEntrySources: missing ids are Account Ledger parties
  const missingPartyIds = [...partyIds, ...vendorIds].filter(id => id && !customerMap[id.toString()]);
  if (missingPartyIds.length) {
    const ledgers = await AccountLedger.find({ _id: { $in: missingPartyIds } })
      .select('personName')
      .lean();
    ledgers.forEach(ledger => {
      customerMap[ledger._id.toString()] = { _id: ledger._id, customerDisplayName: ledger.personName };
    });
  }

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

  const resolveAddress = await getCompanyAddressResolver(Company, companyId);

  // Populate the results with customer and vendor data
  const populatedResults = result.results.map(expense => {
    const expenseObj = expense.toObject();
    expenseObj.addressIn = resolveAddress(expenseObj);
    expenseObj.party = customerMap[expense.party?.toString()] || null;
    expenseObj.vendor = customerMap[expense.vendor?.toString()] || null;
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

const expenseListFilter = filter => {
  const listFilter = {};
  ['companyId', 'date', 'branchId', 'divisionId', 'addedBy'].forEach(key => {
    if (filter?.[key] !== undefined) listFilter[key] = filter[key];
  });
  return listFilter;
};

const getExpensesExports = async (query, filter, options) => {
  const result = await getAllExpenses(query, expenseListFilter(filter), { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getExpenseById = async (id, companyId) => {
  const { Expenses, Account, AccountLedger } = getBooksModels();
  const { Customer, Branch, Division, Warehouse } = getBooksCrmModels();
  const { User, Company } = getCommonModels();

  const data = await Expenses.findOne({ _id: id, companyId });

  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, EXPENSE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const expenseAccount = await Account.findById(data.expenseAccount).select('accountName');
  const paidThroughAccount = data.paidThroughAccountId
    ? await Account.findById(data.paidThroughAccountId).select('accountName accountCode')
    : null;
  let party = data.party
    ? await Customer.findById(data.party).select(
        'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails Role',
      )
    : null;
  if (data.party && !party) {
    const ledger = await AccountLedger.findById(data.party).select('personName').lean();
    if (ledger) party = { id: ledger._id, customerDisplayName: ledger.personName };
  }

  // Lines store only the account id, so their names come from one lookup.
  const lineAccounts = data.lines.length
    ? await Account.find({ _id: { $in: data.lines.map(line => line.accountId) } })
        .select('accountName')
        .lean()
    : [];
  const lineAccountNameById = new Map(lineAccounts.map(account => [String(account._id), account.accountName]));
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (data.commentHistory?.length) {
    const userIds = data.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = data.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  let company = await Company.findById(companyId).lean();

  const addedBy = await User.findById(data.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(data.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findOne(data.branchId).select('name');
  const division = await Division.findOne(data.divisionId).select('name');
  const warehouse = await Warehouse.findOne(data.warehouseId).select('name');

  const expenseObj = data.toObject();
  expenseObj.commentHistory = commentHistoryWithUser;
  expenseObj.branchName = branch.name;
  expenseObj.divisionName = division.name;
  expenseObj.warehouseName = warehouse.name;

  expenseObj.addedBy = addedBy;
  expenseObj.updatedBy = updatedBy;
  expenseObj.expenseAccount = expenseAccount;
  expenseObj.paidThroughAccountId = paidThroughAccount;
  expenseObj.vendor = null;
  expenseObj.party = party;
  expenseObj.lines = expenseObj.lines.map(line => ({
    ...line,
    accountName: lineAccountNameById.get(String(line.accountId)) || null,
  }));

  expenseObj.shippingAddress = company?.address || {};

  if (data.isBillable) {
    const { PaymentMade } = getBooksModels();
    const { PaymentReceived } = getBooksCrmModels();
    const isVendorBillable = data.partyType === LEDGER_PARTY_TYPES.VENDOR;
    const PaymentModel = isVendorBillable ? PaymentMade : PaymentReceived;
    const paymentNoField = isVendorBillable ? 'paymentMadeId' : 'paymentReceivedId';
    const payments = await PaymentModel.find({ companyId, 'expenses.expenseId': data._id })
      .select(`${paymentNoField} paymentDate status expenses`)
      .sort({ paymentDate: 1 })
      .lean();
    expenseObj.payments = payments.map(payment => ({
      id: payment._id,
      paymentNo: payment[paymentNoField],
      paymentDate: payment.paymentDate,
      status: payment.status,
      amountApplied: payment.expenses
        .filter(line => String(line.expenseId) === String(data._id))
        .reduce((sum, line) => sum + line.amountApplied, 0),
    }));
  }

  return enrichDocumentCurrency(companyId, expenseObj);
};

/**
 * Update an expense by ID
 * @param {String} expenseId
 * @param {Object} updateBody
 * @param {String} userId
 * @param {Array} uploadedFiles
 * @returns {Promise<Expense>}
 */
const updateExpense = async (expenseId, updateBody, userId, uploadedFiles = []) => {
  const { Expenses, Account, Invoice, PaymentMade } = getBooksModels();
  const { Customer, Branch, PaymentReceived } = getBooksCrmModels();
  const connection = await getClientConnection();
  const { Company } = getCommonModels();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const expense = await Expenses.findById(expenseId).session(session);
    if (!expense) {
      throw new ApiError(httpStatus.NOT_FOUND, EXPENSE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    // A settled or pending amount depends on this expense, so it can't be edited.
    if (expense.isBillable) {
      const PaymentModel = expense.partyType === LEDGER_PARTY_TYPES.VENDOR ? PaymentMade : PaymentReceived;
      const pendingPayment = await PaymentModel.exists({
        companyId: expense.companyId,
        status: PAYMENT_STATUS.PENDING,
        'expenses.expenseId': expense._id,
      }).session(session);
      if (expense.paidAmount > 0 || pendingPayment) {
        throw new ApiError(httpStatus.BAD_REQUEST, EXPENSE_MESSAGES.SETTLED_LOCKED);
      }
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: updateBody.receipts ? updateBody.receipts : [],
      existingUrls: expense.receipts ? expense.receipts : [],
      userId,
      companyId: expense.companyId,
    });

    const company = await Company.findById(expense.companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    const oldIsBillable = expense.isBillable;
    const oldPartyId = expense.party;
    const oldBranchId = expense.branchId;
    const oldTotal = expense.total;
    const oldPaidThroughAccountId = expense.paidThroughAccountId;
    const oldExpenseAccountId = expense.expenseAccount;
    const oldDate = expense.date;
    const oldCurrency = expense.currency;
    const oldExchangeRate = expense.exchangeRate;

    // The document currency is a stored fact and must stay immutable on edit. Only re-resolve it
    // when the party actually changes — re-deriving it on every edit would silently adopt a party
    // whose master currency changed after the expense was created, pairing it with a stale rate.
    const partyChanged = updateBody.party !== undefined && String(updateBody.party || '') !== String(expense.party || '');
    let resolvedRate;
    if (partyChanged) {
      const resolved = await resolveTransactionCurrency({
        companyId: expense.companyId,
        customerId: updateBody.party || null,
      });
      updateBody.currency = resolved.currency;
      updateBody.decimalPlaces = resolved.decimalPlaces;
      resolvedRate = resolved.exchangeRate;
    }
    const bodyTotal = Number(updateBody.total);
    const bodyExchangeRate = Number(updateBody.exchangeRate);
    if (Number.isFinite(bodyTotal)) updateBody.total = bodyTotal;
    // A body-supplied rate wins; otherwise take the new currency's rate on a party change, else keep the stored rate.
    updateBody.exchangeRate = Number.isFinite(bodyExchangeRate)
      ? bodyExchangeRate
      : partyChanged
        ? (resolvedRate ?? 1)
        : (oldExchangeRate ?? 1);

    const currencyDoc = await getCurrency(expense.companyId, updateBody.currency || expense.currency);

    if (updateBody.expenseAccount) {
      const expenseAccountDoc = await Account.findOne({
        _id: updateBody.expenseAccount,
        companyId: expense.companyId,
        isActive: true,
        category: { $in: [ACCOUNT_CATEGORIES.EXPENSE.code, ACCOUNT_CATEGORIES.COGS.code, ACCOUNT_CATEGORIES.OTHER_EXPENSE.code] },
      }).session(session);
      if (!expenseAccountDoc) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Expense account not found or not an expense account');
      }
    }
    if (updateBody.paidThroughAccountId) {
      const paidThroughAccountDoc = await Account.findOne({
        _id: updateBody.paidThroughAccountId,
        companyId: expense.companyId,
        isActive: true,
        category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      }).session(session);
      if (!paidThroughAccountDoc) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Paid through account not found or not a money account');
      }
    }

    if (updateBody.lines?.length) {
      // A Ledger party has no Customer record, so party stays empty for it.
      const party = await Customer.findById(updateBody.party || null)
        .select('Role otherDetails.gstTreatment')
        .session(session)
        .lean();
      Object.assign(updateBody, expenseTransformers.buildExpenseFields(updateBody, party));

      await validateExpenseAccounts({
        companyId: expense.companyId,
        expenseAccountIds: updateBody.lines.map(line => line.accountId),
        paidThroughAccountId: updateBody.paidThroughAccountId,
        session,
      });

      if (updateBody.isBillable) {
        if (!updateBody.partyType) {
          throw new ApiError(httpStatus.BAD_REQUEST, EXPENSE_MESSAGES.BILLABLE_PARTY_REQUIRED);
        }

        // We pay a customer's billable expense ourselves, so it needs the account it was paid from.
        if (updateBody.partyType === LEDGER_PARTY_TYPES.CUSTOMER && !updateBody.paidThroughAccountId) {
          throw new ApiError(httpStatus.BAD_REQUEST, EXPENSE_MESSAGES.PAID_THROUGH_REQUIRED);
        }

        // The balance update does nothing without a branch entry on the party.
        await multipleDefaultBranchEntry(updateBody.party, [updateBody.branchId], session);

        // Same party and branch: only the increase counts against the credit limit.
        if (updateBody.partyType === LEDGER_PARTY_TYPES.CUSTOMER) {
          const isSameBillableParty =
            oldIsBillable &&
            String(oldPartyId) === String(updateBody.party) &&
            String(oldBranchId) === String(updateBody.branchId);
          await validateCustomerForModule({
            customerId: updateBody.party,
            branchId: updateBody.branchId,
            companyId: expense.companyId,
            totalAmount: updateBody.total,
            previousTotal: isSameBillableParty ? oldTotal : 0,
            moduleName: MODULE_NAMES.EXPENSE,
            session,
            models: { Customer, Branch, Invoice },
            skipAddressCheck: true,
          });
        }
      }
    }

    Object.assign(expense, {
      ...updateBody,
      receipts: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    expense.updatedBy = userId;
    let updateMsg = 'Expense updated.';

    if (updateBody.total !== undefined && updateBody.total !== oldTotal) {
      updateMsg = `Expense updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldTotal} to ${currencyDoc?.symbol || '₹'}${updateBody.total}`;
    }
    expense.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });

    await expense.save({ session });

    // Money effect changed: put the old amount back, reverse the old journal, apply the new one.
    const moneyEffectChanged =
      expense.lines.length > 0 ||
      partyChanged ||
      expense.total !== oldTotal ||
      String(expense.paidThroughAccountId) !== String(oldPaidThroughAccountId) ||
      String(expense.expenseAccount) !== String(oldExpenseAccountId) ||
      String(expense.currency) !== String(oldCurrency) ||
      Number(expense.exchangeRate) !== Number(oldExchangeRate) ||
      new Date(expense.date).getTime() !== new Date(oldDate).getTime();

    if (moneyEffectChanged) {
      await ledgerService.deleteJournal(
        { companyId: expense.companyId, sourceModule: LEDGER_SOURCE_MODULES.EXPENSE, sourceId: expense._id },
        session,
      );

      await ledgerService.postExpenseJournal({ companyId: expense.companyId, expense, addedBy: userId }, session);
    }

    // Take the old charge off its party, then put the new charge on, because the party may have changed.
    if (oldIsBillable) {
      await updateBranchCurrentBalance({
        customerId: oldPartyId,
        branchId: oldBranchId,
        amount: -oldTotal,
        session,
      });
    }
    if (expense.isBillable) {
      await updateBranchCurrentBalance({
        customerId: expense.party,
        branchId: expense.branchId,
        amount: expense.total,
        session,
      });
    }

    await session.commitTransaction();
    return enrichDocumentCurrency(expense.companyId, expense.toJSON());
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
 * Delete an expense by ID
 * @param {String} expenseId
 * @returns {Promise<Expense>}
 */
const deleteExpense = async (expenseId, companyId) => {
  const { Expenses, RecurringExpense, RecurringExpenseHistory, PaymentMade } = getBooksModels();
  const { PaymentReceived } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const expense = await Expenses.findOne({ _id: expenseId, companyId }).session(session);
    if (!expense) {
      throw new ApiError(httpStatus.NOT_FOUND, EXPENSE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (expense.isBillable) {
      // Like an invoice or bill, any payment that refers to it (whatever its status) keeps it from being deleted.
      const isVendorBillable = expense.partyType === LEDGER_PARTY_TYPES.VENDOR;
      const PaymentModel = isVendorBillable ? PaymentMade : PaymentReceived;
      const paymentNoField = isVendorBillable ? 'paymentMadeId' : 'paymentReceivedId';
      const linkedPayments = await PaymentModel.find({ companyId: expense.companyId, 'expenses.expenseId': expense._id })
        .select(paymentNoField)
        .session(session)
        .lean();
      if (linkedPayments.length > 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot delete Expense because a ${isVendorBillable ? 'Payment Made' : 'Payment Received'} has been created.`,
        );
      }

      // Take the charge back off the party's balance.
      await updateBranchCurrentBalance({
        customerId: expense.party,
        branchId: expense.branchId,
        amount: -expense.total,
        session,
      });
    }

    await RecurringExpense.updateMany(
      { companyId: expense.companyId, 'commentHistory.referenceId': expense._id },
      { $set: { 'commentHistory.$[target].isDeleted': true } },
      { arrayFilters: [{ 'target.referenceId': expense._id }], session },
    );

    // Money returns to the paid-through account and the expense journal is reversed.
    await ledgerService.deleteJournal(
      { companyId: expense.companyId, sourceModule: LEDGER_SOURCE_MODULES.EXPENSE, sourceId: expense._id },
      session,
    );

    await Expenses.deleteOne({ _id: expenseId, companyId }, { session });

    // Keep the generated expense id/number on the execution log for the audit
    // trail and flag it as deleted, instead of unsetting the reference (which
    // would hide the number and make "deleted" indistinguishable from "never
    // generated").
    await RecurringExpenseHistory.updateMany(
      { companyId, generatedExpenseId: expenseId },
      { $set: { isGeneratedDeleted: true, generatedDeletedAt: new Date() } },
      { session },
    );

    await session.commitTransaction();

    if (expense.receipts?.length) {
      try {
        await deleteFilesFromS3(expense.receipts);
      } catch (error) {
        logger.error(`Failed to delete receipts for expense ${expense._id}`, error);
      }
    }

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

// Settle (+amount) or reverse (-amount) a billable expense against a payment.
const updateExpensePaymentStatus = async (expenseId, amount, session) => {
  const { Expenses } = getBooksModels();
  const expense = await Expenses.findById(expenseId).select('expenseId total paidAmount').session(session);

  const paidAmount = parseFloat((expense.paidAmount + amount).toFixed(2));
  const balanceAmount = parseFloat((expense.total - paidAmount).toFixed(2));
  if (balanceAmount < 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, `You cannot apply more than the due amount for expense ${expense.expenseId}`);
  }

  let billableStatus = EXPENSE_BILLABLE_STATUS.UNPAID;
  if (balanceAmount === 0) {
    billableStatus = EXPENSE_BILLABLE_STATUS.PAID;
  } else if (paidAmount > 0) {
    billableStatus = EXPENSE_BILLABLE_STATUS.PARTIALLY_PAID;
  }

  await Expenses.updateOne({ _id: expenseId }, { $set: { paidAmount, balanceAmount, billableStatus } }, { session });
};

module.exports = {
  validateExpenseAccounts,
  updateExpensePaymentStatus,
  createExpense: withTransientRetry(createExpense),
  getAllExpenses,
  getExpensesExports,
  updateExpense,
  deleteExpense,
  getExpenseById,
};
