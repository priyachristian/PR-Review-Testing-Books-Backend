const mongoose = require('mongoose');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const httpStatus = require('http-status');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { getBillingLocationCondition } = require('../../../utils/addressLocationFilter');
const { createSearchRegex } = require('../../../utils/regexUtils');
const ApiError = require('../../../utils/ApiError');
const {
  MODULE_NAMES,
  PAYMENT_STATUS,
  PAYMENT_MODES,
  CHEQUE_STATUS,
  TRANSACTION_TYPE,
  BILL_STATUSES,
  OB_PAYMENT_ENTRY_SOURCE,
  CONTACT_TYPE,
  LEDGER_SOURCE_MODULES,
  PAYMENT_ACCOUNT_CATEGORIES,
  LEDGER_PARTY_TYPES,
} = require('../../../utils/enum');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { updateBillPaymentStatus, cancelBillPayment } = require('../bill/bill.service');
const { updateExpensePaymentStatus } = require('../expense/expense.service');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { PAYMENT_MADE_MESSAGES } = require('../../../utils/messages');
const { defaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const {
  allocatePaymentBranchBalances,
  moveAdvanceApplyBranchBalances,
  collectPaymentApplications,
} = require('../../../utils/paymentBranchBalance');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { getCompanyProfile } = require('../../../services/onboard.service');
const { getCurrency, enrichDocumentCurrency, resolveTransactionCurrency } = require('../../../services/currencyResolver.service');
const { coerceBoolean } = require('../../../utils/helper');

const createPaymentMade = async (paymentMadeBody, userId, uploadedFiles = []) => {
  const { PaymentMade, Bill, Expenses } = getBooksModels();
  const { Customer, OpeningBalanceTransaction } = getBooksCrmModels();
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
      companyId: paymentMadeBody.companyId,
    });

    const { branchId, vendorId, companyId } = paymentMadeBody;
    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(vendorId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(vendorId, branchId, session);
    }
    // await generateUniqueId(PaymentMade, paymentMadeBody.companyId, MODULE_NAMES.PAYMENT_MADE, 'paymentMadeId', 'PMTM', session);
    let ids = '';
    const currencySources = [];
    if (paymentMadeBody?.isSplit) {
      ids = await generateMultipleUniqueIdsForModules(
        PaymentMade,
        paymentMadeBody.companyId,
        [
          {
            moduleName: MODULE_NAMES.SPLIT_PAYMENT_MADE,
            idField: 'paymentMadeId',
            defaultPrefix: 'SPM',
            count: 1,
            resultKey: 'splitPaymentMadeId',
            providedId: null,
          },
        ],
        session,
      );
    } else {
      paymentMadeBody.paymentMadeId = await generateUniqueId(
        PaymentMade,
        paymentMadeBody.companyId,
        MODULE_NAMES.PAYMENT_MADE,
        'paymentMadeId',
        'PMTM',
        session,
        paymentMadeBody.paymentMadeId,
      );
    }

    paymentMadeBody.allowCrossBranchMapping = coerceBoolean(paymentMadeBody.allowCrossBranchMapping);

    if (!paymentMadeBody?.isAdvancePayment) {
      for (let i of paymentMadeBody?.bills || []) {
        const bill = await Bill.findById(i?.billId).session(session);
        currencySources.push(bill);

        const previousPaymentMade = await PaymentMade.find({
          'bills.billId': i?.billId,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);

        const totalAppliedAmount = previousPaymentMade.reduce((sum, pr) => {
          const billAmount = (pr.bills || [])
            .filter(b => String(b.billId) === String(i.billId))
            .reduce((subTotal, b) => subTotal + Number(b.amountApplied || 0), 0);

          return sum + billAmount;
        }, 0);

        const remainingAmount = bill.total - totalAppliedAmount;
        if (remainingAmount <= 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `An unapproved payment is already linked to bill:${bill?.billId} . Please clear it before mapping another payment.`,
          );
        }

        if (i.amountApplied > remainingAmount) {
          const sym = (await getCurrency(companyId, bill?.currency))?.symbol || '₹';
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Payment amount exceeds bill limit. You can apply only ${sym}${remainingAmount} more to bill ${bill?.billId}.`,
          );
        }
      }
      for (let ob of paymentMadeBody?.openingBalanceTransactions || []) {
        const obId = ob?.openingBalanceTransactionId;
        const txn = await OpeningBalanceTransaction.findById(obId).session(session);
        currencySources.push(txn);

        if (!txn) {
          throw new ApiError(httpStatus.NOT_FOUND, `Opening balance transaction not found: ${obId}`);
        }
        if (txn.type !== TRANSACTION_TYPE.OPENING_PAYABLE) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening payable can be applied with payment made');
        }
        if (txn.contactId.toString() !== vendorId.toString()) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance transaction does not belong to this vendor');
        }
        if (txn.contactType !== 'vendor') {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance line is not for this vendor');
        }
        const previousPm = await PaymentMade.find({
          'openingBalanceTransactions.openingBalanceTransactionId': obId,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);
        const totalAppliedOb = previousPm.reduce((sum, pm) => {
          const row = pm.openingBalanceTransactions?.find(e => String(e.openingBalanceTransactionId) === String(obId));
          return sum + (Number(row?.amountApplied) || 0);
        }, 0);
        const remainingOb = Number(txn.amount) - totalAppliedOb;
        if (remainingOb <= 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `An unapproved payment is already linked to opening balance ${txn.transactionNo || obId}. Please clear it before mapping another payment.`,
          );
        }
        if (Number(ob.amountApplied) > remainingOb) {
          const sym = (await getCurrency(companyId, txn.currency))?.symbol || '₹';
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Payment amount exceeds opening balance limit. You can apply only ${sym}${remainingOb} more to ${txn.transactionNo || 'this opening balance'}.`,
          );
        }
      }
      for (const line of paymentMadeBody?.expenses || []) {
        const expense = await Expenses.findOne({
          _id: line.expenseId,
          companyId,
          party: vendorId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          isBillable: true,
        }).session(session);
        if (!expense) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Only billable expenses of this vendor can be applied with payment made');
        }
        currencySources.push(expense);

        const previousPayments = await PaymentMade.find({
          companyId,
          'expenses.expenseId': expense._id,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);

        const reservedAmount = previousPayments.reduce((sum, payment) => {
          const expenseAmount = (payment.expenses || [])
            .filter(row => String(row.expenseId) === String(expense._id))
            .reduce((subTotal, row) => subTotal + Number(row.amountApplied || 0), 0);
          return sum + expenseAmount;
        }, 0);

        const remainingAmount = parseFloat((expense.total - reservedAmount).toFixed(2));
        if (Number(line.amountApplied) > remainingAmount) {
          const sym = (await getCurrency(companyId, expense.currency))?.symbol || '₹';
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Payment amount exceeds expense limit. You can apply only ${sym}${remainingAmount} more to expense ${expense.expenseId}.`,
          );
        }
      }
    }

    const { Account } = getBooksModels();
    const paidThroughAccount = await Account.findOne({
      _id: paymentMadeBody.paidThroughAccountId,
      companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).session(session);
    if (!paidThroughAccount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Paid through account not found or not a valid payment account');
    }

    const totalBillsApplied = paymentMadeBody?.bills?.reduce((sum, bill) => sum + (Number(bill.amountApplied) || 0), 0) || 0;
    const totalObApplied =
      (paymentMadeBody?.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) || 0;
    const totalExpensesApplied = (paymentMadeBody.expenses || []).reduce((sum, line) => sum + line.amountApplied, 0);
    const appliedTotal = totalBillsApplied + totalObApplied + totalExpensesApplied;
    const paymentTotal = Number(paymentMadeBody.paymentMade) || 0;

    if (!paymentMadeBody.isAdvancePayment && appliedTotal > paymentTotal) {
      const hasBills = Array.isArray(paymentMadeBody.bills) && paymentMadeBody.bills.length > 0;
      const hasOb =
        Array.isArray(paymentMadeBody.openingBalanceTransactions) && paymentMadeBody.openingBalanceTransactions.length > 0;
      const appliedTargetLabel = hasBills && !hasOb && totalExpensesApplied <= 0 ? 'bills' : 'documents';
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Total amount applied to ${appliedTargetLabel} cannot exceed the payment amount.`,
      );
    }

    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (paymentMadeBody.isAdvancePayment) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({ companyId, vendorId }));
    } else {
      for (const doc of currencySources) {
        if (!doc?.currency) continue;
        if (!currency) {
          currency = doc.currency;
          exchangeRate = doc.exchangeRate ?? 1;
          decimalPlaces = doc.decimalPlaces ?? null;
        } else if (String(doc.currency) !== String(currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
        }
      }
      if (!currency) {
        ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({ companyId, vendorId }));
      }
    }

    if (paymentMadeBody.exchangeRate != null) {
      exchangeRate = paymentMadeBody.exchangeRate;
    }

    const currencyDoc = await getCurrency(companyId, currency);

    const paymentMadeData = {
      ...paymentMadeBody,
      currency,
      exchangeRate: exchangeRate ?? 1,
      decimalPlaces,
      bills: paymentMadeBody.bills || [],
      openingBalanceTransactions: (paymentMadeBody.openingBalanceTransactions || []).map(ob => ({
        openingBalanceTransactionId: ob.openingBalanceTransactionId,
        transactionNo: ob.transactionNo,
        amountApplied: ob.amountApplied,
        appliedDate: new Date(),
      })),
      addedBy: userId,
      isSplit: false,
      updatedBy: userId,
      commentHistory: [
        {
          message: paymentMadeBody.isAdvancePayment
            ? `Advance Payment Made Created with amount ${currencyDoc?.symbol || '₹'}${paymentMadeBody.paymentMade}`
            : `Payment Made Created with amount ${currencyDoc?.symbol || '₹'}${paymentMadeBody.paymentMade}`,
          addedBy: userId,
          createdAt: new Date(),
        },
      ],
      unusedAmount: paymentMadeBody.isAdvancePayment
        ? paymentTotal
        : paymentTotal > appliedTotal
          ? paymentTotal - appliedTotal
          : 0,
      chequeStatus: paymentMadeBody.paymentMode === PAYMENT_MODES.CHEQUE ? CHEQUE_STATUS.PENDING : CHEQUE_STATUS.NONE,
      attachments: allAttachments,
    };

    if (paymentMadeBody?.isSplit) {
      paymentMadeData.paymentMadeId = ids.splitPaymentMadeId;
      paymentMadeData.isSplit = true;
    }
    const [paymentMade] = await PaymentMade.create([paymentMadeData], { session });
    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, paymentMade.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryPaymentMades = async (query, filter, options) => {
  const { Customer, Branch, Division, Warehouse } = getBooksCrmModels();
  const { PaymentMade, Bill, Account, Expenses } = getBooksModels();
  const { User } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const conditions = { companyId };

  if (filter.paidThroughAccountId) {
    conditions.paidThroughAccountId = new mongoose.Types.ObjectId(filter.paidThroughAccountId);
  }

  if (filter.paymentMode?.split(',').length > 0) {
    conditions.paymentMode = { $in: filter.paymentMode.split(',') };
  }

  // Status filter
  if (filter?.status?.split(',').length > 0) {
    conditions.status = { $in: filter.status.split(',') };
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) conditions.addedBy = { $in: addedByIds };
  }

  if (filter.isPendingMapping) {
    conditions.unusedAmount = { $gt: 0 };
    conditions.status = PAYMENT_STATUS.APPROVED;
  }

  // Search filter
  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    const matchingAccounts = await Account.find({
      companyId,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      $or: [{ accountName: searchRegex }, { 'bankDetails.bankName': searchRegex }],
    }).select('_id');

    const paidThroughAccountIds = matchingAccounts.map(account => account._id);

    const vendors = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const bills = await Bill.find(
      {
        $or: [{ billId: searchRegex }],
      },
      { _id: 1 },
    );

    const expenses = await Expenses.find({ companyId, expenseId: searchRegex }, { _id: 1 });

    const vendorIds = vendors.map(v => v._id);
    const billIds = bills.map(b => b._id);
    const expenseIds = expenses.map(expense => expense._id);
    const orConditions = [
      { reference: searchRegex },
      { paymentMadeId: searchRegex },
      { paymentMode: searchRegex },
      { paidThroughAccountId: { $in: paidThroughAccountIds } },
    ];

    if (vendorIds.length) {
      orConditions.push({ vendorId: { $in: vendorIds } });
    }

    if (billIds.length) {
      orConditions.push({ 'bills.billId': { $in: billIds } });
    }

    if (expenseIds.length) {
      orConditions.push({ 'expenses.expenseId': { $in: expenseIds } });
    }

    if (orConditions.length) {
      conditions.$or = orConditions;
    }
  }

  if (filter?.customerId) {
    const customerIds = filter.customerId
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));

    if (customerIds.length > 0) {
      conditions.vendorId = { $in: customerIds };
    }
  }

  // Country/State/City filters apply to the vendor's billing address
  const addressCondition = await getBillingLocationCondition(Customer, companyId, query, 'vendorId');
  if (addressCondition) {
    (conditions.$and ||= []).push(addressCondition);
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'paymentDate' });
  if (branchDivisionCond) {
    Object.assign(conditions, branchDivisionCond);
  }

  if (filter?.isSplit == undefined) {
    conditions.isSplit = false;
  }

  if (filter?.isSplit) {
    conditions.isSplit = true;
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await PaymentMade.countDocuments(conditions) };
  }

  options.populate = 'bills.billId:billId billDate dueDate total balanceAmount';
  // Step 1: Paginate results
  const result = await PaymentMade.paginateWithTotal(conditions, options);

  // Step 2: Extract unique IDs
  const vendorIds = [...new Set(result.results.map(p => p.vendorId?.toString()).filter(Boolean))];
  const paidThroughAccountIds = [...new Set(result.results.map(p => p.paidThroughAccountId?.toString()).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  // Step 3: Bulk fetch
  const [vendors, paidThroughAccounts, branch, warehouse, division, users] = await Promise.all([
    Customer.find({ _id: { $in: vendorIds } })
      .select('customerDisplayName')
      .lean(),
    Account.find({ _id: { $in: paidThroughAccountIds } })
      .select('accountName')
      .lean(),
    await Branch.find({
      _id: { $in: branchIds },
    })
      .select('name _id')
      .lean(),
    await Warehouse.find({
      _id: { $in: warehouseIds },
    })
      .select('name _id')
      .lean(),
    await Division.find({
      _id: { $in: divisionIds },
    })
      .select('name _id')
      .lean(),
    User.find({ _id: { $in: userIds } })
      .select('firstName lastName')
      .lean(),
  ]);

  const vendorMap = vendors.reduce((acc, v) => {
    acc[v._id.toString()] = v;
    return acc;
  }, {});

  const paidThroughAccountMap = paidThroughAccounts.reduce((acc, b) => {
    acc[b._id.toString()] = b;
    return acc;
  }, {});

  const branchMap = branch.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const divisionMap = division.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const warehouseMap = warehouse.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  // Step 4: Populate final result
  const populatedResults = result.results.map(payment => {
    const obj = payment.toObject();
    obj.id = obj._id;
    obj.vendorId = vendorMap[obj.vendorId?.toString()] || null;
    obj.branchId = branchMap[obj.branchId?.toString()] || null;
    obj.divisionId = divisionMap[obj.divisionId?.toString()] || null;
    obj.warehouseId = warehouseMap[obj.warehouseId?.toString()] || null;
    obj.paidThroughAccountId = paidThroughAccountMap[obj.paidThroughAccountId?.toString()] || null;
    obj.addedBy = userMap[obj.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(obj.updatedBy);
    const updatedBy = updatedById ? userMap[updatedById] : null;
    obj.updatedBy = updatedBy || null;
    return obj;
  });

  const approvedAdvancePendingFilter = {
    status: PAYMENT_STATUS.APPROVED,
    unusedAmount: { $gt: 0 },
    companyId: new mongoose.Types.ObjectId(filter.companyId),
  };

  if (filter?.isSplit) {
    approvedAdvancePendingFilter.isSplit = true;
  }
  if (filter?.isSplit == undefined) {
    approvedAdvancePendingFilter.isSplit = false;
  }

  const pendingMappingCount = await PaymentMade.countDocuments(approvedAdvancePendingFilter);

  return {
    ...result,
    pendingMappingCount,
    results: await enrichDocumentCurrency(String(filter.companyId), populatedResults),
  };
};

const queryPaymentMadesExports = async (query, filter, options) => {
  const result = await queryPaymentMades(query, filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getPaymentMadeById = async (id, companyId) => {
  const { Customer, Branch, Division, Warehouse, OpeningBalanceTransaction } = getBooksCrmModels();
  const { PaymentMade, Expenses } = getBooksModels();
  const { User } = getCommonModels();

  // Get the payment made without population
  const paymentMade = await PaymentMade.findOne({ _id: id, companyId }).populate({
    path: 'bills.billId',
    select: 'billId billDate dueDate total balanceAmount branchId',
  }); // Keep bill population as is

  if (!paymentMade) {
    throw new ApiError(httpStatus.NOT_FOUND, PAYMENT_MADE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  // Legacy docs (no field): treat as cross-branch only if a mapped bill is from another branch.
  const paymentBranchId = paymentMade.branchId?.toString();
  const allowCrossBranchMapping =
    typeof paymentMade.allowCrossBranchMapping === 'boolean'
      ? paymentMade.allowCrossBranchMapping
      : (paymentMade.bills || []).some(bill => {
          const billBranchId = bill.billId?.branchId?.toString();
          return billBranchId && paymentBranchId && billBranchId !== paymentBranchId;
        });

  // Get vendor data
  const vendor = await Customer.findById(paymentMade.vendorId).select('customerDisplayName').lean();
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (paymentMade.commentHistory?.length) {
    const userIds = paymentMade.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = paymentMade.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  // Convert payment made to object and populate the data
  const addedBy = await User.findById(paymentMade.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(paymentMade.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const approvedBy = await User.findById(paymentMade.approvedBy).select('firstName lastName email phone');
  const branch = await Branch.findOne(paymentMade.branchId).select('name');
  const division = await Division.findOne(paymentMade.divisionId).select('name');
  const warehouse = await Warehouse.findOne(paymentMade.warehouseId).select('name');

  const paymentMadeObj = paymentMade.toObject();
  paymentMadeObj.addedBy = addedBy;
  paymentMadeObj.updatedBy = updatedBy;
  paymentMadeObj.approvedBy = approvedBy;
  paymentMadeObj.approvalDate = paymentMade.approvalDate;
  paymentMadeObj.commentHistory = commentHistoryWithUser;

  const { Account } = getBooksModels();
  paymentMadeObj.paidThroughAccountId = paymentMade.paidThroughAccountId
    ? await Account.findById(paymentMade.paidThroughAccountId).select('accountName accountCode').lean()
    : null;

  paymentMadeObj.branchId = branch ? { _id: branch._id, name: branch.name } : null;
  paymentMadeObj.branchName = branch?.name || null;
  paymentMadeObj.divisionId = division ? { _id: division._id, name: division.name } : null;
  paymentMadeObj.warehouseId = warehouse ? { _id: warehouse._id, name: warehouse.name } : null;

  paymentMadeObj.createdAt = paymentMade.createdAt;
  paymentMadeObj.updatedAt = paymentMade.updatedAt;

  // Populate vendor data
  paymentMadeObj.vendorId = vendor || null;
  paymentMadeObj.allowCrossBranchMapping = allowCrossBranchMapping;

  if (paymentMade.openingBalanceTransactions?.length) {
    const ids = paymentMade.openingBalanceTransactions.map(l => l.openingBalanceTransactionId).filter(Boolean);

    const docs = await OpeningBalanceTransaction.find({ _id: { $in: ids } })
      .select('transactionNo date amount remainingAmount type branchId')
      .lean();

    paymentMadeObj.openingBalanceTransactions = paymentMade.openingBalanceTransactions.map(line => {
      const doc = docs.find(d => String(d._id) === String(line.openingBalanceTransactionId));

      return {
        _id: line._id,
        openingBalanceTransactionId: line.openingBalanceTransactionId,
        transactionNo: line.transactionNo,
        amountApplied: line.amountApplied,
        appliedDate: line.appliedDate,
        openingBalanceTransaction: doc || { _id: line.openingBalanceTransactionId },
      };
    });
  }

  if (paymentMade.expenses.length) {
    const expenseIds = paymentMade.expenses.map(line => line.expenseId);
    const expenses = await Expenses.find({ _id: { $in: expenseIds } })
      .select('expenseId date total balanceAmount billableStatus branchId')
      .lean();
    const expenseById = new Map(expenses.map(expense => [String(expense._id), expense]));
    paymentMadeObj.expenses = paymentMadeObj.expenses.map(line => ({
      ...line,
      expenseId: expenseById.get(String(line.expenseId)),
    }));
  }

  paymentMadeObj.moduleTree = await buildModuleTree(id);

  return enrichDocumentCurrency(companyId, paymentMadeObj);
};

const updatePaymentMadeById = async (paymentMadeId, updateBody, userId, uploadedFiles = []) => {
  const { Customer, OpeningBalanceTransaction } = getBooksCrmModels();
  const { PaymentMade, Bill, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { vendorId, branchId, companyId } = updateBody;
    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(vendorId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(vendorId, branchId, session);
    }

    const paymentMade = await PaymentMade.findOne({ _id: paymentMadeId, companyId }).session(session);
    if (!paymentMade) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Purchase Payment not found');
    }

    // Handle file updates with S3 cleanup for removed files
    const finalAttachments = await handleFileUpdate({
      newFiles: uploadedFiles,
      currentUrls: updateBody.attachments || [],
      existingUrls: paymentMade.attachments || [],
      userId,
      companyId: paymentMade.companyId,
    });

    if (updateBody.allowCrossBranchMapping !== undefined) {
      updateBody.allowCrossBranchMapping = coerceBoolean(updateBody.allowCrossBranchMapping);
    }

    if (!updateBody?.isAdvancePayment) {
      for (let i of updateBody?.bills || []) {
        const bill = await Bill.findById(i.billId).session(session);

        if (!bill) {
          throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
        }

        if (paymentMade.currency && bill.currency && String(paymentMade.currency) !== String(bill.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
        }

        const previousPaymentMade = await PaymentMade.find({
          'bills.billId': i.billId,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);

        let totalAppliedAmount = previousPaymentMade.reduce((sum, pr) => {
          const billAmount = (pr.bills || [])
            .filter(bill => String(bill.billId) === String(i.billId))
            .reduce((billSum, bill) => billSum + (Number(bill.amountApplied) || 0), 0);

          return sum + billAmount;
        }, 0);

        const oldBill = paymentMade.bills.find(b => b.billId.toString() === i.billId.toString());

        const oldAppliedAmount = Number(oldBill?.amountApplied) || 0;
        totalAppliedAmount -= oldAppliedAmount;

        const remainingAmount = bill.total - totalAppliedAmount;

        if (remainingAmount <= 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `An unapproved payment is already linked to bill:${bill?.billId} . Please clear it before mapping another payment.`,
          );
        }

        if (i.amountApplied > remainingAmount) {
          const sym = (await getCurrency(paymentMade.companyId, bill.currency || paymentMade.currency))?.symbol || '₹';
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Payment amount exceeds bill limit. You can apply only ${sym}${remainingAmount} more to bill ${bill?.billId}.`,
          );
        }
      }
      for (let ob of updateBody?.openingBalanceTransactions || []) {
        const txn = await OpeningBalanceTransaction.findById(ob.openingBalanceTransactionId).select('currency').session(session);
        if (txn?.currency && paymentMade.currency && String(paymentMade.currency) !== String(txn.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
        }
      }
      for (const line of updateBody?.expenses || []) {
        const expense = await Expenses.findOne({
          _id: line.expenseId,
          companyId,
          party: paymentMade.vendorId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          isBillable: true,
        }).session(session);
        if (!expense) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Only billable expenses of this vendor can be applied with payment made');
        }

        const previousPayments = await PaymentMade.find({
          companyId,
          _id: { $ne: paymentMade._id },
          'expenses.expenseId': expense._id,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);
        const reservedAmount = previousPayments.reduce((sum, linkedPayment) => {
          const expenseAmount = (linkedPayment.expenses || [])
            .filter(row => String(row.expenseId) === String(expense._id))
            .reduce((subTotal, row) => subTotal + Number(row.amountApplied || 0), 0);
          return sum + expenseAmount;
        }, 0);
        const remainingAmount = parseFloat((expense.total - reservedAmount).toFixed(2));
        if (Number(line.amountApplied) > remainingAmount) {
          const sym = (await getCurrency(companyId, expense.currency))?.symbol || '₹';
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Payment amount exceeds expense limit. You can apply only ${sym}${remainingAmount} more to expense ${expense.expenseId}.`,
          );
        }
      }
    }
    const newPaymentMode = updateBody.paymentMode || paymentMade.paymentMode;

    if (updateBody.paidThroughAccountId) {
      const { Account } = getBooksModels();
      const paidThroughAccount = await Account.findOne({
        _id: updateBody.paidThroughAccountId,
        companyId: paymentMade.companyId,
        isActive: true,
        category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      }).session(session);
      if (!paidThroughAccount) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Paid through account not found or not a valid payment account');
      }
    }

    if (paymentMade.status !== PAYMENT_STATUS.PENDING) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only pending payments can be edited');
    }
    // Store old amount for comparison
    const oldAmount = paymentMade.paymentMade;
    const newAmount = updateBody.paymentMade;

    const previousPaymentMode = paymentMade.paymentMode;
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;
    Object.assign(paymentMade, updateBody);
    if (paymentMade.isAdvancePayment) {
      paymentMade.bills = [];
      paymentMade.openingBalanceTransactions = [];
      paymentMade.expenses = [];
      paymentMade.unusedAmount = Number(paymentMade.paymentMade) || 0;
    } else {
      paymentMade.bills = Array.isArray(updateBody.bills) ? updateBody.bills : [];
      paymentMade.openingBalanceTransactions = Array.isArray(updateBody.openingBalanceTransactions)
        ? updateBody.openingBalanceTransactions
        : [];
      paymentMade.expenses = updateBody.expenses || [];

      const totalBillsApplied = paymentMade.bills.reduce((sum, bill) => sum + (Number(bill.amountApplied) || 0), 0) || 0;
      const totalObApplied =
        paymentMade.openingBalanceTransactions.reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) || 0;
      const totalExpensesApplied = paymentMade.expenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedTotal = totalBillsApplied + totalObApplied + totalExpensesApplied;
      const paymentTotal = Number(paymentMade.paymentMade) || 0;

      if (appliedTotal > paymentTotal) {
        const hasBills = Array.isArray(paymentMade.bills) && paymentMade.bills.length > 0;
        const hasOb = Array.isArray(paymentMade.openingBalanceTransactions) && paymentMade.openingBalanceTransactions.length > 0;
        const appliedTargetLabel = hasBills && !hasOb && totalExpensesApplied <= 0 ? 'bills' : 'documents';
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Total amount applied to ${appliedTargetLabel} cannot exceed the payment amount.`,
        );
      }

      paymentMade.unusedAmount = paymentTotal > appliedTotal ? paymentTotal - appliedTotal : 0;
    }

    paymentMade.attachments = finalAttachments;
    paymentMade.updatedBy = userId;

    if (paymentMade.paymentMode === PAYMENT_MODES.CHEQUE) {
      const switchedToCheque = previousPaymentMode !== PAYMENT_MODES.CHEQUE;
      const statusMissing = !paymentMade.chequeStatus || paymentMade.chequeStatus === CHEQUE_STATUS.NONE;
      if (switchedToCheque || statusMissing) {
        paymentMade.chequeStatus = CHEQUE_STATUS.PENDING;
      }
    } else {
      paymentMade.chequeStatus = CHEQUE_STATUS.NONE;
    }

    const currencyDoc = await getCurrency(paymentMade.companyId, paymentMade.currency);

    let commentMessage = paymentMade.isAdvancePayment ? 'Advance Payment Made Updated' : 'Payment Made Updated';

    if (newAmount !== undefined && newAmount !== oldAmount) {
      commentMessage = paymentMade.isAdvancePayment
        ? `Advance payment amount changed from ${currencyDoc?.symbol || '₹'}${oldAmount} to ${currencyDoc?.symbol || '₹'}${newAmount}`
        : `Amount changed from ${currencyDoc?.symbol || '₹'}${oldAmount} to ${currencyDoc?.symbol || '₹'}${newAmount}`;
    }

    paymentMade.commentHistory.push({
      message: commentMessage,
      addedBy: userId,
      createdAt: new Date(),
    });

    await paymentMade.save({ session });
    await session.commitTransaction();
    return enrichDocumentCurrency(paymentMade.companyId, paymentMade.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deletePaymentMadeById = async (paymentMadeId, companyId, userId) => {
  const { PaymentMade, Bill, Expenses } = getBooksModels();
  const { Customer, OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const payment = await PaymentMade.findOne({ _id: paymentMadeId, companyId }).session(session);
    if (!payment) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Purchase Payment not found');
    }

    const { branchId, vendorId, paymentMade } = payment;

    const status = payment.status;
    let amount = 0;
    if (status == PAYMENT_STATUS.APPROVED) {
      amount = payment.paymentMade;

      if (payment.isAdvancePayment && payment.bills?.length > 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'This payment made cannot be deleted because it has already been applied to bill.',
        );
      }

      if (!payment.isAdvancePayment && payment.bills?.length > 0) {
        for (const { billId, amountApplied } of payment.bills || []) {
          if (!billId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid bill payment data');
          }

          const bill = await Bill.findById(billId).session(session);
          if (!bill) {
            throw new ApiError(httpStatus.NOT_FOUND, `Bill not found: ${billId}`);
          }

          await cancelBillPayment(bill._id, amountApplied, userId, session);
        }
      }
      if (payment.openingBalanceTransactions?.length > 0) {
        for (const { openingBalanceTransactionId, amountApplied } of payment.openingBalanceTransactions) {
          if (!openingBalanceTransactionId || amountApplied == null || amountApplied <= 0) continue;
          const obReverted = await OpeningBalanceTransaction.findOneAndUpdate(
            { _id: openingBalanceTransactionId, companyId: payment.companyId },
            {
              $inc: { remainingAmount: amountApplied },
              $pull: { paymentMadeEntries: { paymentMadeId: payment._id } },
            },
            { session, new: true },
          );
          if (!obReverted) {
            throw new ApiError(httpStatus.CONFLICT, 'Could not revert opening balance for this payment');
          }
        }
      }
      for (const { expenseId, amountApplied } of payment.expenses) {
        await updateExpensePaymentStatus(expenseId, -amountApplied, session);
      }
      {
        const applications = await collectPaymentApplications(
          payment,
          { Invoice: null, Bill, OpeningBalanceTransaction, Expenses },
          session,
        );
        // Refunds already moved the balance back, so only the unused amount is still credit.
        const unusedForBalance = Number(payment.unusedAmount || 0);
        await allocatePaymentBranchBalances({
          customerId: vendorId,
          paymentBranchId: branchId,
          unusedAmount: unusedForBalance,
          applications,
          session,
          reverse: true,
        });
      }

      // Remove journals for this payment and every refund / bill / OB line it posted.
      const ledgerSourceIds = [
        payment._id,
        ...(payment.refunds || []).map(refund => refund._id),
        ...(payment.bills || []).map(line => line._id),
        ...(payment.openingBalanceTransactions || []).map(line => line._id),
      ];
      for (const sourceId of ledgerSourceIds) {
        await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId }, session);
      }
    }

    await PaymentMade.findByIdAndDelete(paymentMadeId, { session });

    await session.commitTransaction();
    return paymentMade;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const approvePaymentMadeById = async (paymentMadeId, companyId, body, userId, uploadedFiles = []) => {
  const { approvalNote, attachments, pdcChequeDate, chequeApprovalNote } = body;

  const { PaymentMade, Bill, Expenses } = getBooksModels();
  const { Customer, OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const payment = await PaymentMade.findOne({ _id: paymentMadeId, companyId }).session(session);
    if (!payment) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
    }

    const { vendorId, branchId, paymentMade } = payment;
    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(vendorId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(vendorId, branchId, session);
    }

    if (payment.status === PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment is already approved');
    }

    if (payment.status !== PAYMENT_STATUS.PENDING) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only pending payments can be approved');
    }

    if (pdcChequeDate) {
      payment.pdcChequeDate = pdcChequeDate;
    }

    payment.chequeStatus = CHEQUE_STATUS.CLEARED;
    payment.status = PAYMENT_STATUS.APPROVED;
    if (approvalNote !== undefined) {
      payment.approvalNote = approvalNote;
    }

    let chequeCommentMessage = null;
    if (payment.paymentMode === PAYMENT_MODES.CHEQUE) {
      if (chequeApprovalNote !== undefined) {
        payment.chequeApprovalNote = chequeApprovalNote;
      }
      const chequeMessageParts = ['Cheque marked as Cleared'];
      if (chequeApprovalNote) {
        chequeMessageParts.push(`cheque ApprovalNote: ${chequeApprovalNote}`);
      }
      if (payment.pdcChequeDate) {
        chequeMessageParts.push(`Date: ${new Date(payment.pdcChequeDate).toLocaleDateString('en-GB')}`);
      }
      chequeCommentMessage = `${chequeMessageParts.join('. ')}.`;
    }

    if (!payment.isAdvancePayment) {
      if (payment.bills?.length > 0) {
        for (const { billId, amountApplied } of payment.bills || []) {
          if (!billId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid bill payment data');
          }

          const bill = await Bill.findById(billId).session(session);
          if (!bill) {
            throw new ApiError(httpStatus.NOT_FOUND, `Bill not found: ${billId}`);
          }

          if (payment.currency && bill.currency && String(payment.currency) !== String(bill.currency)) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
          }

          if (amountApplied > bill?.balanceAmount) {
            throw new ApiError(
              httpStatus.BAD_REQUEST,
              `You cannot apply more than the due amount for bill (${bill.billId || bill._id})`,
            );
          }

          await updateBillPaymentStatus(bill._id, amountApplied, userId, session);
        }
      }
      if (payment.openingBalanceTransactions?.length > 0) {
        for (const { openingBalanceTransactionId, amountApplied } of payment.openingBalanceTransactions || []) {
          if (!openingBalanceTransactionId || amountApplied == null || amountApplied < 0) continue;
          const txn = await OpeningBalanceTransaction.findById(openingBalanceTransactionId).session(session);
          if (txn) {
            if (payment.currency && txn.currency && String(payment.currency) !== String(txn.currency)) {
              throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
            }
            if (String(txn.companyId) !== String(payment.companyId)) {
              throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance does not belong to this company');
            }
            if (txn.type !== TRANSACTION_TYPE.OPENING_PAYABLE) {
              throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening payable can be applied with payment made');
            }
            const ok = await txn.updateRemainingAmount(amountApplied, session);
            if (!ok) {
              throw new ApiError(
                httpStatus.BAD_REQUEST,
                `Cannot apply more than remaining amount to opening balance ${txn.transactionNo || txn._id}`,
              );
            }
            const obPushed = await OpeningBalanceTransaction.findOneAndUpdate(
              { _id: openingBalanceTransactionId, companyId: payment.companyId },
              {
                $push: {
                  paymentMadeEntries: {
                    entrySource: OB_PAYMENT_ENTRY_SOURCE.PAYMENT_MADE,
                    paymentMadeId: payment._id,
                    paymentDocumentNo: payment.paymentMadeId,
                    amountApplied,
                    appliedDate: new Date(),
                  },
                },
              },
              { session, new: true },
            );
            if (!obPushed) {
              throw new ApiError(httpStatus.CONFLICT, 'Could not record opening balance entry for this payment');
            }
          }
        }
      }
      for (const { expenseId, amountApplied } of payment.expenses) {
        await updateExpensePaymentStatus(expenseId, amountApplied, session);
      }
    }
    {
      const applications = await collectPaymentApplications(
        payment,
        { Invoice: null, Bill, OpeningBalanceTransaction, Expenses },
        session,
      );
      await allocatePaymentBranchBalances({
        customerId: vendorId,
        paymentBranchId: branchId,
        unusedAmount: Number(payment.unusedAmount || 0),
        applications,
        session,
        reverse: false,
      });
    }

    const currencyDoc = await getCurrency(companyId, payment.currency);

    const approvalMessage = payment.isAdvancePayment
      ? `Advance Payment Made Approved with amount ${currencyDoc?.symbol || '₹'}${paymentMade}`
      : `Payment Made Approved with amount ${currencyDoc?.symbol || '₹'}${paymentMade}`;

    payment.commentHistory.push({
      message: chequeCommentMessage ? `${approvalMessage}. ${chequeCommentMessage}` : `${approvalMessage}.`,
      addedBy: userId,
      createdAt: new Date(),
    });

    // Post Dr AP + prepaid / Cr bank in payment currency; appliedAt uses each bill rate for correct clearing and FX.
    {
      const appliedTotal =
        (payment.bills || []).reduce((sum, bill) => sum + (Number(bill.amountApplied) || 0), 0) +
        (payment.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        payment.expenses.reduce((sum, line) => sum + line.amountApplied, 0);

      const appliedAt = await ledgerService.buildAppliedAt(payment, session);

      await ledgerService.postPaymentMadeJournal(
        {
          companyId: payment.companyId,
          paidThroughAccountId: payment.paidThroughAccountId,
          appliedAmount: appliedTotal,
          unusedAmount: payment.unusedAmount,
          partyId: payment.vendorId,
          postingDate: payment.paymentDate,
          sourceId: payment._id,
          narration: `Payment made ${payment.paymentMadeId}`,
          addedBy: userId,
          currencyId: payment.currency,
          exchangeRate: payment.exchangeRate,
          appliedAt,
          isSplit: payment.isSplit,
        },
        session,
      );
    }

    payment.approvedBy = userId;
    payment.approvalDate = new Date();
    payment.attachments = await handleFileUpdate({
      newFiles: uploadedFiles,
      currentUrls: attachments || [],
      existingUrls: payment.attachments || [],
      userId,
      companyId,
    });
    await payment.save({ session });

    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, payment.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const rejectPaymentMadeById = async (paymentMadeId, companyId, body, userId, uploadedFiles = []) => {
  const { PaymentMade } = getBooksModels();

  const { notes, approvalNote, attachments, pdcChequeDate, chequeApprovalNote } = body;

  const payment = await PaymentMade.findOne({ _id: paymentMadeId, companyId });
  if (!payment) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
  }

  const currencyDoc = await getCurrency(companyId, payment.currency);

  if (payment.status === PAYMENT_STATUS.REJECTED) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Payment is already rejected');
  }

  if (payment.status !== PAYMENT_STATUS.PENDING) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Only pending payments can be rejected');
  }

  payment.status = PAYMENT_STATUS.REJECTED;
  if (approvalNote !== undefined) {
    payment.approvalNote = approvalNote;
  } else if (notes !== undefined) {
    payment.approvalNote = notes;
  }
  if (pdcChequeDate) {
    payment.pdcChequeDate = pdcChequeDate;
  }
  if (chequeApprovalNote !== undefined) {
    payment.chequeApprovalNote = chequeApprovalNote;
  }
  payment.attachments = await handleFileUpdate({
    newFiles: uploadedFiles,
    currentUrls: attachments || [],
    existingUrls: payment.attachments || [],
    userId,
    companyId,
  });

  const rejectMessageParts = [`Payment Made Rejected with amount ${currencyDoc?.symbol || '₹'}${payment.paymentMade}`];
  if (chequeApprovalNote) {
    rejectMessageParts.push(`cheque ApprovalNote: ${chequeApprovalNote}`);
  }
  if (payment.pdcChequeDate) {
    rejectMessageParts.push(`Date: ${new Date(payment.pdcChequeDate).toLocaleDateString('en-GB')}`);
  }

  payment.commentHistory.push({
    message: `${rejectMessageParts.join('. ')}.`,
    addedBy: userId,
    createdAt: new Date(),
  });

  await payment.save();

  return enrichDocumentCurrency(companyId, payment.toJSON());
};

const cancelPaymentMadeById = async (paymentMadeId, companyId, notes, userId) => {
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const { Bill, PaymentMade, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  await session.startTransaction();

  try {
    const payment = await PaymentMade.findOne({ _id: paymentMadeId, companyId }).session(session);

    if (!payment) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Made not found');
    }

    const currencyDoc = await getCurrency(companyId, payment.currency);

    const { branchId, vendorId, paymentMade } = payment;
    if (payment.status === PAYMENT_STATUS.CANCELLED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment already cancelled');
    }

    if (payment.status === PAYMENT_STATUS.APPROVED) {
    }

    // 3. Mark payment as cancelled and add optional notes
    if (notes !== undefined) {
      payment.approvalNote = notes;
    }

    // Revert bills, OB, and branch only when payment was APPROVED (aligned with cancelPaymentReceivedById)
    if (payment.status === PAYMENT_STATUS.APPROVED) {
      if (payment.isAdvancePayment && payment.bills?.length > 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'This payment made cannot be deleted because it has already been applied to bill.',
        );
      }

      if (!payment.isAdvancePayment && payment.bills?.length > 0) {
        for (const { billId, amountApplied } of payment.bills) {
          if (!billId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid bill payment data');
          }

          const bill = await Bill.findById(billId).session(session);
          if (!bill) {
            throw new ApiError(httpStatus.NOT_FOUND, `Bill not found: ${billId}`);
          }

          await cancelBillPayment(bill._id, amountApplied, userId, session);
        }
      }
      for (const { openingBalanceTransactionId, amountApplied } of payment.openingBalanceTransactions || []) {
        if (!openingBalanceTransactionId || amountApplied == null || amountApplied <= 0) continue;
        const obResult = await OpeningBalanceTransaction.updateOne(
          { _id: openingBalanceTransactionId, companyId: payment.companyId },
          { $inc: { remainingAmount: amountApplied } },
          { session },
        );
        if (obResult.matchedCount === 0) {
          throw new ApiError(httpStatus.CONFLICT, 'Could not revert opening balance for this payment');
        }
      }
      for (const { expenseId, amountApplied } of payment.expenses) {
        await updateExpensePaymentStatus(expenseId, -amountApplied, session);
      }
      {
        const applications = await collectPaymentApplications(
          payment,
          { Invoice: null, Bill, OpeningBalanceTransaction, Expenses },
          session,
        );
        // Refunds already moved the balance back, so only the unused amount is still credit.
        const unusedForBalance = Number(payment.unusedAmount || 0);
        await allocatePaymentBranchBalances({
          customerId: vendorId,
          paymentBranchId: branchId,
          unusedAmount: unusedForBalance,
          applications,
          session,
          reverse: true,
        });
      }

      // Remove journals for this payment and every refund / bill / OB line it posted.
      const ledgerSourceIds = [
        payment._id,
        ...(payment.refunds || []).map(refund => refund._id),
        ...(payment.bills || []).map(line => line._id),
        ...(payment.openingBalanceTransactions || []).map(line => line._id),
      ];
      for (const sourceId of ledgerSourceIds) {
        await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId }, session);
      }
    }

    payment.commentHistory.push({
      message: `Payment Made Cancelled with amount ${currencyDoc?.symbol || '₹'}${paymentMade}`,
      addedBy: userId,
      createdAt: new Date(),
    });

    payment.status = PAYMENT_STATUS.CANCELLED;

    await payment.save({ session });

    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, payment.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deletePaymentMadeBill = async (paymentMadeId, companyId, body, userId) => {
  const { Customer } = getBooksCrmModels();
  const { Bill, PaymentMade, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { bills = [], expenses = [] } = body;
    const paymentMade = await PaymentMade.findOne({ _id: paymentMadeId, companyId }).session(session);

    if (!paymentMade) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
    }

    const payloadBillsIds = bills.map(bill => bill.billId.toString());
    const unremovedBills = paymentMade?.bills.filter(bill => !payloadBillsIds.includes(bill._id.toString()));

    const removedExpenseIds = new Set(expenses.map(line => String(line.expenseId)));
    const removedExpenses = paymentMade.expenses.filter(line => removedExpenseIds.has(String(line.expenseId)));
    const unremovedExpenses = paymentMade.expenses.filter(line => !removedExpenseIds.has(String(line.expenseId)));

    const totalAmountPaid =
      unremovedBills.reduce((sum, bill) => sum + (bill.amountApplied || 0), 0) +
      unremovedExpenses.reduce((sum, line) => sum + line.amountApplied, 0);

    if (paymentMade?.status == PAYMENT_STATUS.APPROVED) {
      if (!paymentMade.isAdvancePayment && bills?.length > 0) {
        let totalRemovedApplied = 0;
        for (const { billId, amountApplied } of bills) {
          if (!billId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid bill data in payment');
          }

          const bill = await Bill.findById(billId).session(session);

          if (!bill) {
            throw new ApiError(httpStatus.NOT_FOUND, `Bill not found: ${billId}`);
          }

          await cancelBillPayment(bill._id, amountApplied, userId, session);

          await bill.save({ session });

          totalRemovedApplied += Number(amountApplied) || 0;
          await updateBranchCurrentBalance({
            customerId: paymentMade.vendorId,
            branchId: bill.branchId || paymentMade.branchId,
            amount: Number(amountApplied) || 0,
            session,
          });
        }
      }

      for (const line of removedExpenses) {
        await updateExpensePaymentStatus(line.expenseId, -line.amountApplied, session);
        const expense = await Expenses.findById(line.expenseId).select('branchId').session(session).lean();
        await updateBranchCurrentBalance({
          customerId: paymentMade.vendorId,
          branchId: expense.branchId,
          amount: line.amountApplied,
          session,
        });
      }

      let newCurrentBalance = totalAmountPaid;

      if (newCurrentBalance == paymentMade.paymentMade) {
        newCurrentBalance = 0;
      }
      if (newCurrentBalance != paymentMade.paymentMade) {
        newCurrentBalance = totalAmountPaid - paymentMade.paymentMade;
      }
    }

    await PaymentMade.updateOne(
      { _id: paymentMadeId },
      {
        $set: {
          bills: unremovedBills,
          expenses: unremovedExpenses,
          paymentMade: totalAmountPaid,

          updatedBy: userId,
        },
      },
      { session },
    );

    // Bill was unlinked — refresh accounting with the new applied and unused amounts.
    if (paymentMade.status === PAYMENT_STATUS.APPROVED) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId: paymentMade._id },
        session,
      );
      const remainingApplied =
        (unremovedBills || []).reduce((sum, bill) => sum + (Number(bill.amountApplied) || 0), 0) +
        (paymentMade.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        unremovedExpenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedAt = await ledgerService.buildAppliedAt(
        {
          bills: unremovedBills,
          openingBalanceTransactions: paymentMade.openingBalanceTransactions,
          expenses: unremovedExpenses,
          exchangeRate: paymentMade.exchangeRate,
        },
        session,
      );
      await ledgerService.postPaymentMadeJournal(
        {
          companyId,
          paidThroughAccountId: paymentMade.paidThroughAccountId,
          appliedAmount: remainingApplied,
          unusedAmount:
            paymentMade.unusedAmount +
            (paymentMade.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
          partyId: paymentMade.vendorId,
          postingDate: paymentMade.paymentDate,
          sourceId: paymentMade._id,
          narration: `Payment made ${paymentMade.paymentMadeId}`,
          addedBy: userId,
          currencyId: paymentMade.currency,
          exchangeRate: paymentMade.exchangeRate,
          appliedAt,
          isSplit: paymentMade.isSplit,
        },
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
};

const applyAdvancePaymentMadeAgainstBill = async (
  paymentMadeId,
  companyId,
  bills = [],
  openingBalanceTransactions = [],
  userId = null,
  expenses = [],
) => {
  const { Bill, PaymentMade, Expenses } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentMade = await PaymentMade.findOne({
      _id: paymentMadeId,
      // isAdvancePayment: true,
      companyId,
    }).session(session);

    if (!paymentMade) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Made not found');
    }

    if (paymentMade.status !== PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment Made is not approved');
    }

    if (paymentMade.unusedAmount <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No available balance to apply');
    }

    let totalApplied = 0;
    const billUpdates = [];

    // Each bill / opening balance may appear only once per request. The validate loops below cache the
    // fetched document, so two lines for the same target would each pass the stale per-line guard and
    // over-apply (driving balanceAmount negative and over-consuming the advance).
    const seenApplicationTargets = new Set();
    for (const { billId } of bills || []) {
      if (!billId) continue;
      const key = String(billId);
      if (seenApplicationTargets.has(key)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'The same bill is listed more than once. Please remove the duplicate before applying the payment.',
        );
      }
      seenApplicationTargets.add(key);
    }
    for (const { openingBalanceTransactionId } of openingBalanceTransactions || []) {
      if (!openingBalanceTransactionId) continue;
      const key = String(openingBalanceTransactionId);
      if (seenApplicationTargets.has(key)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'The same opening balance is listed more than once. Please remove the duplicate before applying the payment.',
        );
      }
      seenApplicationTargets.add(key);
    }
    for (const { expenseId } of expenses) {
      const key = String(expenseId);
      if (seenApplicationTargets.has(key)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'The same expense is listed more than once. Please remove the duplicate before applying the payment.',
        );
      }
      seenApplicationTargets.add(key);
    }

    // Validate and calculate total applied amount for bills
    for (const { billId, amountApplied } of bills) {
      const bill = await Bill.findById(billId).session(session);
      if (!bill) {
        throw new ApiError(httpStatus.NOT_FOUND, `Bill ${billId} not found`);
      }
      if (paymentMade.currency && bill.currency && String(paymentMade.currency) !== String(bill.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
      }
      if (paymentMade?.isSplit != bill?.isSplit) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Split status of bill ${bill.billId} does not match with payment made`);
      }
      const pendingMappedPayments = await PaymentMade.find({
        companyId,
        _id: { $ne: paymentMadeId },
        isAdvancePayment: false,
        status: PAYMENT_STATUS.PENDING,
        'bills.billId': bill._id,
      })
        .select('paymentMadeId bills')
        .lean()
        .session(session);

      let pendingReserved = 0;
      let blockingPaymentMade = null;

      for (const payment of pendingMappedPayments) {
        const paymentAmount = (payment.bills || [])
          .filter(b => String(b.billId) === String(bill._id))
          .reduce((sum, b) => sum + Number(b.amountApplied || 0), 0);

        pendingReserved += paymentAmount;

        if (!blockingPaymentMade) {
          blockingPaymentMade = payment.paymentMadeId;
        }
      }

      if (pendingReserved + Number(amountApplied) > Number(bill.balanceAmount)) {
        const blockingMsg = blockingPaymentMade
          ? `already linked with unapproved Payment Made ${blockingPaymentMade}. Please approve or delete that payment before applying advance payment`
          : `already fully allocated across existing payments`;
        throw new ApiError(httpStatus.BAD_REQUEST, `Bill ${bill.billId} is ${blockingMsg}.`);
      }
      if (bill.balanceAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Amount exceeds balance for bill ${bill.billId}`);
      }

      totalApplied = parseFloat((totalApplied + amountApplied).toFixed(2));
      billUpdates.push({ bill, amountApplied });
    }

    const obUpdates = [];
    for (const { openingBalanceTransactionId, amountApplied } of openingBalanceTransactions) {
      if (amountApplied == null || amountApplied <= 0) continue;
      if (!openingBalanceTransactionId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance transaction ID is required');
      }
      const txn = await OpeningBalanceTransaction.findById(openingBalanceTransactionId).session(session);
      if (!txn) {
        throw new ApiError(httpStatus.NOT_FOUND, `Opening balance transaction not found: ${openingBalanceTransactionId}`);
      }
      if (paymentMade.currency && txn.currency && String(paymentMade.currency) !== String(txn.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
      }
      if (String(txn.companyId) !== String(paymentMade.companyId)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance does not belong to this company');
      }
      if (txn.type !== TRANSACTION_TYPE.OPENING_PAYABLE) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening payable can be applied with payment made');
      }
      if (txn.remainingAmount < amountApplied) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Amount exceeds remaining balance for opening balance ${txn.transactionNo || txn._id}`,
        );
      }
      totalApplied = parseFloat((totalApplied + amountApplied).toFixed(2));
      obUpdates.push({ txn, amountApplied });
    }

    const expenseUpdates = [];
    for (const { expenseId, amountApplied } of expenses) {
      const expense = await Expenses.findOne({
        _id: expenseId,
        companyId,
        party: paymentMade.vendorId,
        partyType: LEDGER_PARTY_TYPES.VENDOR,
        isBillable: true,
      }).session(session);
      if (!expense) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Only billable expenses of this vendor can be applied with payment made');
      }

      const previousPayments = await PaymentMade.find({
        companyId,
        'expenses.expenseId': expense._id,
        status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
      }).session(session);
      const reservedAmount = previousPayments.reduce((sum, linkedPayment) => {
        const expenseAmount = (linkedPayment.expenses || [])
          .filter(row => String(row.expenseId) === String(expense._id))
          .reduce((subTotal, row) => subTotal + Number(row.amountApplied || 0), 0);
        return sum + expenseAmount;
      }, 0);
      const remainingAmount = parseFloat((expense.total - reservedAmount).toFixed(2));
      if (Number(amountApplied) > remainingAmount) {
        const sym = (await getCurrency(companyId, expense.currency))?.symbol || '₹';
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Payment amount exceeds expense limit. You can apply only ${sym}${remainingAmount} more to expense ${expense.expenseId}.`,
        );
      }

      totalApplied = parseFloat((totalApplied + amountApplied).toFixed(2));
      expenseUpdates.push({ expense, amountApplied });
    }

    if (totalApplied > paymentMade.unusedAmount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Total applied amount exceeds unused amount');
    }

    const currencyDoc = await getCurrency(companyId, paymentMade.currency);

    // Add or update bills in payment made
    for (const { bill, amountApplied } of billUpdates) {
      paymentMade.bills.push({
        billId: bill._id,
        billNo: bill.billId,
        amountApplied,
      });

      paymentMade.unusedAmount -= amountApplied;
      await moveAdvanceApplyBranchBalances({
        customerId: paymentMade.vendorId,
        paymentBranchId: paymentMade.branchId,
        documentBranchId: bill.branchId,
        amount: amountApplied,
        session,
      });
      await updateBillPaymentStatus(bill._id, amountApplied, userId, session);
      await Bill.updateOne(
        { _id: bill._id },
        {
          $push: {
            commentHistory: {
              message: `Advance Payment ${paymentMade.paymentMadeId} applied for ${currencyDoc?.symbol || '₹'}${amountApplied}`,
              addedBy: userId,
              createdAt: new Date(),
              referenceType: 'PaymentMade',
              referenceId: paymentMade._id,
            },
          },
        },
        { session },
      );
    }

    for (const { txn, amountApplied } of obUpdates) {
      paymentMade.openingBalanceTransactions = paymentMade.openingBalanceTransactions || [];
      paymentMade.openingBalanceTransactions.push({
        openingBalanceTransactionId: txn._id,
        transactionNo: txn.transactionNo,
        amountApplied,
        appliedDate: new Date(),
      });

      paymentMade.unusedAmount -= amountApplied;
      await moveAdvanceApplyBranchBalances({
        customerId: paymentMade.vendorId,
        paymentBranchId: paymentMade.branchId,
        documentBranchId: txn.branchId,
        amount: amountApplied,
        session,
      });
      await txn.updateRemainingAmount(amountApplied, session);
      const obPushed = await OpeningBalanceTransaction.findOneAndUpdate(
        { _id: txn._id, companyId: paymentMade.companyId },
        {
          $push: {
            paymentMadeEntries: {
              entrySource: OB_PAYMENT_ENTRY_SOURCE.PAYMENT_MADE,
              paymentMadeId: paymentMade._id,
              paymentDocumentNo: paymentMade.paymentMadeId,
              amountApplied,
              appliedDate: new Date(),
            },
          },
        },
        { session, new: true },
      );
      if (!obPushed) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not record opening balance entry for this payment');
      }
    }

    for (const { expense, amountApplied } of expenseUpdates) {
      paymentMade.expenses.push({
        expenseId: expense._id,
        expenseNo: expense.expenseId,
        amountApplied,
        appliedDate: new Date(),
      });

      paymentMade.unusedAmount -= amountApplied;
      await moveAdvanceApplyBranchBalances({
        customerId: paymentMade.vendorId,
        paymentBranchId: paymentMade.branchId,
        documentBranchId: expense.branchId,
        amount: amountApplied,
        session,
      });
      await updateExpensePaymentStatus(expense._id, amountApplied, session);
    }

    if (totalApplied > 0) {
      const billAppliedTotal = billUpdates.reduce((sum, { amountApplied }) => sum + amountApplied, 0);
      const obAppliedTotal = obUpdates.reduce((sum, { amountApplied }) => sum + amountApplied, 0);
      const expenseAppliedTotal = expenseUpdates.reduce((sum, { amountApplied }) => sum + amountApplied, 0);
      let message = `Advance payment applied for ${currencyDoc?.symbol || '₹'}${totalApplied}`;

      if (expenseAppliedTotal > 0) {
        if (expenseAppliedTotal === totalApplied) {
          message = `Advance payment applied to expenses for ${currencyDoc?.symbol || '₹'}${expenseAppliedTotal}`;
        }
      } else if (billAppliedTotal > 0 && obAppliedTotal > 0) {
        message = `Advance payment applied to bills for ${currencyDoc?.symbol || '₹'}${billAppliedTotal} and opening balance for ${currencyDoc?.symbol || '₹'}${obAppliedTotal}`;
      } else if (billAppliedTotal > 0) {
        message = `Advance payment applied to bills for ${currencyDoc?.symbol || '₹'}${billAppliedTotal}`;
      } else if (obAppliedTotal > 0) {
        message = `Advance payment applied to opening balance for ${currencyDoc?.symbol || '₹'}${obAppliedTotal}`;
      }

      paymentMade.commentHistory.push({
        message,
        addedBy: userId,
        createdAt: new Date(),
      });
    }

    if (paymentMade.status === PAYMENT_STATUS.APPROVED) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId: paymentMade._id },
        session,
      );
      const appliedTotal =
        (paymentMade.bills || []).reduce((sum, bill) => sum + (Number(bill.amountApplied) || 0), 0) +
        (paymentMade.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        paymentMade.expenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedAt = await ledgerService.buildAppliedAt(paymentMade, session);
      await ledgerService.postPaymentMadeJournal(
        {
          companyId,
          paidThroughAccountId: paymentMade.paidThroughAccountId,
          appliedAmount: appliedTotal,
          unusedAmount:
            paymentMade.unusedAmount +
            (paymentMade.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
          partyId: paymentMade.vendorId,
          postingDate: paymentMade.paymentDate,
          sourceId: paymentMade._id,
          narration: `Payment made ${paymentMade.paymentMadeId}`,
          addedBy: userId,
          isSplit: paymentMade.isSplit,
          currencyId: paymentMade.currency,
          exchangeRate: paymentMade.exchangeRate,
          appliedAt,
        },
        session,
      );
    }

    await paymentMade.save({ session });
    await session.commitTransaction();

    return enrichDocumentCurrency(companyId, paymentMade.toJSON());
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch {}
    throw error;
  } finally {
    await session.endSession();
  }
};

const AUTO_APPLY_BILL_STATUSES = [BILL_STATUSES.OPEN, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.OVERDUE];

const getBillNosFromPaymentMade = payment =>
  [...new Set((payment.bills || []).map(bill => bill.billNo).filter(Boolean))].join(', ');

const buildAutoApplyPaymentMadeFailure = (payment, { amountApplied = 0, billsToApply = [], billNo, message } = {}) => {
  const paymentBillNo = getBillNosFromPaymentMade(payment);
  const appliedBillNo = [...new Set((billsToApply || []).map(bill => bill.billNo).filter(Boolean))].join(', ');
  const resolvedBillNo = [
    ...new Set(
      String(billNo || paymentBillNo || appliedBillNo)
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
    ),
  ].join(', ');

  return {
    paymentMadeId: payment.paymentMadeId || payment._id,
    billNo: resolvedBillNo,
    billId: payment.bills?.[0]?.billId || billsToApply?.[0]?.billId || null,
    amountApplied,
    message,
  };
};

const getPendingBillsForAutoApply = async (Bill, { companyId, vendorId, branchId, isSplit }) => {
  return Bill.aggregate([
    {
      $match: {
        companyId,
        vendor: vendorId,
        branchId,
        isSplit: !!isSplit,
        balanceAmount: { $gt: 0 },
        status: { $in: AUTO_APPLY_BILL_STATUSES },
      },
    },
    { $project: { _id: 1, dueDate: 1, createdAt: 1, billId: 1 } },
    { $sort: { dueDate: 1, createdAt: 1, _id: 1 } },
  ]);
};

const getPendingOpeningPayablesForAutoApply = async (OpeningBalanceTransaction, { companyId, vendorId, branchId }) => {
  const baseMatch = {
    companyId,
    contactId: vendorId,
    contactType: CONTACT_TYPE.VENDOR,
    type: TRANSACTION_TYPE.OPENING_PAYABLE,
    remainingAmount: { $gt: 0 },
  };
  const matchQueries = branchId ? [{ ...baseMatch, branchId }, baseMatch] : [baseMatch];

  for (const $match of matchQueries) {
    const rows = await OpeningBalanceTransaction.aggregate([
      { $match },
      { $project: { _id: 1, transactionNo: 1, remainingAmount: 1, date: 1, createdAt: 1 } },
      { $sort: { date: 1, createdAt: 1, _id: 1 } },
    ]);
    if (rows.length) {
      return rows;
    }
  }

  return [];
};

const validateSelectedVendorAutoApply = async ({
  companyObjectId,
  vendorObjectId,
  PaymentMade,
  Bill,
  OpeningBalanceTransaction,
}) => {
  const [hasAdvancePayment, hasEligibleBill, hasOpeningPayable] = await Promise.all([
    PaymentMade.exists({
      companyId: companyObjectId,
      vendorId: vendorObjectId,
      status: PAYMENT_STATUS.APPROVED,
      unusedAmount: { $gt: 0 },
    }),
    Bill.exists({
      companyId: companyObjectId,
      vendor: vendorObjectId,
      balanceAmount: { $gt: 0 },
      status: { $in: AUTO_APPLY_BILL_STATUSES },
    }),
    OpeningBalanceTransaction.exists({
      companyId: companyObjectId,
      contactId: vendorObjectId,
      contactType: CONTACT_TYPE.VENDOR,
      type: TRANSACTION_TYPE.OPENING_PAYABLE,
      remainingAmount: { $gt: 0 },
    }),
  ]);

  const hasEligibleTarget = Boolean(hasEligibleBill || hasOpeningPayable);

  if (hasAdvancePayment && !hasEligibleTarget) {
    throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MADE_MESSAGES.AUTO_APPLY_ADVANCE_WITHOUT_BILL);
  }

  if (hasEligibleTarget && !hasAdvancePayment) {
    throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MADE_MESSAGES.AUTO_APPLY_BILL_WITHOUT_ADVANCE);
  }

  if (!hasAdvancePayment && !hasEligibleTarget) {
    throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MADE_MESSAGES.AUTO_APPLY_NO_BILL_OR_ADVANCE);
  }
};

const autoApplyPendingAdvancePaymentMade = async (companyId, userId, vendorId) => {
  const { Bill, PaymentMade } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const vendorObjectId = vendorId ? new mongoose.Types.ObjectId(vendorId) : null;

  if (vendorObjectId) {
    await validateSelectedVendorAutoApply({
      companyObjectId,
      vendorObjectId,
      PaymentMade,
      Bill,
      OpeningBalanceTransaction,
    });
  }

  const paymentGroups = await PaymentMade.aggregate([
    {
      $match: {
        companyId: companyObjectId,
        status: PAYMENT_STATUS.APPROVED,
        unusedAmount: { $gt: 0 },
        ...(vendorObjectId ? { vendorId: vendorObjectId } : {}),
      },
    },
    {
      $project: {
        _id: 1,
        vendorId: 1,
        branchId: 1,
        companyId: 1,
        isSplit: 1,
        createdAt: 1,
      },
    },
    {
      $sort: {
        vendorId: 1,
        branchId: 1,
        createdAt: 1,
        _id: 1,
      },
    },
    {
      $group: {
        _id: {
          vendorId: '$vendorId',
          branchId: '$branchId',
          companyId: '$companyId',
          isSplit: '$isSplit',
        },
        paymentIds: { $push: '$_id' },
      },
    },
  ]);

  if (!paymentGroups.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      vendorObjectId ? PAYMENT_MADE_MESSAGES.AUTO_APPLY_NO_BILL_OR_ADVANCE : PAYMENT_MADE_MESSAGES.AUTO_APPLY_NO_BILLS,
    );
  }

  let groupsProcessed = 0;
  let mappedPayments = 0;
  let mappedBills = 0;
  let totalMappedAmount = 0;
  let attemptedMappings = 0;
  let successfulMappings = 0;
  let failedMappings = 0;
  const failures = [];
  let hasPendingWork = false;

  for (const group of paymentGroups) {
    const { vendorId, branchId, companyId: groupCompanyId, isSplit } = group._id;

    const pendingOpeningPayable = await getPendingOpeningPayablesForAutoApply(OpeningBalanceTransaction, {
      companyId: groupCompanyId,
      vendorId,
      branchId,
    });

    if (pendingOpeningPayable.length > 0) {
      hasPendingWork = true;
    }

    const paymentsForOb = await PaymentMade.find({ _id: { $in: group.paymentIds } }).sort({
      createdAt: 1,
      _id: 1,
    });
    const obIdsInOrder = pendingOpeningPayable.map(ob => ob._id);
    const obFound = await OpeningBalanceTransaction.find({ _id: { $in: obIdsInOrder } });
    const obMap = new Map(obFound.map(ob => [ob._id.toString(), ob]));
    const orderedOb = obIdsInOrder.map(id => obMap.get(id.toString())).filter(Boolean);

    const obRemainingMap = new Map(orderedOb.map(ob => [ob._id.toString(), Number(ob.remainingAmount) || 0]));
    const paymentUnusedForObMap = new Map(paymentsForOb.map(p => [p._id.toString(), Number(p.unusedAmount) || 0]));

    const touchedObPaymentIds = new Set();

    for (const payment of paymentsForOb) {
      const paymentUnused = paymentUnusedForObMap.get(payment._id.toString()) || 0;
      if (paymentUnused <= 0) continue;

      const obToApply = [];
      let remainingPayment = paymentUnused;
      const obDeductions = new Map();

      for (const obTxn of orderedOb) {
        if (remainingPayment <= 0) break;
        const obRemaining = obRemainingMap.get(obTxn._id.toString()) || 0;
        if (obRemaining <= 0) continue;

        const amountApplied = parseFloat(Math.min(remainingPayment, obRemaining).toFixed(2));
        if (amountApplied <= 0) continue;

        obToApply.push({ openingBalanceTransactionId: obTxn._id, amountApplied });
        obDeductions.set(obTxn._id.toString(), amountApplied);
        remainingPayment = parseFloat((remainingPayment - amountApplied).toFixed(2));
      }

      if (obToApply.length === 0) continue;

      const totalAppliedForPayment = parseFloat((paymentUnused - remainingPayment).toFixed(2));

      attemptedMappings += 1;
      try {
        await applyAdvancePaymentMadeAgainstBill(payment._id, companyId, [], obToApply, userId);

        paymentUnusedForObMap.set(payment._id.toString(), remainingPayment);
        for (const [obId, deduction] of obDeductions) {
          const prev = obRemainingMap.get(obId) || 0;
          obRemainingMap.set(obId, parseFloat((prev - deduction).toFixed(2)));
        }

        touchedObPaymentIds.add(payment._id.toString());
        totalMappedAmount = parseFloat((totalMappedAmount + totalAppliedForPayment).toFixed(2));
        mappedBills += obToApply.length;
        successfulMappings += 1;
      } catch (error) {
        failedMappings += 1;
        if (failures.length < 100) {
          failures.push(
            buildAutoApplyPaymentMadeFailure(payment, {
              amountApplied: totalAppliedForPayment,
              message: error?.message || 'Failed to apply advance payment against opening payable',
            }),
          );
        }
      }
    }

    if (touchedObPaymentIds.size > 0) {
      groupsProcessed += 1;
      mappedPayments += touchedObPaymentIds.size;

      await PaymentMade.updateMany(
        { _id: { $in: [...touchedObPaymentIds].map(id => new mongoose.Types.ObjectId(id)) } },
        {
          $set: { updatedBy: userId },
          $push: {
            commentHistory: {
              message: 'Auto payment mapping applied against opening payable balance',
              addedBy: userId,
            },
          },
        },
      );
    }

    const pendingBills = await getPendingBillsForAutoApply(Bill, {
      companyId: groupCompanyId,
      vendorId,
      branchId,
      isSplit,
    });

    if (!pendingBills.length) {
      // Opening payable with no bill is a normal result: clear the opening balance and do not warn.
      if (pendingOpeningPayable.length > 0) {
        continue;
      }

      // Block only when this vendor has unused advance and nothing to clear (no bill and no opening payable).
      if (vendorObjectId) {
        const hasUnusedAdvance = paymentsForOb.some(payment => (paymentUnusedForObMap.get(payment._id.toString()) || 0) > 0);
        if (hasUnusedAdvance) {
          throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MADE_MESSAGES.AUTO_APPLY_ADVANCE_WITHOUT_BILL);
        }
        continue;
      }

      for (const payment of paymentsForOb) {
        const remainingUnused = paymentUnusedForObMap.get(payment._id.toString()) || 0;
        if (remainingUnused <= 0) continue;

        attemptedMappings += 1;
        failedMappings += 1;
        hasPendingWork = true;
        if (failures.length < 100) {
          failures.push(
            buildAutoApplyPaymentMadeFailure(payment, {
              amountApplied: remainingUnused,
              billNo: getBillNosFromPaymentMade(payment),
              message: 'No bill is available to apply this advance payment.',
            }),
          );
        }
      }
      continue;
    }
    hasPendingWork = true;

    const payments = await PaymentMade.find({ _id: { $in: group.paymentIds } }).sort({ createdAt: 1, _id: 1 });

    const billIdsInOrder = pendingBills.map(b => b._id);
    const billsFound = await Bill.find({ _id: { $in: billIdsInOrder } });
    const billMap = new Map(billsFound.map(b => [b._id.toString(), b]));
    const orderedBills = billIdsInOrder.map(id => billMap.get(id.toString())).filter(Boolean);

    const billRemainingMap = new Map(orderedBills.map(b => [b._id.toString(), Number(b.balanceAmount) || 0]));
    const paymentUnusedMap = new Map(payments.map(p => [p._id.toString(), Number(p.unusedAmount) || 0]));

    const touchedPaymentIds = new Set();

    for (const payment of payments) {
      const paymentUnused = paymentUnusedMap.get(payment._id.toString()) || 0;
      if (paymentUnused <= 0) continue;

      const billsToApply = [];
      let remainingPayment = paymentUnused;
      const billDeductions = new Map();

      for (const bill of orderedBills) {
        if (remainingPayment <= 0) break;
        const billRemaining = billRemainingMap.get(bill._id.toString()) || 0;
        if (billRemaining <= 0) continue;

        const amountApplied = parseFloat(Math.min(remainingPayment, billRemaining).toFixed(2));
        if (amountApplied <= 0) continue;

        billsToApply.push({ billId: bill._id, billNo: bill.billId, amountApplied });
        billDeductions.set(bill._id.toString(), amountApplied);
        remainingPayment = parseFloat((remainingPayment - amountApplied).toFixed(2));
      }

      if (billsToApply.length === 0) continue;

      const totalAppliedForPayment = parseFloat((paymentUnused - remainingPayment).toFixed(2));

      attemptedMappings += 1;
      try {
        await applyAdvancePaymentMadeAgainstBill(payment._id, companyId, billsToApply, [], userId);

        paymentUnusedMap.set(payment._id.toString(), remainingPayment);
        for (const [billId, deduction] of billDeductions) {
          const prev = billRemainingMap.get(billId) || 0;
          billRemainingMap.set(billId, parseFloat((prev - deduction).toFixed(2)));
        }

        touchedPaymentIds.add(payment._id.toString());
        totalMappedAmount = parseFloat((totalMappedAmount + totalAppliedForPayment).toFixed(2));
        mappedBills += billsToApply.length;
        successfulMappings += 1;
      } catch (error) {
        failedMappings += 1;
        if (failures.length < 100) {
          failures.push(
            buildAutoApplyPaymentMadeFailure(payment, {
              amountApplied: totalAppliedForPayment,
              billsToApply,
              message: error?.message || 'Failed to apply advance payment against bills',
            }),
          );
        }
      }
    }

    if (touchedPaymentIds.size > 0) {
      groupsProcessed += 1;
      mappedPayments += touchedPaymentIds.size;

      await PaymentMade.updateMany(
        { _id: { $in: [...touchedPaymentIds].map(id => new mongoose.Types.ObjectId(id)) } },
        {
          $set: { updatedBy: userId },
          $push: {
            commentHistory: {
              message: 'Auto payment mapping applied against pending bills',
              addedBy: userId,
            },
          },
        },
      );
    }
  }

  if (!hasPendingWork && failures.length === 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      vendorObjectId ? PAYMENT_MADE_MESSAGES.AUTO_APPLY_NO_BILL_OR_ADVANCE : PAYMENT_MADE_MESSAGES.AUTO_APPLY_NO_BILLS,
    );
  }

  if (vendorObjectId && attemptedMappings > 0 && successfulMappings === 0 && failedMappings > 0 && failures[0]?.message) {
    throw new ApiError(httpStatus.BAD_REQUEST, failures[0].message);
  }

  const success = hasPendingWork && failedMappings === 0;

  return {
    groupsProcessed,
    mappedPayments,
    mappedBills,
    totalMappedAmount,
    attemptedMappings,
    successfulMappings,
    failedMappings,
    failures,
    success,
  };
};

const removeAdvancePaymentMadeAgainstBill = async (paymentMadeId, companyId, body = {}, userId = null) => {
  const { billId, openingBalanceLineId, expenseLineId } = body;
  if (!billId && !openingBalanceLineId && !expenseLineId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'billId, openingBalanceLineId or expenseLineId is required');
  }

  const { Bill, PaymentMade, Expenses } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const paymentMade = await PaymentMade.findOne({
      _id: paymentMadeId,
      companyId,
    }).session(session);

    if (!paymentMade) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Made not found');
    }

    const currencyDoc = await getCurrency(companyId, paymentMade.currency);
    if (paymentMade.status !== PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment Made is not approved');
    }

    if (openingBalanceLineId) {
      const obLine = (paymentMade.openingBalanceTransactions || []).find(
        line => line._id && line._id.toString() === String(openingBalanceLineId),
      );
      if (!obLine) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance application not found in this payment');
      }
      const amountApplied = Number(obLine.amountApplied) || 0;
      const obTxnId = obLine.openingBalanceTransactionId;
      if (!obTxnId || amountApplied <= 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid opening balance line data');
      }
      paymentMade.openingBalanceTransactions = (paymentMade.openingBalanceTransactions || []).filter(
        line => !(line._id && line._id.toString() === String(openingBalanceLineId)),
      );
      paymentMade.unusedAmount += amountApplied;

      const obTxn = await OpeningBalanceTransaction.findById(obTxnId).select('branchId').session(session).lean();
      await moveAdvanceApplyBranchBalances({
        customerId: paymentMade.vendorId,
        paymentBranchId: paymentMade.branchId,
        documentBranchId: obTxn?.branchId,
        amount: amountApplied,
        session,
        reverse: true,
      });

      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId: obLine._id },
        session,
      );
      const ok = await OpeningBalanceTransaction.findOneAndUpdate(
        { _id: obTxnId, companyId },
        {
          $inc: { remainingAmount: amountApplied },
          $pull: {
            paymentMadeEntries: { paymentMadeId: paymentMade._id, amountApplied },
          },
        },
        { session, new: true },
      );
      if (!ok) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not revert opening balance for this payment');
      }
      paymentMade.commentHistory.push({
        message: `Advance payment application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed from opening balance`,
        addedBy: userId,
        createdAt: new Date(),
      });
    } else if (expenseLineId) {
      const expenseLine = paymentMade.expenses.find(line => String(line._id) === String(expenseLineId));
      if (!expenseLine) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Expense not found in payment made');
      }
      paymentMade.expenses = paymentMade.expenses.filter(line => String(line._id) !== String(expenseLineId));
      paymentMade.unusedAmount += expenseLine.amountApplied;

      const expense = await Expenses.findById(expenseLine.expenseId).select('branchId').session(session).lean();
      await moveAdvanceApplyBranchBalances({
        customerId: paymentMade.vendorId,
        paymentBranchId: paymentMade.branchId,
        documentBranchId: expense.branchId,
        amount: expenseLine.amountApplied,
        session,
        reverse: true,
      });
      await updateExpensePaymentStatus(expenseLine.expenseId, -expenseLine.amountApplied, session);
      paymentMade.commentHistory.push({
        message: `Advance payment application of ${currencyDoc?.symbol || '₹'}${expenseLine.amountApplied} removed from expense ${expenseLine.expenseNo}`,
        addedBy: userId,
        createdAt: new Date(),
      });
    } else {
      const billLine = paymentMade.bills.find(b => b._id.toString() === String(billId));
      if (!billLine) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found in payment made');
      }
      const bill = await Bill.findById(billLine.billId).session(session);
      if (!bill) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
      }

      paymentMade.bills = paymentMade.bills.filter(b => b._id.toString() !== String(billId));
      paymentMade.unusedAmount += billLine.amountApplied;
      await moveAdvanceApplyBranchBalances({
        customerId: paymentMade.vendorId,
        paymentBranchId: paymentMade.branchId,
        documentBranchId: bill.branchId,
        amount: billLine.amountApplied,
        session,
        reverse: true,
      });
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId: billLine._id },
        session,
      );
      paymentMade.commentHistory.push({
        message: `Advance payment application of ${currencyDoc?.symbol || '₹'}${billLine.amountApplied} removed from bill ${billLine.billNo || bill.billId}`,
        addedBy: userId,
        createdAt: new Date(),
      });
      await cancelBillPayment(bill._id, billLine.amountApplied, userId, session);
      await Bill.updateOne(
        { _id: bill._id },
        {
          $push: {
            commentHistory: {
              message: `Advance Payment ${paymentMade.paymentMadeId} application of ${currencyDoc?.symbol || '₹'}${billLine.amountApplied} removed`,
              addedBy: userId,
              createdAt: new Date(),
              referenceType: 'PaymentMade',
              referenceId: paymentMade._id,
            },
          },
        },
        { session },
      );
    }

    if (paymentMade.status === PAYMENT_STATUS.APPROVED) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId: paymentMade._id },
        session,
      );
      const remainingApplied =
        (paymentMade.bills || []).reduce((sum, bill) => sum + (Number(bill.amountApplied) || 0), 0) +
        (paymentMade.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        paymentMade.expenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedAt = await ledgerService.buildAppliedAt(paymentMade, session);
      await ledgerService.postPaymentMadeJournal(
        {
          companyId,
          paidThroughAccountId: paymentMade.paidThroughAccountId,
          appliedAmount: remainingApplied,
          unusedAmount:
            paymentMade.unusedAmount +
            (paymentMade.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
          partyId: paymentMade.vendorId,
          postingDate: paymentMade.paymentDate,
          sourceId: paymentMade._id,
          narration: `Payment made ${paymentMade.paymentMadeId}`,
          addedBy: userId,
          isSplit: paymentMade.isSplit,
          currencyId: paymentMade.currency,
          exchangeRate: paymentMade.exchangeRate,
          appliedAt,
        },
        session,
      );
    }

    await paymentMade.save({ session });
    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, paymentMade.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const buildModuleTree = async paymentMadeId => {
  const { GrpoOrder, Bill, PaymentMade, PurchaseOrder } = getBooksModels();

  const moduleTree = { purchaseOrders: [] };

  /* ================= PAYMENT MADE ================= */

  const payment = await PaymentMade.findById(paymentMadeId).select('_id paymentMadeId paymentDate status paymentMade bills');

  if (!payment) return moduleTree;

  const paymentNode = {
    id: payment._id,
    paymentMadeId: payment.paymentMadeId,
    paymentDate: payment.paymentDate,
    status: payment.status,
    paymentMade: payment.paymentMade,
  };

  /* ================= BILLS ================= */

  const billIds = payment.bills?.map(b => b.billId) || [];

  const bills = await Bill.find({
    _id: { $in: billIds },
    isSplit: { $ne: true },
  }).select('_id billId billDate status total grpoIds purchaseOrders');

  const poMap = new Map();

  for (const bill of bills) {
    const billNode = {
      id: bill._id,
      billId: bill.billId,
      billDate: bill.billDate,
      status: bill.status,
      total: bill.total,
      payments: [paymentNode],
    };

    /* ========== CASE 1: BILL FROM GRPO ========== */

    if (bill.grpoIds?.length) {
      const grpoIds = bill.grpoIds.map(g => g.grpoId);

      const grpos = await GrpoOrder.find({
        _id: { $in: grpoIds },
      }).select('_id grpoId date status total purchaseOrderIds');

      for (const grpo of grpos) {
        const grpoNode = {
          id: grpo._id,
          grpoId: grpo.grpoId,
          date: grpo.date,
          status: grpo.status,
          total: grpo.total,
          bills: [billNode],
        };

        const poIds = grpo.purchaseOrderIds?.map(p => p.purchaseOrderId) || [];
        const purchaseOrders = await PurchaseOrder.find({
          _id: { $in: poIds },
        }).select('_id purchaseOrderId date status total');

        for (const po of purchaseOrders) {
          if (!poMap.has(po._id.toString())) {
            poMap.set(po._id.toString(), {
              id: po._id,
              purchaseOrderId: po.purchaseOrderId,
              date: po.date,
              status: po.status,
              total: po.total,
              grpos: [],
            });
          }

          poMap.get(po._id.toString()).grpos.push(grpoNode);
        }
      }
    }

    /* ========== CASE 2: BILL DIRECT FROM PO ========== */

    if (bill.purchaseOrders?.length) {
      const poIds = bill.purchaseOrders.map(p => p.purchaseOrderId || p._id);

      const purchaseOrders = await PurchaseOrder.find({
        _id: { $in: poIds },
      }).select('_id purchaseOrderId date status total');

      for (const po of purchaseOrders) {
        if (!poMap.has(po._id.toString())) {
          poMap.set(po._id.toString(), {
            id: po._id,
            purchaseOrderId: po.purchaseOrderId,
            date: po.date,
            status: po.status,
            total: po.total,
            bills: [],
          });
        }

        poMap.get(po._id.toString()).bills.push(billNode);
      }
    }

    /* ========== CASE 3: DIRECT BILL ========== */

    if (!bill.grpoIds?.length && !bill.purchaseOrders?.length) {
      moduleTree.bill = billNode;
    }
  }

  /* ================= BUILD ROOT ================= */

  moduleTree.purchaseOrders = Array.from(poMap.values());

  if (!moduleTree.purchaseOrders.length && !moduleTree.bill) {
    moduleTree.paymentMade = paymentNode;
  }

  return moduleTree;
};

const addRefund = async (refundBody, companyId) => {
  const {} = getBooksCrmModels();
  const { PaymentMade } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentMade = await PaymentMade.findOne({
      _id: refundBody.paymentMadeId,
      companyId,
    }).session(session);

    if (!paymentMade) {
      throw new ApiError(httpStatus.NOT_FOUND, 'PaymentMade not found');
    }

    if (paymentMade.status !== PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only approved payments can be refunded');
    }

    if (paymentMade.unusedAmount <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No available balance to refund');
    }

    if (refundBody.amountRefunded > paymentMade.unusedAmount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount exceeds available balance');
    }

    paymentMade.refunds = paymentMade.refunds || [];

    // Refund can only be credited to a cash or bank account.
    const { Account } = getBooksModels();
    const toAccount = await Account.findOne({
      _id: refundBody.toAccountId,
      companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).session(session);
    if (!toAccount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'To account not found or not a valid payment account');
    }

    paymentMade.refunds.push({
      refundedAt: refundBody.refundedAt,
      paymentMode: refundBody.paymentMode,
      toAccountId: refundBody.toAccountId,
      amountRefunded: refundBody.amountRefunded,
      description: refundBody.description,
    });
    paymentMade.unusedAmount -= refundBody.amountRefunded;

    await paymentMade.save({ session });
    // Refunded money is no longer our advance with the vendor.
    await updateBranchCurrentBalance({
      customerId: paymentMade.vendorId,
      branchId: paymentMade.branchId,
      amount: refundBody.amountRefunded,
      session,
    });

    // Record refund in accounts: money moves from vendor advance to the selected account.
    const refund = paymentMade.refunds[paymentMade.refunds.length - 1];
    await ledgerService.postVendorRefundJournal(
      {
        companyId,
        toAccountId: refund.toAccountId,
        amount: refund.amountRefunded,
        partyId: paymentMade.vendorId,
        postingDate: refund.refundedAt,
        sourceId: refund._id,
        narration: `Refund against ${paymentMade.paymentMadeId}`,
        addedBy: paymentMade.addedBy,
        currencyId: paymentMade.currency,
        exchangeRate: paymentMade.exchangeRate,
      },
      session,
    );

    await session.commitTransaction();

    return enrichDocumentCurrency(companyId, paymentMade.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteRefund = async (paymentMadeId, refundId, companyId) => {
  const {} = getBooksCrmModels();
  const { PaymentMade } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentMade = await PaymentMade.findOne({
      _id: paymentMadeId,
      companyId,
    }).session(session);

    if (!paymentMade) {
      throw new ApiError(httpStatus.NOT_FOUND, 'PaymentMade not found');
    }

    const refund = paymentMade.refunds?.find(r => r._id.toString() === refundId.toString());

    if (!refund) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund not found');
    }

    paymentMade.unusedAmount += refund.amountRefunded;
    paymentMade.refunds = paymentMade.refunds.filter(r => r._id.toString() !== refundId.toString());

    await paymentMade.save({ session });
    await updateBranchCurrentBalance({
      customerId: paymentMade.vendorId,
      branchId: paymentMade.branchId,
      amount: -refund.amountRefunded,
      session,
    });

    // Remove accounting entry for this refund before deleting the refund record.
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId: refund._id },
      session,
    );

    await session.commitTransaction();

    return paymentMade;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateRefund = async (refundBody, paymentMadeId, companyId) => {
  const {} = getBooksCrmModels();
  const { PaymentMade } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentMade = await PaymentMade.findOne({
      _id: paymentMadeId,
      companyId,
    }).session(session);

    if (!paymentMade) {
      throw new ApiError(httpStatus.NOT_FOUND, 'PaymentMade not found');
    }

    const refund = paymentMade.refunds?.find(r => r._id.toString() === refundBody.refundId.toString());

    if (!refund) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund not found');
    }

    const effectiveUnusedAmount = paymentMade.unusedAmount + refund.amountRefunded;

    if (refundBody.amountRefunded > effectiveUnusedAmount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount exceeds unused amount');
    }

    if (refundBody.toAccountId) {
      const { Account } = getBooksModels();
      const toAccount = await Account.findOne({
        _id: refundBody.toAccountId,
        companyId,
        isActive: true,
        category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      }).session(session);
      if (!toAccount) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'To account not found or not a valid payment account');
      }
    }

    const previousAmountRefunded = refund.amountRefunded;
    if (refundBody.toAccountId) refund.toAccountId = refundBody.toAccountId;

    refund.paymentMode = refundBody.paymentMode;
    refund.amountRefunded = refundBody.amountRefunded;
    refund.description = refundBody.description;

    paymentMade.unusedAmount -= refundBody.amountRefunded - previousAmountRefunded;

    await paymentMade.save({ session });
    await updateBranchCurrentBalance({
      customerId: paymentMade.vendorId,
      branchId: paymentMade.branchId,
      amount: refundBody.amountRefunded - previousAmountRefunded,
      session,
    });

    // Refund details changed — update the accounting entry to match.
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_MADE, sourceId: refund._id },
      session,
    );
    await ledgerService.postVendorRefundJournal(
      {
        companyId,
        toAccountId: refund.toAccountId,
        amount: refund.amountRefunded,
        partyId: paymentMade.vendorId,
        postingDate: refund.refundedAt,
        sourceId: refund._id,
        narration: `Refund against ${paymentMade.paymentMadeId}`,
        addedBy: paymentMade.addedBy,
        currencyId: paymentMade.currency,
        exchangeRate: paymentMade.exchangeRate,
      },
      session,
    );
    await session.commitTransaction();

    return enrichDocumentCurrency(companyId, paymentMade.toJSON());
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
  createPaymentMade: withTransientRetry(createPaymentMade),
  queryPaymentMades,
  queryPaymentMadesExports,
  getPaymentMadeById,
  updatePaymentMadeById,
  deletePaymentMadeById,
  approvePaymentMadeById,
  rejectPaymentMadeById,
  cancelPaymentMadeById,
  deletePaymentMadeBill,
  applyAdvancePaymentMadeAgainstBill,
  autoApplyPendingAdvancePaymentMade,
  removeAdvancePaymentMadeAgainstBill,
  addRefund,
  deleteRefund,
  updateRefund,
};
