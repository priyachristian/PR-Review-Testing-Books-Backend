const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { getBillingLocationCondition } = require('../../../utils/addressLocationFilter');
const ApiError = require('../../../utils/ApiError');
const { PAYMENT_MESSAGES } = require('../../../utils/messages');
const { processIncentiveEarn, cancelIncentiveLog } = require('../../setting/incentiveScheme/incentiveScheme.service');
const { updateInvoicePaymentStatus, cancelInvoicePayment } = require('../invoice/invoice.service');
const { updateExpensePaymentStatus } = require('../../purchase/expense/expense.service');
const {
  PAYMENT_MODES,
  MODULE_NAMES,
  PAYMENT_STATUS,
  CHEQUE_STATUS,
  INVOICE_STATUS,
  TRANSACTION_TYPE,
  OB_PAYMENT_ENTRY_SOURCE,
  CONTACT_TYPE,
  LEDGER_SOURCE_MODULES,
  PAYMENT_ACCOUNT_CATEGORIES,
  ACCOUNT_CATEGORIES,
} = require('../../../utils/enum');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const mongoose = require('mongoose');
const { defaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const {
  APP_NAME,
  NOTIFICATION_TYPE,
  CUSTOMER_PAYMENT_STATUS,
  LEDGER_PARTY_TYPES,
} = require('@smit9313/abss-models-core/src/utils/enum');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const {
  allocatePaymentBranchBalances,
  moveAdvanceApplyBranchBalances,
  collectPaymentApplications,
} = require('../../../utils/paymentBranchBalance');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const { getCompanyProfile } = require('../../../services/onboard.service');
const { getCurrency, enrichDocumentCurrency, resolveTransactionCurrency } = require('../../../services/currencyResolver.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { coerceBoolean } = require('../../../utils/helper');

const createPayment = async ({ customerPaymentId, ...paymentBody }, userId, uploadedFiles = []) => {
  const { PaymentReceived, Customer, OpeningBalanceTransaction } = getBooksCrmModels();
  const { Invoice, Expenses } = getBooksModels();
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
      companyId: paymentBody.companyId,
    });

    const { customerId, branchId, companyId } = paymentBody;

    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(customerId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(customerId, branchId, session);
    }

    let ids = '';
    const currencySources = [];
    if (paymentBody?.isSplit) {
      ids = await generateMultipleUniqueIdsForModules(
        PaymentReceived,
        paymentBody.companyId,
        [
          {
            moduleName: MODULE_NAMES.SPLIT_PAYMENT_RECEIVED,
            idField: 'paymentReceivedId',
            defaultPrefix: 'SPAY',
            count: 1,
            resultKey: 'splitPaymentReceivedId',
            providedId: null,
          },
        ],
        session,
      );
    } else {
      paymentBody.paymentReceivedId = await generateUniqueId(
        PaymentReceived,
        paymentBody?.companyId,
        MODULE_NAMES.PAYMENT_RECEIVED,
        'paymentReceivedId',
        'PMT',
        session,
        paymentBody.paymentReceivedId,
      );
    }

    paymentBody.allowCrossBranchMapping = coerceBoolean(paymentBody.allowCrossBranchMapping);

    if (!paymentBody?.isAdvancePayment) {
      for (let i of paymentBody?.invoices || []) {
        const invoice = await Invoice.findById(i?.invoiceId).session(session);
        currencySources.push(invoice);

        const previousPaymentReceive = await PaymentReceived.find({
          'invoices.invoiceId': i?.invoiceId,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);

        const totalAppliedAmount = previousPaymentReceive.reduce((sum, pr) => {
          const invoiceAmount = (pr.invoices || [])
            .filter(inv => String(inv.invoiceId) === String(i.invoiceId))
            .reduce((subTotal, inv) => subTotal + Number(inv.amountApplied || 0) + Number(inv.tdsAmount || 0), 0);

          return sum + invoiceAmount;
        }, 0);

        const remainingAmount = parseFloat((invoice.total - totalAppliedAmount).toFixed(2));
        if (remainingAmount <= 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `An unapproved payment is already linked to invoice:${invoice.invoiceId} . Please clear it before mapping another payment.`,
          );
        }

        const settledAmount = parseFloat((Number(i.amountApplied) + Number(i.tdsAmount || 0)).toFixed(2));
        if (settledAmount > remainingAmount) {
          const sym = (await getCurrency(companyId, invoice.currency))?.symbol || '₹';
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Payment amount exceeds invoice limit. You can apply only ${sym}${remainingAmount} more to invoice ${invoice.invoiceId}.`,
          );
        }
      }
      for (let ob of paymentBody?.openingBalanceTransactions || []) {
        const obId = ob?.openingBalanceTransactionId;
        const txn = await OpeningBalanceTransaction.findById(obId).session(session);
        currencySources.push(txn);
        if (!txn) {
          throw new ApiError(httpStatus.NOT_FOUND, `Opening balance transaction not found: ${obId}`);
        }
        if (txn.type !== TRANSACTION_TYPE.OPENING_RECEIVABLE) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening receivable can be applied with payment received');
        }
        if (txn.contactId.toString() !== customerId.toString()) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance transaction does not belong to this customer');
        }
        if (txn.contactType !== 'customer') {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance line is not for this customer');
        }
        const previousPr = await PaymentReceived.find({
          'openingBalanceTransactions.openingBalanceTransactionId': obId,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);
        const totalAppliedOb = previousPr.reduce((sum, pr) => {
          const row = pr.openingBalanceTransactions?.find(e => String(e.openingBalanceTransactionId) === String(obId));
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
      for (const line of paymentBody?.expenses || []) {
        const expense = await Expenses.findOne({
          _id: line.expenseId,
          companyId,
          party: customerId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          isBillable: true,
        }).session(session);
        if (!expense) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'Only billable expenses of this customer can be applied with payment received',
          );
        }
        currencySources.push(expense);

        const previousPayments = await PaymentReceived.find({
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

    // await generateUniqueId(
    //   PaymentReceived,
    //   paymentBody?.companyId,
    //   MODULE_NAMES.PAYMENT_RECEIVED,
    //   'paymentReceivedId',
    //   'PMT',
    //   session,
    // );
    const { Account } = getBooksModels();
    const depositToAccount = await Account.findOne({
      _id: paymentBody.depositToAccountId,
      companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).session(session);
    if (!depositToAccount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Deposit to account not found or not a valid payment account');
    }
    if (paymentBody.taxDeducted) {
      const tdsAccount = await Account.findOne({
        _id: paymentBody.tdsAccountId,
        companyId,
        isActive: true,
        category: ACCOUNT_CATEGORIES.OTHER_CURRENT_ASSET.code,
      }).session(session);
      if (!tdsAccount) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'TDS account not found or not a valid TDS account');
      }
    }

    const totalInvoicesApplied = paymentBody?.invoices?.reduce((sum, inv) => sum + (Number(inv.amountApplied) || 0), 0) || 0;
    const totalObApplied =
      (paymentBody?.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) || 0;
    const totalExpensesApplied = (paymentBody.expenses || []).reduce((sum, line) => sum + line.amountApplied, 0);
    const appliedTotal = totalInvoicesApplied + totalObApplied + totalExpensesApplied;
    const paymentTotal = Number(paymentBody.amountReceived) || 0;

    if (!paymentBody.isAdvancePayment && appliedTotal > paymentTotal) {
      const hasInvoices = Array.isArray(paymentBody.invoices) && paymentBody.invoices.length > 0;
      const hasOb = Array.isArray(paymentBody.openingBalanceTransactions) && paymentBody.openingBalanceTransactions.length > 0;
      const appliedTargetLabel = hasInvoices && !hasOb && totalExpensesApplied <= 0 ? 'invoices' : 'documents';
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Total amount applied to ${appliedTargetLabel} cannot exceed the amount received.`,
      );
    }

    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (paymentBody.isAdvancePayment) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({ companyId, customerId }));
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
        ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({ companyId, customerId }));
      }
    }

    if (paymentBody.exchangeRate != null) {
      exchangeRate = paymentBody.exchangeRate;
    }

    const currencyDoc = await getCurrency(companyId, currency);

    const paymentData = {
      ...paymentBody,
      currency,
      exchangeRate: exchangeRate ?? 1,
      decimalPlaces,
      invoices: paymentBody.invoices || [],
      openingBalanceTransactions: (paymentBody.openingBalanceTransactions || []).map(ob => ({
        openingBalanceTransactionId: ob.openingBalanceTransactionId,
        transactionNo: ob.transactionNo,
        amountApplied: ob.amountApplied,
        appliedDate: new Date(),
      })),
      appName: APP_NAME.BOOKS,
      addedBy: userId,
      isSplit: false,
      updatedBy: userId,
      commentHistory: [
        {
          message: paymentBody.isAdvancePayment
            ? `Advance Payment Received Created with amount ${currencyDoc?.symbol || '₹'}${paymentBody.amountReceived}`
            : `Payment Received Created with amount ${currencyDoc?.symbol || '₹'}${paymentBody.amountReceived}`,
          addedBy: userId,
          createdAt: new Date(),
        },
      ],
      unusedAmount: paymentBody.isAdvancePayment ? paymentTotal : paymentTotal > appliedTotal ? paymentTotal - appliedTotal : 0,
      chequeStatus: paymentBody.paymentMode === PAYMENT_MODES.CHEQUE ? CHEQUE_STATUS.PENDING : CHEQUE_STATUS.NONE,
      attachments: allAttachments,
    };
    if (paymentBody?.isSplit) {
      paymentData.paymentReceivedId = ids.splitPaymentReceivedId;
      paymentData.isSplit = true;
    }

    const [payment] = await PaymentReceived.create([paymentData], { session });

    // Recording a customer (portal) payment: approve and link it in the same transaction.
    // The SUBMITTED filter makes a second record attempt fail and roll this create back.
    if (customerPaymentId) {
      const { CustomerPayment } = getBooksModels();
      const linked = await CustomerPayment.findOneAndUpdate(
        { _id: customerPaymentId, companyId, customerId, status: CUSTOMER_PAYMENT_STATUS.SUBMITTED },
        {
          $set: { status: CUSTOMER_PAYMENT_STATUS.APPROVED },
          $push: {
            convertedTo: {
              type: 'PaymentReceived',
              documentId: payment._id,
              documentNo: payment.paymentReceivedId,
              convertedAt: new Date(),
            },
            commentHistory: { message: `Recorded as payment ${payment.paymentReceivedId}`, addedByType: 'User', addedBy: userId },
            updatedBy: userId,
          },
        },
        { session },
      );
      if (!linked) {
        throw new ApiError(
          httpStatus.CONFLICT,
          'This customer payment is no longer pending. It may have already been recorded or rejected.',
        );
      }
    }

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: payment.customerId,
      companyId: payment.companyId,
      notificationType: NOTIFICATION_TYPE.PAYMENT_RECEIVED_CREATED,
      entityId: payment._id,
      entityDisplayId: payment.paymentReceivedId,
      triggeredByUserId: userId,
    });

    processIncentiveEarn(companyId, userId, 'PAYMENT_RECEIVED', payment._id, payment.amountReceived);

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

const queryPayments = async (filter, options) => {
  const { PaymentReceived, Customer } = getBooksCrmModels();
  const { Invoice, Account, Expenses } = getBooksModels();
  const { User } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  if (filter.depositToAccountId) {
    query.depositToAccountId = new mongoose.Types.ObjectId(filter.depositToAccountId);
  }

  if (filter.appName) {
    query.appName = filter.appName;
  }

  if (filter.isPendingMapping) {
    query.unusedAmount = { $gt: 0 };
    query.status = PAYMENT_STATUS.APPROVED;
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'paymentDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  if (filter.paymentMode?.split(',').length > 0) {
    query.paymentMode = { $in: filter.paymentMode.split(',') };
  }
  // Status filtering
  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) query.addedBy = { $in: addedByIds };
  }

  // Search filter
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    const matchingAccounts = await Account.find({
      companyId,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      $or: [{ accountName: searchRegex }, { 'bankDetails.bankName': searchRegex }],
    }).select('_id');

    const [customers, invoices, expenses] = await Promise.all([
      Customer.find({
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      }).select('_id'),
      Invoice.find({ invoiceId: searchRegex }).select('_id'),
      Expenses.find({ companyId, expenseId: searchRegex }).select('_id').lean(),
    ]);

    const customerIds = customers.map(c => c._id);
    const invoiceIds = invoices.map(inv => inv._id);
    const expenseIds = expenses.map(expense => expense._id);
    const depositAccountIds = matchingAccounts.map(account => account._id);

    query.$or = [
      { reference: searchRegex },
      { paymentReceivedId: searchRegex },
      { paymentMode: searchRegex },
      { 'invoices.invoiceId': { $in: invoiceIds } },
      { 'expenses.expenseId': { $in: expenseIds } },
      { customerId: { $in: customerIds } },
      { depositToAccountId: { $in: depositAccountIds } },
    ];
  }

  if (filter?.customerId) {
    const customerIds = filter.customerId
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));

    if (customerIds.length > 0) {
      query.customerId = { $in: customerIds };
    }
  }

  // Country/State/City filters apply to the customer's billing address
  const addressCondition = await getBillingLocationCondition(Customer, companyId, filter, 'customerId');
  if (addressCondition) {
    (query.$and ||= []).push(addressCondition);
  }

  if (filter?.isSplit == undefined) {
    query.isSplit = false;
  }
  if (filter?.isSplit) {
    query.isSplit = true;
  }
  if (options?.countOnly) {
    return { results: [], totalResults: await PaymentReceived.countDocuments(query) };
  }

  // Optional: remove populate if you're doing manual population
  // delete options.populate;
  options.populate = `divisionId:name,branchId:name,warehouseId:name`;

  // Get paginated results
  const result = await PaymentReceived.paginateWithTotal(query, options);

  // Extract unique customer and invoice IDs
  const customerIds = [...new Set(result.results.map(p => p.customerId?.toString()).filter(Boolean))];
  const addedByIds = [...new Set(result.results.map(p => p.addedBy))];
  const updatedByIds = [...new Set(result.results.map(p => toUpdatedByUserIdString(p.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  const depositAccountIds = [...new Set(result.results.map(p => p.depositToAccountId?.toString()).filter(Boolean))];
  const invoiceIds = [...new Set(result.results.flatMap(p => p.invoices?.map(i => i.invoiceId?.toString())).filter(Boolean))];

  // Fetch related documents
  const [customerList, invoiceList, depositAccountList, userList] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } })
      .select('customerDisplayName')
      .lean(),
    Invoice.find({ _id: { $in: invoiceIds } })
      .select('invoiceId invoiceDate dueDate total balanceAmount')
      .lean(),

    Account.find({ _id: { $in: depositAccountIds } })
      .select('accountName')
      .lean(),
    User.find({ _id: { $in: userIds } })
      .select('firstName lastName')
      .lean(),
  ]);

  const customerMap = customerList.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const invoiceMap = invoiceList.reduce((acc, inv) => {
    acc[inv._id.toString()] = inv;
    return acc;
  }, {});

  const depositAccountMap = depositAccountList.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const userMap = userList.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});
  // Populate customer and invoice info
  const populatedResults = result.results.map(payment => {
    const obj = payment.toObject();
    obj.id = obj._id;

    obj.customerId = customerMap[obj.customerId?.toString()] || null;
    obj.depositToAccountId = depositAccountMap[obj.depositToAccountId?.toString()] || null;
    obj.addedBy = userMap[obj.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(obj.updatedBy);
    const updatedBy = updatedById ? userMap[updatedById] : null;
    obj.updatedBy = updatedBy || null;
    if (Array.isArray(obj.invoices)) {
      obj.invoices = obj.invoices.map(i => {
        const invoiceDetails = invoiceMap[i.invoiceId?.toString()];
        return {
          ...i,
          invoiceId: invoiceDetails ? { _id: i.invoiceId, ...invoiceDetails } : i.invoiceId,
        };
      });
    }

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

  const pendingMappingCount = await PaymentReceived.countDocuments(approvedAdvancePendingFilter);

  return {
    ...result,
    pendingMappingCount,
    results: await enrichDocumentCurrency(String(filter.companyId), populatedResults),
  };
};

const queryPaymentsExports = async (filter, options) => {
  const result = await queryPayments(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getPaymentById = async (id, companyId) => {
  const { PaymentReceived, Customer, Branch, Division, Warehouse, OpeningBalanceTransaction } = getBooksCrmModels();
  const { Invoice, Expenses } = getBooksModels();
  const { User } = getCommonModels();

  // Get payment without population
  const payment = await PaymentReceived.findOne({ _id: id, companyId });
  if (!payment) {
    throw new ApiError(httpStatus.NOT_FOUND, PAYMENT_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  // Get customer data
  const customer = await Customer.findById(payment.customerId).select('customerDisplayName isCustomerDirectTax').lean();

  // Get invoice data
  const invoiceIds = (payment.invoices || []).map(inv => inv.invoiceId).filter(Boolean);
  const invoices = await Invoice.find(
    { _id: { $in: invoiceIds } },
    {
      invoiceId: 1,
      invoiceDate: 1,
      dueDate: 1,
      total: 1,
      balanceAmount: 1,
      branchId: 1,
    },
  ).lean();

  // Create invoice lookup map
  const invoiceMap = invoices.reduce((acc, invoice) => {
    acc[invoice._id.toString()] = invoice;
    return acc;
  }, {});

  // Legacy docs (no field): treat as cross-branch only if a mapped invoice is from another branch.
  const paymentBranchId = payment.branchId?.toString();
  const allowCrossBranchMapping =
    typeof payment.allowCrossBranchMapping === 'boolean'
      ? payment.allowCrossBranchMapping
      : invoices.some(inv => inv.branchId && paymentBranchId && inv.branchId.toString() !== paymentBranchId);
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (payment.commentHistory?.length) {
    const userIds = payment.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = payment.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  const addedBy = await User.findById(payment.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(payment.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const approvedBy = await User.findById(payment.approvedBy).select('firstName lastName email phone');
  const approvalDate = payment.approvalDate;
  const branch = await Branch.findById(payment.branchId).select('name');
  const division = await Division.findById(payment.divisionId).select('name');
  const warehouse = await Warehouse.findById(payment.warehouseId).select('name');

  // Convert payment to object and populate data
  const paymentObj = payment.toObject();
  paymentObj.addedBy = addedBy;
  paymentObj.updatedBy = updatedBy;
  paymentObj.approvedBy = approvedBy;
  paymentObj.approvalDate = approvalDate;
  paymentObj.commentHistory = commentHistoryWithUser;
  paymentObj.customerId = customer || null;

  const { Account } = getBooksModels();
  paymentObj.depositToAccountId = payment.depositToAccountId
    ? await Account.findById(payment.depositToAccountId).select('accountName accountCode').lean()
    : null;
  paymentObj.tdsAccountId = payment.tdsAccountId
    ? await Account.findById(payment.tdsAccountId).select('accountName accountCode').lean()
    : null;

  paymentObj.branchId = branch ? { _id: branch._id, name: branch.name } : null;
  paymentObj.branchName = branch?.name || null;
  paymentObj.divisionId = division ? { _id: division._id, name: division.name } : null;
  paymentObj.warehouseId = warehouse ? { _id: warehouse._id, name: warehouse.name } : null;

  paymentObj.createdAt = payment.createdAt;
  paymentObj.updatedAt = payment.updatedAt;

  paymentObj.invoices = (paymentObj.invoices || []).map(inv => ({
    ...inv,
    invoiceId: invoiceMap[inv.invoiceId?.toString()] || null,
  }));
  paymentObj.allowCrossBranchMapping = allowCrossBranchMapping;

  if (payment.openingBalanceTransactions?.length) {
    const ids = payment.openingBalanceTransactions.map(l => l.openingBalanceTransactionId).filter(Boolean);

    const docs = await OpeningBalanceTransaction.find({ _id: { $in: ids } })
      .select('transactionNo date amount remainingAmount type branchId')
      .lean();

    paymentObj.openingBalanceTransactions = payment.openingBalanceTransactions.map(line => {
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

  if (payment.expenses.length) {
    const expenseIds = payment.expenses.map(line => line.expenseId);
    const expenses = await Expenses.find({ _id: { $in: expenseIds } })
      .select('expenseId date total balanceAmount billableStatus branchId')
      .lean();
    const expenseById = new Map(expenses.map(expense => [String(expense._id), expense]));
    paymentObj.expenses = paymentObj.expenses.map(line => ({
      ...line,
      expenseId: expenseById.get(String(line.expenseId)),
    }));
  }

  paymentObj.id = paymentObj._id;
  paymentObj.moduleTree = await buildModuleTree(id);

  return enrichDocumentCurrency(companyId, paymentObj);
};

const updatePaymentById = async (paymentReceivedId, updateBody, userId, uploadedFiles = []) => {
  const { PaymentReceived, Customer, OpeningBalanceTransaction } = getBooksCrmModels();
  const { Invoice, Expenses } = getBooksModels();
  const { UserRole } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { customerId, branchId, companyId } = updateBody;

    const payment = await PaymentReceived.findOne({ _id: paymentReceivedId, companyId }).session(session);
    if (!payment) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: payment.attachments ? payment.attachments : [],
      userId,
      companyId: payment.companyId,
    });

    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(customerId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(customerId, branchId, session);
    }

    if (updateBody.allowCrossBranchMapping !== undefined) {
      updateBody.allowCrossBranchMapping = coerceBoolean(updateBody.allowCrossBranchMapping);
    }

    if (!updateBody?.isAdvancePayment) {
      for (let i of updateBody?.invoices || []) {
        const invoice = await Invoice.findById(i.invoiceId).session(session);

        if (!invoice) {
          throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found');
        }

        if (payment.currency && invoice.currency && String(payment.currency) !== String(invoice.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
        }

        const previousPaymentReceive = await PaymentReceived.find({
          'invoices.invoiceId': i.invoiceId,
          status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
        }).session(session);

        let totalAppliedAmount = previousPaymentReceive.reduce((sum, pr) => {
          const invoiceAmount = (pr.invoices || [])
            .filter(inv => String(inv.invoiceId) === String(i.invoiceId))
            .reduce((invoiceSum, inv) => invoiceSum + (Number(inv.amountApplied) || 0) + (Number(inv.tdsAmount) || 0), 0);

          return sum + invoiceAmount;
        }, 0);

        const oldInvoice = payment.invoices.find(inv => inv.invoiceId.toString() === i.invoiceId.toString());

        const oldAppliedAmount = (Number(oldInvoice?.amountApplied) || 0) + (Number(oldInvoice?.tdsAmount) || 0);
        totalAppliedAmount -= oldAppliedAmount;

        const remainingAmount = parseFloat((invoice.total - totalAppliedAmount).toFixed(2));

        if (remainingAmount <= 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `An unapproved payment is already linked to invoice:${invoice.invoiceId} . Please clear it before mapping another payment.`,
          );
        }

        const settledAmount = parseFloat((Number(i.amountApplied) + Number(i.tdsAmount || 0)).toFixed(2));
        if (settledAmount > remainingAmount) {
          const sym = (await getCurrency(payment.companyId, invoice.currency || payment.currency))?.symbol || '₹';
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Payment amount exceeds invoice limit. You can apply only ${sym}${remainingAmount} more to invoice ${invoice.invoiceId}.`,
          );
        }
      }
      for (let ob of updateBody?.openingBalanceTransactions || []) {
        const txn = await OpeningBalanceTransaction.findById(ob.openingBalanceTransactionId).select('currency').session(session);
        if (txn?.currency && payment.currency && String(payment.currency) !== String(txn.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
        }
      }
      for (const line of updateBody?.expenses || []) {
        const expense = await Expenses.findOne({
          _id: line.expenseId,
          companyId,
          party: payment.customerId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          isBillable: true,
        }).session(session);
        if (!expense) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'Only billable expenses of this customer can be applied with payment received',
          );
        }

        const previousPayments = await PaymentReceived.find({
          companyId,
          _id: { $ne: payment._id },
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
    const newPaymentMode = updateBody.paymentMode || payment.paymentMode;

    if (updateBody.depositToAccountId) {
      const { Account } = getBooksModels();
      const depositToAccount = await Account.findOne({
        _id: updateBody.depositToAccountId,
        companyId: payment.companyId,
        isActive: true,
        category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      }).session(session);
      if (!depositToAccount) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Deposit to account not found or not a valid payment account');
      }
    }
    if (updateBody.taxDeducted) {
      const { Account } = getBooksModels();
      const tdsAccount = await Account.findOne({
        _id: updateBody.tdsAccountId,
        companyId: payment.companyId,
        isActive: true,
        category: ACCOUNT_CATEGORIES.OTHER_CURRENT_ASSET.code,
      }).session(session);
      if (!tdsAccount) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'TDS account not found or not a valid TDS account');
      }
    }
    if (payment.status !== PAYMENT_STATUS.PENDING) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only pending payments can be edited');
    }
    // Store old amount for comparison
    const oldAmount = payment.amountReceived;
    const newAmount = updateBody.amountReceived;

    const previousPaymentMode = payment.paymentMode;
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;
    Object.assign(payment, updateBody);

    if (payment.isAdvancePayment) {
      payment.invoices = [];
      payment.openingBalanceTransactions = [];
      payment.expenses = [];
      payment.unusedAmount = Number(payment.amountReceived) || 0;
    } else {
      payment.invoices = Array.isArray(updateBody.invoices) ? updateBody.invoices : [];
      payment.openingBalanceTransactions = Array.isArray(updateBody.openingBalanceTransactions)
        ? updateBody.openingBalanceTransactions
        : [];
      payment.expenses = updateBody.expenses || [];

      const totalInvoicesApplied = payment.invoices.reduce((sum, inv) => sum + (Number(inv.amountApplied) || 0), 0) || 0;
      const totalObApplied =
        payment.openingBalanceTransactions.reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) || 0;
      const totalExpensesApplied = payment.expenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedTotal = totalInvoicesApplied + totalObApplied + totalExpensesApplied;
      const paymentTotal = Number(payment.amountReceived) || 0;

      if (appliedTotal > paymentTotal) {
        const hasInvoices = Array.isArray(payment.invoices) && payment.invoices.length > 0;
        const hasOb = Array.isArray(payment.openingBalanceTransactions) && payment.openingBalanceTransactions.length > 0;
        const appliedTargetLabel = hasInvoices && !hasOb && totalExpensesApplied <= 0 ? 'invoices' : 'documents';
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Total amount applied to ${appliedTargetLabel} cannot exceed the amount received.`,
        );
      }

      payment.unusedAmount = paymentTotal > appliedTotal ? paymentTotal - appliedTotal : 0;
    }
    payment.attachments = allAttachments;
    payment.updatedBy = userId;

    if (payment.paymentMode === PAYMENT_MODES.CHEQUE) {
      const switchedToCheque = previousPaymentMode !== PAYMENT_MODES.CHEQUE;
      const statusMissing = !payment.chequeStatus || payment.chequeStatus === CHEQUE_STATUS.NONE;
      if (switchedToCheque || statusMissing) {
        payment.chequeStatus = CHEQUE_STATUS.PENDING;
      }
    } else {
      payment.chequeStatus = CHEQUE_STATUS.NONE;
    }

    const currencyDoc = await getCurrency(payment.companyId, payment.currency);

    // Add comment to history based on what was updated
    let commentMessage = payment.isAdvancePayment ? 'Advance Payment Received Updated' : 'Payment Received Updated';

    if (newAmount !== undefined && newAmount !== oldAmount) {
      commentMessage = payment.isAdvancePayment
        ? `Advance payment amount changed from ${currencyDoc?.symbol || '₹'}${oldAmount} to ${currencyDoc?.symbol || '₹'}${newAmount}`
        : `Amount changed from ${currencyDoc?.symbol || '₹'}${oldAmount} to ${currencyDoc?.symbol || '₹'}${newAmount}`;
    }

    payment.commentHistory.push({
      message: commentMessage,
      addedBy: userId,
      createdAt: new Date(),
    });

    await payment.save({ session });

    await session.commitTransaction();

    processIncentiveEarn(payment.companyId, userId, 'PAYMENT_RECEIVED', payment._id, payment.amountReceived);

    sendTransactionNotification({
      customerId: payment.customerId,
      companyId: payment.companyId,
      notificationType: NOTIFICATION_TYPE.PAYMENT_RECEIVED_UPDATED,
      entityId: payment._id,
      entityDisplayId: payment.paymentReceivedId,
      triggeredByUserId: userId,
    });

    return enrichDocumentCurrency(payment.companyId, payment.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deletePaymentById = async (paymentReceivedId, companyId, userId) => {
  const { PaymentReceived, OpeningBalanceTransaction } = getBooksCrmModels();
  const { Invoice, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const payment = await PaymentReceived.findOne({ _id: paymentReceivedId, companyId }).session(session);
    if (!payment) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
    }
    const { branchId, customerId, amountReceived } = payment;

    if (payment?.isAdvancePayment && payment?.invoices?.length > 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'This payment receive cannot be deleted because it has already been applied to an invoice.',
      );
    }

    const status = payment.status;
    let amount = 0;

    if (status == PAYMENT_STATUS.APPROVED) {
      if (!payment.isAdvancePayment && payment.invoices?.length > 0) {
        for (const { invoiceId, amountApplied, tdsAmount } of payment.invoices) {
          if (!invoiceId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid invoice data in payment');
          }

          const invoice = await Invoice.findById(invoiceId).session(session);
          if (!invoice) {
            throw new ApiError(httpStatus.NOT_FOUND, `Invoice not found: ${invoiceId}`);
          }

          await updateInvoicePaymentStatus(invoice._id, -(amountApplied + (tdsAmount || 0)), userId, session);

          await countPaymentsDaysByStatus(invoiceId, paymentReceivedId, session);
        }
      }
      if (payment.openingBalanceTransactions?.length > 0) {
        for (const { openingBalanceTransactionId, amountApplied } of payment.openingBalanceTransactions) {
          if (!openingBalanceTransactionId || amountApplied == null || amountApplied <= 0) continue;
          const obReverted = await OpeningBalanceTransaction.findOneAndUpdate(
            { _id: openingBalanceTransactionId, companyId: payment.companyId },
            {
              $inc: { remainingAmount: amountApplied },
              $pull: { paymentReceivedEntries: { paymentReceivedId: payment._id } },
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
          { Invoice, Bill: null, OpeningBalanceTransaction, Expenses },
          session,
        );
        // Refunds already moved the balance back, so only the unused amount is still credit.
        const unusedForBalance = Number(payment.unusedAmount || 0);
        await allocatePaymentBranchBalances({
          customerId,
          paymentBranchId: branchId,
          unusedAmount: unusedForBalance,
          applications,
          session,
          reverse: true,
        });
      }
      //add as it is already deducted
      amount = payment.amountReceived;

      // Remove journals for this payment and every refund / invoice / OB line it posted.
      const ledgerSourceIds = [
        payment._id,
        ...(payment.refunds || []).map(refund => refund._id),
        ...(payment.invoices || []).map(line => line._id),
        ...(payment.openingBalanceTransactions || []).map(line => line._id),
      ];
      for (const sourceId of ledgerSourceIds) {
        await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId }, session);
      }
    }

    await PaymentReceived.findByIdAndDelete(paymentReceivedId, { session });

    await session.commitTransaction();

    cancelIncentiveLog(paymentReceivedId);

    sendTransactionNotification({
      customerId: payment.customerId,
      companyId: payment.companyId,
      notificationType: NOTIFICATION_TYPE.PAYMENT_RECEIVED_DELETED,
      entityId: payment._id,
      entityDisplayId: payment.paymentReceivedId,
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const approvePaymentReceivedById = async (
  paymentReceivedId,
  companyId,
  approvalNote,
  userId,
  chequeReceivedDate = null,
  depositDate = null,
  clearingDate = null,
  chequeApprovalNote,
) => {
  const { PaymentReceived, Customer, OpeningBalanceTransaction } = getBooksCrmModels();
  const { Invoice, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const payment = await PaymentReceived.findOne({ _id: paymentReceivedId, companyId }).session(session);

    if (!payment) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
    }

    if (payment.status === PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment is already approved');
    }

    if (payment.status !== PAYMENT_STATUS.PENDING) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only pending payments can be approved');
    }

    const { customerId, branchId, amountReceived } = payment;

    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(customerId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(customerId, branchId, session);
    }

    if (
      payment.paymentMode === PAYMENT_MODES.CHEQUE &&
      payment.status === PAYMENT_STATUS.PENDING &&
      payment.chequeStatus === CHEQUE_STATUS.PENDING
    ) {
      payment.chequeStatus = CHEQUE_STATUS.RECEIVED;
      if (chequeReceivedDate) {
        payment.chequeReceivedDate = chequeReceivedDate;
      }
      if (approvalNote !== undefined) {
        payment.approvalNote = approvalNote;
      }
      if (chequeApprovalNote !== undefined) {
        payment.chequeApprovalNote = chequeApprovalNote;
      }
      const chequeReceivedMessageParts = ['Cheque marked as Received'];
      if (chequeApprovalNote) {
        chequeReceivedMessageParts.push(`cheque ApprovalNote: ${chequeApprovalNote}`);
      }
      if (payment.chequeReceivedDate) {
        chequeReceivedMessageParts.push(`Date: ${new Date(payment.chequeReceivedDate).toLocaleDateString('en-GB')}`);
      }
      payment.commentHistory.push({
        message: `${chequeReceivedMessageParts.join('. ')}.`,
        addedBy: userId,
        createdAt: new Date(),
      });

      await payment.save({ session });
      await session.commitTransaction();
      return enrichDocumentCurrency(companyId, payment.toJSON());
    }

    if (
      payment.paymentMode === PAYMENT_MODES.CHEQUE &&
      payment.status === PAYMENT_STATUS.PENDING &&
      payment.chequeStatus === CHEQUE_STATUS.RECEIVED
    ) {
      payment.chequeStatus = CHEQUE_STATUS.DEPOSITED;
      if (depositDate) {
        payment.depositDate = depositDate;
      }
      if (approvalNote !== undefined) {
        payment.approvalNote = approvalNote;
      }
      if (chequeApprovalNote !== undefined) {
        payment.chequeApprovalNote = chequeApprovalNote;
      }
      const chequeDepositedMessageParts = ['Cheque marked as Deposited'];
      if (chequeApprovalNote) {
        chequeDepositedMessageParts.push(`cheque ApprovalNote: ${chequeApprovalNote}`);
      }
      if (payment.depositDate) {
        chequeDepositedMessageParts.push(`Date: ${new Date(payment.depositDate).toLocaleDateString('en-GB')}`);
      }
      payment.commentHistory.push({
        message: `${chequeDepositedMessageParts.join('. ')}.`,
        addedBy: userId,
        createdAt: new Date(),
      });

      await payment.save({ session });
      await session.commitTransaction();
      return enrichDocumentCurrency(companyId, payment.toJSON());
    }

    let chequeCommentMessage = null;
    if (
      payment.paymentMode === PAYMENT_MODES.CHEQUE &&
      payment.status === PAYMENT_STATUS.PENDING &&
      payment.chequeStatus === CHEQUE_STATUS.DEPOSITED
    ) {
      payment.chequeStatus = CHEQUE_STATUS.CLEARED;
      if (clearingDate) {
        payment.clearingDate = clearingDate;
      }
      if (approvalNote !== undefined) {
        payment.approvalNote = approvalNote;
      }
      if (chequeApprovalNote !== undefined) {
        payment.chequeApprovalNote = chequeApprovalNote;
      }
      const chequeClearedMessageParts = ['Cheque marked as Cleared'];
      if (chequeApprovalNote) {
        chequeClearedMessageParts.push(`cheque ApprovalNote: ${chequeApprovalNote}`);
      }
      if (payment.clearingDate) {
        chequeClearedMessageParts.push(`Date: ${new Date(payment.clearingDate).toLocaleDateString('en-GB')}`);
      }
      chequeCommentMessage = `${chequeClearedMessageParts.join('. ')}.`;
    }

    payment.status = PAYMENT_STATUS.APPROVED;

    const currencyDoc = await getCurrency(companyId, payment.currency);

    if (approvalNote !== undefined) {
      payment.approvalNote = approvalNote;
    }

    const approvalMessage = payment.isAdvancePayment
      ? `Advance Payment Received Approved with amount ${currencyDoc?.symbol || '₹'}${amountReceived}`
      : `Payment Received Approved with amount ${currencyDoc?.symbol || '₹'}${amountReceived}`;

    payment.commentHistory.push({
      message: chequeCommentMessage ? `${approvalMessage}. ${chequeCommentMessage}` : `${approvalMessage}.`,
      addedBy: userId,
      createdAt: new Date(),
    });
    if (!payment.isAdvancePayment) {
      if (payment.invoices?.length > 0) {
        for (const { invoiceId, amountApplied, tdsAmount } of payment.invoices || []) {
          if (!invoiceId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid invoice data in payment');
          }

          const invoice = await Invoice.findById(invoiceId).session(session);
          if (!invoice) {
            throw new ApiError(httpStatus.NOT_FOUND, `Invoice not found: ${invoiceId}`);
          }

          if (payment.currency && invoice.currency && String(payment.currency) !== String(invoice.currency)) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
          }

          // TDS the customer withheld settles the invoice along with the cash.
          const settledAmount = parseFloat((amountApplied + (tdsAmount || 0)).toFixed(2));
          if (settledAmount > parseFloat(invoice.balanceAmount.toFixed(2))) {
            throw new ApiError(
              httpStatus.BAD_REQUEST,
              `You cannot apply more than the due amount for invoice (${invoice.invoiceId || invoice._id})`,
            );
          }
          await updateInvoicePaymentStatus(invoice._id, settledAmount, userId, session);

          await countPaymentsDaysByStatus(invoiceId, paymentReceivedId, session);
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
            if (txn.type !== TRANSACTION_TYPE.OPENING_RECEIVABLE) {
              throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening receivable can be applied with payment received');
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
                  paymentReceivedEntries: {
                    entrySource: OB_PAYMENT_ENTRY_SOURCE.PAYMENT_RECEIVED,
                    paymentReceivedId: payment._id,
                    paymentDocumentNo: payment.paymentReceivedId,
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
        { Invoice, Bill: null, OpeningBalanceTransaction, Expenses },
        session,
      );
      await allocatePaymentBranchBalances({
        customerId,
        paymentBranchId: branchId,
        unusedAmount: Number(payment.unusedAmount || 0),
        applications,
        session,
        reverse: false,
      });
    }

    // Post Dr bank / Cr AR + unearned in payment currency; appliedAt uses each invoice rate for correct clearing and FX.
    {
      const appliedTotal =
        (payment.invoices || []).reduce((sum, inv) => sum + (Number(inv.amountApplied) || 0), 0) +
        (payment.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        payment.expenses.reduce((sum, line) => sum + line.amountApplied, 0);

      const appliedAt = await ledgerService.buildAppliedAt(payment, session);
      await ledgerService.postPaymentReceivedJournal(
        {
          companyId: payment.companyId,
          depositAccountId: payment.depositToAccountId,
          appliedAmount: appliedTotal,
          unusedAmount: payment.unusedAmount,
          partyId: payment.customerId,
          postingDate: payment.paymentDate,
          sourceId: payment._id,
          narration: `Payment received ${payment.paymentReceivedId}`,
          addedBy: userId,
          isSplit: payment.isSplit,
          currencyId: payment.currency,
          exchangeRate: payment.exchangeRate,
          appliedAt,
        },
        session,
      );
    }

    payment.approvedBy = userId;
    payment.approvalDate = new Date();
    await payment.save({ session });

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: payment.customerId,
      companyId: payment.companyId,
      notificationType: NOTIFICATION_TYPE.PAYMENT_RECEIVED_STATUS_CHANGED,
      entityId: payment._id,
      entityDisplayId: payment.paymentReceivedId,
      triggeredByUserId: userId,
      newStatus: 'Approved',
    });

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

const rejectPaymentReceivedById = async (
  paymentReceivedId,
  companyId,
  notes,
  userId,
  chequeReceivedDate = null,
  depositDate = null,
  clearingDate = null,
  chequeApprovalNote,
  approvalNote,
) => {
  const { PaymentReceived } = getBooksCrmModels();

  const payment = await PaymentReceived.findOne({ _id: paymentReceivedId, companyId });
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
  if (chequeReceivedDate) {
    payment.chequeReceivedDate = chequeReceivedDate;
  }
  if (depositDate) {
    payment.depositDate = depositDate;
  }
  if (clearingDate) {
    payment.clearingDate = clearingDate;
  }
  if (chequeApprovalNote !== undefined) {
    payment.chequeApprovalNote = chequeApprovalNote;
  }

  const rejectMessageParts = [`Payment Received Rejected with amount ${currencyDoc?.symbol || '₹'}${payment.amountReceived}`];
  if (chequeApprovalNote) {
    rejectMessageParts.push(`cheque ApprovalNote: ${chequeApprovalNote}`);
  }
  const chequeDate = clearingDate || depositDate || chequeReceivedDate;
  if (chequeDate) {
    rejectMessageParts.push(`Date: ${new Date(chequeDate).toLocaleDateString('en-GB')}`);
  }

  payment.commentHistory.push({
    message: `${rejectMessageParts.join('. ')}.`,
    addedBy: userId,
    createdAt: new Date(),
  });

  await payment.save();

  cancelIncentiveLog(payment._id);

  sendTransactionNotification({
    customerId: payment.customerId,
    companyId: payment.companyId,
    notificationType: NOTIFICATION_TYPE.PAYMENT_RECEIVED_STATUS_CHANGED,
    entityId: payment._id,
    entityDisplayId: payment.paymentReceivedId,
    triggeredByUserId: userId,
    newStatus: 'Rejected',
  });

  return enrichDocumentCurrency(companyId, payment.toJSON());
};

const cancelPaymentReceivedById = async (paymentReceivedId, companyId, notes, userId) => {
  const { PaymentReceived, OpeningBalanceTransaction } = getBooksCrmModels();
  const { Invoice, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const payment = await PaymentReceived.findOne({ _id: paymentReceivedId, companyId }).session(session);
    const { branchId, customerId, amountReceived } = payment;
    if (!payment) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
    }

    const currencyDoc = await getCurrency(companyId, payment.currency);

    if (payment.status === PAYMENT_STATUS.CANCELLED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment is already cancelled');
    }

    if (notes !== undefined) {
      payment.approvalNote = notes;
    }
    // Revert branch balance and invoice only when payment was APPROVED (balance was reduced on approve)
    if (payment.status === PAYMENT_STATUS.APPROVED) {
      if (payment.isAdvancePayment && payment.invoices?.length > 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'This payment receive cannot be deleted because it has already been applied to an invoice.',
        );
      }

      if (!payment.isAdvancePayment && payment.invoices?.length > 0) {
        for (const { invoiceId, amountApplied, tdsAmount } of payment.invoices) {
          if (!invoiceId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid invoice data in payment');
          }

          const invoice = await Invoice.findById(invoiceId).session(session);
          if (!invoice) {
            throw new ApiError(httpStatus.NOT_FOUND, `Invoice not found: ${invoiceId}`);
          }
          await cancelInvoicePayment(invoice._id, amountApplied + (tdsAmount || 0), userId, session);
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
          { Invoice, Bill: null, OpeningBalanceTransaction, Expenses },
          session,
        );
        // Refunds already moved the balance back, so only the unused amount is still credit.
        const unusedForBalance = Number(payment.unusedAmount || 0);
        await allocatePaymentBranchBalances({
          customerId,
          paymentBranchId: branchId,
          unusedAmount: unusedForBalance,
          applications,
          session,
          reverse: true,
        });
      }

      // Remove journals for this payment and every refund / invoice / OB line it posted.
      const ledgerSourceIds = [
        payment._id,
        ...(payment.refunds || []).map(refund => refund._id),
        ...(payment.invoices || []).map(line => line._id),
        ...(payment.openingBalanceTransactions || []).map(line => line._id),
      ];
      for (const sourceId of ledgerSourceIds) {
        await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId }, session);
      }
    }

    payment.status = PAYMENT_STATUS.CANCELLED;

    payment.commentHistory.push({
      message: `Payment Received Cancelled with amount ${currencyDoc?.symbol || '₹'}${amountReceived}`,
      addedBy: userId,
      createdAt: new Date(),
    });
    await payment.save({ session });

    await session.commitTransaction();

    cancelIncentiveLog(payment._id);

    sendTransactionNotification({
      customerId: payment.customerId,
      companyId: payment.companyId,
      notificationType: NOTIFICATION_TYPE.PAYMENT_RECEIVED_STATUS_CHANGED,
      entityId: payment._id,
      entityDisplayId: payment.paymentReceivedId,
      triggeredByUserId: userId,
      newStatus: 'Cancelled',
    });

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

const deletePaymentReceiveInvoice = async (paymentReceivedId, companyId, body, userId) => {
  const { PaymentReceived, Customer } = getBooksCrmModels();
  const { Invoice, Expenses } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { invoices = [], expenses = [] } = body;
    const paymentReceived = await PaymentReceived.findOne({ _id: paymentReceivedId, companyId }).session(session);

    if (!paymentReceived) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');
    }

    const payloadInvoiceIds = invoices.map(inv => inv.invoiceId.toString());

    const unremovedInvoices = paymentReceived?.invoices.filter(inv => !payloadInvoiceIds.includes(inv.invoiceId.toString()));

    const removedExpenseIds = new Set(expenses.map(line => String(line.expenseId)));
    const removedExpenses = paymentReceived.expenses.filter(line => removedExpenseIds.has(String(line.expenseId)));
    const unremovedExpenses = paymentReceived.expenses.filter(line => !removedExpenseIds.has(String(line.expenseId)));

    const totalAmountReceived =
      unremovedInvoices.reduce((sum, inv) => sum + (inv.amountApplied || 0), 0) +
      unremovedExpenses.reduce((sum, line) => sum + line.amountApplied, 0);

    if (paymentReceived?.status == PAYMENT_STATUS.APPROVED) {
      if (!paymentReceived.isAdvancePayment && invoices?.length > 0) {
        let totalRemovedApplied = 0;
        for (const { invoiceId, amountApplied } of invoices) {
          if (!invoiceId || amountApplied == null || amountApplied < 0) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid invoice data in payment');
          }

          const invoice = await Invoice.findById(invoiceId).session(session);

          if (!invoice) {
            throw new ApiError(httpStatus.NOT_FOUND, `Invoice not found: ${invoiceId}`);
          }

          const storedLine = paymentReceived.invoices.find(inv => String(inv.invoiceId) === String(invoiceId));
          const settledAmount = (Number(amountApplied) || 0) + (Number(storedLine?.tdsAmount) || 0);
          await cancelInvoicePayment(invoice._id, settledAmount, userId, session);

          await invoice.save({ session });

          totalRemovedApplied += Number(amountApplied) || 0;
          await updateBranchCurrentBalance({
            customerId: paymentReceived.customerId,
            branchId: invoice.branchId || paymentReceived.branchId,
            amount: settledAmount,
            session,
          });
        }
      }

      for (const line of removedExpenses) {
        await updateExpensePaymentStatus(line.expenseId, -line.amountApplied, session);
        const expense = await Expenses.findById(line.expenseId).select('branchId').session(session).lean();
        await updateBranchCurrentBalance({
          customerId: paymentReceived.customerId,
          branchId: expense.branchId,
          amount: line.amountApplied,
          session,
        });
      }

      let newCurrentBalance = totalAmountReceived;

      if (newCurrentBalance == paymentReceived.amountReceived) {
        newCurrentBalance = 0;
      }
      if (newCurrentBalance != paymentReceived.amountReceived) {
        newCurrentBalance = totalAmountReceived - paymentReceived.amountReceived;
      }
    }

    await PaymentReceived.updateOne(
      { _id: paymentReceivedId },
      {
        $set: {
          invoices: unremovedInvoices,
          expenses: unremovedExpenses,
          amountReceived: totalAmountReceived,
          updatedBy: userId,
        },
      },
      { session },
    );

    // The payment total itself changed: reverse the old payment journal and
    // post it again with the remaining applied amounts.
    if (paymentReceived.status === PAYMENT_STATUS.APPROVED) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId: paymentReceived._id },
        session,
      );
      const remainingApplied =
        (unremovedInvoices || []).reduce((sum, inv) => sum + (Number(inv.amountApplied) || 0), 0) +
        (paymentReceived.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        unremovedExpenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedAt = await ledgerService.buildAppliedAt(
        {
          invoices: unremovedInvoices,
          openingBalanceTransactions: paymentReceived.openingBalanceTransactions,
          expenses: unremovedExpenses,
          exchangeRate: paymentReceived.exchangeRate,
        },
        session,
      );
      await ledgerService.postPaymentReceivedJournal(
        {
          companyId,
          depositAccountId: paymentReceived.depositToAccountId,
          appliedAmount: remainingApplied,
          unusedAmount:
            paymentReceived.unusedAmount +
            (paymentReceived.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
          partyId: paymentReceived.customerId,
          postingDate: paymentReceived.paymentDate,
          sourceId: paymentReceived._id,
          narration: `Payment received ${paymentReceived.paymentReceivedId}`,
          addedBy: userId,
          isSplit: paymentReceived.isSplit,
          currencyId: paymentReceived.currency,
          exchangeRate: paymentReceived.exchangeRate,
          appliedAt,
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

const applyAdvancePaymentReceivedAgainstInvoice = async (
  paymentReceivedId,
  companyId,
  invoices = [],
  openingBalanceTransactions = [],
  userId = null,
  expenses = [],
) => {
  const { Invoice, Expenses } = getBooksModels();
  const { PaymentReceived, OpeningBalanceTransaction } = getBooksCrmModels();

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentReceived = await PaymentReceived.findOne({
      _id: paymentReceivedId,
      // isAdvancePayment: true,
      companyId,
    }).session(session);

    if (!paymentReceived) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Received not found');
    }

    if (paymentReceived.status !== PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment Received is not approved');
    }

    if (paymentReceived.unusedAmount <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No available balance to apply');
    }

    let totalApplied = 0;
    const invoiceUpdates = [];

    // Each invoice / opening balance may appear only once per request. The validate loops below cache the
    // fetched document, so two lines for the same target would each pass the stale per-line guard and
    // over-apply (driving balanceAmount negative and over-consuming the advance).
    const seenApplicationTargets = new Set();
    for (const { invoiceId } of invoices || []) {
      if (!invoiceId) continue;
      const key = String(invoiceId);
      if (seenApplicationTargets.has(key)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'The same invoice is listed more than once. Please remove the duplicate before applying the payment.',
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

    // Validate and calculate total applied amount for invoices
    for (const { invoiceId, amountApplied } of invoices) {
      const invoice = await Invoice.findById(invoiceId).session(session);
      if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, `Invoice ${invoiceId} not found`);
      }
      if (paymentReceived.currency && invoice.currency && String(paymentReceived.currency) !== String(invoice.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
      }
      if (paymentReceived?.isSplit != invoice?.isSplit) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Split status of invoice ${invoice.invoiceId} does not match with payment received`,
        );
      }
      const pendingMappedPayments = await PaymentReceived.find({
        companyId,
        _id: { $ne: paymentReceivedId },
        isAdvancePayment: false,
        status: PAYMENT_STATUS.PENDING,
        'invoices.invoiceId': invoice._id,
      })
        .select('paymentReceivedId invoices')
        .lean()
        .session(session);

      let pendingReserved = 0;
      let blockingPaymentReceived = null;

      for (const payment of pendingMappedPayments) {
        const paymentAmount = (payment.invoices || [])
          .filter(inv => String(inv.invoiceId) === String(invoice._id))
          .reduce((sum, inv) => sum + Number(inv.amountApplied || 0) + Number(inv.tdsAmount || 0), 0);

        pendingReserved += paymentAmount;

        if (!blockingPaymentReceived) {
          blockingPaymentReceived = payment.paymentReceivedId;
        }
      }

      if (parseFloat((pendingReserved + Number(amountApplied)).toFixed(2)) > parseFloat(invoice.balanceAmount.toFixed(2))) {
        const blockingMsg = blockingPaymentReceived
          ? `already linked with unapproved Payment Received ${blockingPaymentReceived}. Please approve or delete that payment before applying advance payment`
          : `already fully allocated across existing payments`;
        throw new ApiError(httpStatus.BAD_REQUEST, `Invoice ${invoice.invoiceId} is ${blockingMsg}.`);
      }
      if (invoice.balanceAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Amount exceeds balance for invoice ${invoice.invoiceId}`);
      }

      totalApplied = parseFloat((totalApplied + amountApplied).toFixed(2));
      invoiceUpdates.push({ invoice, amountApplied });
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
      if (paymentReceived.currency && txn.currency && String(paymentReceived.currency) !== String(txn.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency payments are not supported.');
      }
      if (String(txn.companyId) !== String(paymentReceived.companyId)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance does not belong to this company');
      }
      if (txn.type !== TRANSACTION_TYPE.OPENING_RECEIVABLE) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening receivable can be applied with payment received');
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
        party: paymentReceived.customerId,
        partyType: LEDGER_PARTY_TYPES.CUSTOMER,
        isBillable: true,
      }).session(session);
      if (!expense) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Only billable expenses of this customer can be applied with payment received',
        );
      }

      const previousPayments = await PaymentReceived.find({
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

    if (totalApplied > paymentReceived.unusedAmount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Total applied amount exceeds unused amount');
    }

    const currencyDoc = await getCurrency(companyId, paymentReceived.currency);

    // Add or update invoices in paymentReceived
    for (const { invoice, amountApplied } of invoiceUpdates) {
      paymentReceived.invoices.push({
        invoiceId: invoice._id,
        invoiceNo: invoice.invoiceId,
        amountApplied,
      });

      paymentReceived.unusedAmount -= amountApplied;
      await moveAdvanceApplyBranchBalances({
        customerId: paymentReceived.customerId,
        paymentBranchId: paymentReceived.branchId,
        documentBranchId: invoice.branchId,
        amount: amountApplied,
        session,
      });
      await updateInvoicePaymentStatus(invoice._id, amountApplied, userId, session);
      await Invoice.updateOne(
        { _id: invoice._id },
        {
          $push: {
            commentHistory: {
              message: `Advance Payment ${paymentReceived.paymentReceivedId} applied for ${currencyDoc?.symbol || '₹'}${amountApplied}`,
              addedBy: userId,
              createdAt: new Date(),
              referenceType: 'PaymentReceived',
              referenceId: paymentReceived._id,
            },
          },
        },
        { session },
      );

      await countPaymentsDaysByStatus(invoice._id, paymentReceivedId, session);
    }

    for (const { txn, amountApplied } of obUpdates) {
      paymentReceived.openingBalanceTransactions = paymentReceived.openingBalanceTransactions || [];
      paymentReceived.openingBalanceTransactions.push({
        openingBalanceTransactionId: txn._id,
        transactionNo: txn.transactionNo,
        amountApplied,
        appliedDate: new Date(),
      });

      paymentReceived.unusedAmount -= amountApplied;
      await moveAdvanceApplyBranchBalances({
        customerId: paymentReceived.customerId,
        paymentBranchId: paymentReceived.branchId,
        documentBranchId: txn.branchId,
        amount: amountApplied,
        session,
      });
      await txn.updateRemainingAmount(amountApplied, session);
      const obPushed = await OpeningBalanceTransaction.findOneAndUpdate(
        { _id: txn._id, companyId: paymentReceived.companyId },
        {
          $push: {
            paymentReceivedEntries: {
              entrySource: OB_PAYMENT_ENTRY_SOURCE.PAYMENT_RECEIVED,
              paymentReceivedId: paymentReceived._id,
              paymentDocumentNo: paymentReceived.paymentReceivedId,
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
      paymentReceived.expenses.push({
        expenseId: expense._id,
        expenseNo: expense.expenseId,
        amountApplied,
        appliedDate: new Date(),
      });

      paymentReceived.unusedAmount -= amountApplied;
      await moveAdvanceApplyBranchBalances({
        customerId: paymentReceived.customerId,
        paymentBranchId: paymentReceived.branchId,
        documentBranchId: expense.branchId,
        amount: amountApplied,
        session,
      });
      await updateExpensePaymentStatus(expense._id, amountApplied, session);
    }

    if (totalApplied > 0) {
      const invoiceAppliedTotal = invoiceUpdates.reduce((sum, { amountApplied }) => sum + amountApplied, 0);
      const obAppliedTotal = obUpdates.reduce((sum, { amountApplied }) => sum + amountApplied, 0);
      const expenseAppliedTotal = expenseUpdates.reduce((sum, { amountApplied }) => sum + amountApplied, 0);
      let message = `Advance payment applied for ${currencyDoc?.symbol || '₹'}${totalApplied}`;

      if (expenseAppliedTotal > 0) {
        if (expenseAppliedTotal === totalApplied) {
          message = `Advance payment applied to expenses for ${currencyDoc?.symbol || '₹'}${expenseAppliedTotal}`;
        }
      } else if (invoiceAppliedTotal > 0 && obAppliedTotal > 0) {
        message = `Advance payment applied to invoices for ${currencyDoc?.symbol || '₹'}${invoiceAppliedTotal} and opening balance for ${currencyDoc?.symbol || '₹'}${obAppliedTotal}`;
      } else if (invoiceAppliedTotal > 0) {
        message = `Advance payment applied to invoices for ${currencyDoc?.symbol || '₹'}${invoiceAppliedTotal}`;
      } else if (obAppliedTotal > 0) {
        message = `Advance payment applied to opening balance for ${currencyDoc?.symbol || '₹'}${obAppliedTotal}`;
      }

      paymentReceived.commentHistory.push({
        message,
        addedBy: userId,
        createdAt: new Date(),
      });
    }

    if (paymentReceived.status === PAYMENT_STATUS.APPROVED) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId: paymentReceived._id },
        session,
      );
      const appliedTotal =
        (paymentReceived.invoices || []).reduce((sum, inv) => sum + (Number(inv.amountApplied) || 0), 0) +
        (paymentReceived.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        paymentReceived.expenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedAt = await ledgerService.buildAppliedAt(paymentReceived, session);
      await ledgerService.postPaymentReceivedJournal(
        {
          companyId,
          depositAccountId: paymentReceived.depositToAccountId,
          appliedAmount: appliedTotal,
          unusedAmount:
            paymentReceived.unusedAmount +
            (paymentReceived.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
          partyId: paymentReceived.customerId,
          postingDate: paymentReceived.paymentDate,
          sourceId: paymentReceived._id,
          narration: `Payment received ${paymentReceived.paymentReceivedId}`,
          addedBy: userId,
          isSplit: paymentReceived.isSplit,
          currencyId: paymentReceived.currency,
          exchangeRate: paymentReceived.exchangeRate,
          appliedAt,
        },
        session,
      );
    }

    await paymentReceived.save({ session });
    await session.commitTransaction();

    return enrichDocumentCurrency(companyId, paymentReceived.toJSON());
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch {}
    throw error;
  } finally {
    await session.endSession();
  }
};

const AUTO_APPLY_INVOICE_STATUSES = [
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.UNPAID,
  INVOICE_STATUS.PARTIALLY_PAID,
  INVOICE_STATUS.OVERDUE,
];

const getInvoiceNosFromPaymentReceived = payment =>
  [...new Set((payment.invoices || []).map(inv => inv.invoiceNo).filter(Boolean))].join(', ');

const buildAutoApplyFailure = (payment, { amountApplied = 0, invoicesToApply = [], invoiceNo, message } = {}) => {
  const paymentInvoiceNo = getInvoiceNosFromPaymentReceived(payment);
  const appliedInvoiceNo = [...new Set((invoicesToApply || []).map(inv => inv.invoiceNo).filter(Boolean))].join(', ');
  const resolvedInvoiceNo = [
    ...new Set(
      String(invoiceNo || paymentInvoiceNo || appliedInvoiceNo)
        .split(',')
        .map(v => v.trim())
        .filter(Boolean),
    ),
  ].join(', ');

  return {
    paymentReceivedId: payment.paymentReceivedId || payment._id,
    invoiceNo: resolvedInvoiceNo,
    invoiceId: payment.invoices?.[0]?.invoiceId || invoicesToApply?.[0]?.invoiceId || null,
    amountApplied,
    message,
  };
};

const getPendingInvoicesForAutoApply = async (Invoice, { companyId, customerId, branchId, isSplit }) => {
  return Invoice.aggregate([
    {
      $match: {
        companyId,
        customerId,
        branchId,
        isSplit: !!isSplit,
        balanceAmount: { $gt: 0 },
        status: { $in: AUTO_APPLY_INVOICE_STATUSES },
      },
    },
    { $project: { _id: 1, dueDate: 1, createdAt: 1, invoiceId: 1 } },
    { $sort: { dueDate: 1, createdAt: 1, _id: 1 } },
  ]);
};

const getPendingOpeningReceivablesForAutoApply = async (OpeningBalanceTransaction, { companyId, customerId, branchId }) => {
  const baseMatch = {
    companyId,
    contactId: customerId,
    contactType: CONTACT_TYPE.CUSTOMER,
    type: TRANSACTION_TYPE.OPENING_RECEIVABLE,
    remainingAmount: { $gt: 0 },
  };

  // Prefer same-branch OB (payment branch), then fall back to any remaining receivable for the customer.
  // Advance payments often use a different/null branch than the customer's opening balance branch.
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

const validateSelectedCustomerAutoApply = async ({
  companyObjectId,
  customerObjectId,
  PaymentReceived,
  Invoice,
  OpeningBalanceTransaction,
}) => {
  const [hasAdvancePayment, hasEligibleInvoice, hasOpeningReceivable] = await Promise.all([
    PaymentReceived.exists({
      companyId: companyObjectId,
      customerId: customerObjectId,
      status: PAYMENT_STATUS.APPROVED,
      unusedAmount: { $gt: 0 },
    }),
    Invoice.exists({
      companyId: companyObjectId,
      customerId: customerObjectId,
      balanceAmount: { $gt: 0 },
      status: { $in: AUTO_APPLY_INVOICE_STATUSES },
    }),
    OpeningBalanceTransaction.exists({
      companyId: companyObjectId,
      contactId: customerObjectId,
      contactType: CONTACT_TYPE.CUSTOMER,
      type: TRANSACTION_TYPE.OPENING_RECEIVABLE,
      remainingAmount: { $gt: 0 },
    }),
  ]);

  const hasEligibleTarget = Boolean(hasEligibleInvoice || hasOpeningReceivable);

  // Advance can be applied to invoices or opening receivables — only block when neither exists.
  if (hasAdvancePayment && !hasEligibleTarget) {
    throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MESSAGES.AUTO_APPLY_ADVANCE_WITHOUT_INVOICE);
  }

  if (hasEligibleTarget && !hasAdvancePayment) {
    throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MESSAGES.AUTO_APPLY_INVOICE_WITHOUT_ADVANCE);
  }

  if (!hasAdvancePayment && !hasEligibleTarget) {
    throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MESSAGES.AUTO_APPLY_NO_INVOICE_OR_ADVANCE);
  }
};

const autoApplyPendingAdvancePayments = async (companyId, userId, customerId) => {
  const { Invoice } = getBooksModels();
  const { PaymentReceived, OpeningBalanceTransaction } = getBooksCrmModels();
  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const customerObjectId = customerId ? new mongoose.Types.ObjectId(customerId) : null;

  if (customerObjectId) {
    await validateSelectedCustomerAutoApply({
      companyObjectId,
      customerObjectId,
      PaymentReceived,
      Invoice,
      OpeningBalanceTransaction,
    });
  }

  const paymentMatch = {
    companyId: companyObjectId,
    status: PAYMENT_STATUS.APPROVED,
    unusedAmount: { $gt: 0 },
    ...(customerObjectId ? { customerId: customerObjectId } : {}),
  };

  const paymentGroups = await PaymentReceived.aggregate([
    {
      $match: paymentMatch,
    },
    {
      $project: {
        _id: 1,
        customerId: 1,
        branchId: 1,
        companyId: 1,
        isSplit: 1,
        createdAt: 1,
      },
    },
    {
      $sort: {
        customerId: 1,
        branchId: 1,
        createdAt: 1,
        _id: 1,
      },
    },
    {
      $group: {
        _id: {
          customerId: '$customerId',
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
      customerObjectId ? PAYMENT_MESSAGES.AUTO_APPLY_NO_INVOICE_OR_ADVANCE : PAYMENT_MESSAGES.AUTO_APPLY_NO_INVOICES,
    );
  }

  let groupsProcessed = 0;
  let mappedPayments = 0;
  let mappedInvoices = 0;
  let totalMappedAmount = 0;
  let attemptedMappings = 0;
  let successfulMappings = 0;
  let failedMappings = 0;
  const failures = [];
  let hasPendingWork = false;

  for (const group of paymentGroups) {
    const { customerId, branchId, companyId: groupCompanyId, isSplit } = group._id;

    const pendingOpeningReceivable = await getPendingOpeningReceivablesForAutoApply(OpeningBalanceTransaction, {
      companyId: groupCompanyId,
      customerId,
      branchId,
    });

    if (pendingOpeningReceivable.length > 0) {
      hasPendingWork = true;
    }

    const paymentsForOb = await PaymentReceived.find({ _id: { $in: group.paymentIds } }).sort({
      createdAt: 1,
      _id: 1,
    });
    const obIdsInOrder = pendingOpeningReceivable.map(ob => ob._id);
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
        await applyAdvancePaymentReceivedAgainstInvoice(payment._id, companyId, [], obToApply, userId);

        paymentUnusedForObMap.set(payment._id.toString(), remainingPayment);
        for (const [obId, deduction] of obDeductions) {
          const prev = obRemainingMap.get(obId) || 0;
          obRemainingMap.set(obId, parseFloat((prev - deduction).toFixed(2)));
        }

        touchedObPaymentIds.add(payment._id.toString());
        totalMappedAmount = parseFloat((totalMappedAmount + totalAppliedForPayment).toFixed(2));
        mappedInvoices += obToApply.length;
        successfulMappings += 1;
      } catch (error) {
        failedMappings += 1;
        if (failures.length < 100) {
          failures.push(
            buildAutoApplyFailure(payment, {
              amountApplied: totalAppliedForPayment,
              message: error?.message || 'Failed to apply advance payment against opening receivable',
            }),
          );
        }
      }
    }

    if (touchedObPaymentIds.size > 0) {
      groupsProcessed += 1;
      mappedPayments += touchedObPaymentIds.size;

      await PaymentReceived.updateMany(
        { _id: { $in: [...touchedObPaymentIds].map(id => new mongoose.Types.ObjectId(id)) } },
        {
          $set: { updatedBy: userId },
          $push: {
            commentHistory: {
              message: 'Auto payment mapping applied against opening receivable balance',
              addedBy: userId,
            },
          },
        },
      );
    }

    const pendingInvoices = await getPendingInvoicesForAutoApply(Invoice, {
      companyId: groupCompanyId,
      customerId,
      branchId,
      isSplit,
    });

    if (!pendingInvoices.length) {
      // Opening receivable with no invoice is a normal result: clear the opening balance and do not warn.
      if (pendingOpeningReceivable.length > 0) {
        continue;
      }

      // Block only when this customer has unused advance and nothing to clear (no invoice and no opening receivable).
      if (customerObjectId) {
        const hasUnusedAdvance = paymentsForOb.some(payment => (paymentUnusedForObMap.get(payment._id.toString()) || 0) > 0);
        if (hasUnusedAdvance) {
          throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_MESSAGES.AUTO_APPLY_ADVANCE_WITHOUT_INVOICE);
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
            buildAutoApplyFailure(payment, {
              amountApplied: remainingUnused,
              invoiceNo: getInvoiceNosFromPaymentReceived(payment),
              message: 'No invoice is available to apply this advance payment.',
            }),
          );
        }
      }
      continue;
    }
    hasPendingWork = true;

    const payments = await PaymentReceived.find({ _id: { $in: group.paymentIds } }).sort({ createdAt: 1, _id: 1 });

    const invoiceIdsInOrder = pendingInvoices.map(inv => inv._id);
    const invoicesFound = await Invoice.find({ _id: { $in: invoiceIdsInOrder } });
    const invoiceMap = new Map(invoicesFound.map(inv => [inv._id.toString(), inv]));
    const orderedInvoices = invoiceIdsInOrder.map(id => invoiceMap.get(id.toString())).filter(Boolean);

    const invoiceRemainingMap = new Map(orderedInvoices.map(inv => [inv._id.toString(), Number(inv.balanceAmount) || 0]));
    const paymentUnusedMap = new Map(payments.map(p => [p._id.toString(), Number(p.unusedAmount) || 0]));

    const touchedPaymentIds = new Set();

    for (const payment of payments) {
      const paymentUnused = paymentUnusedMap.get(payment._id.toString()) || 0;
      if (paymentUnused <= 0) continue;

      const invoicesToApply = [];
      let remainingPayment = paymentUnused;
      const invoiceDeductions = new Map();

      for (const invoice of orderedInvoices) {
        if (remainingPayment <= 0) break;
        const invoiceRemaining = invoiceRemainingMap.get(invoice._id.toString()) || 0;
        if (invoiceRemaining <= 0) continue;

        const amountApplied = parseFloat(Math.min(remainingPayment, invoiceRemaining).toFixed(2));
        if (amountApplied <= 0) continue;

        invoicesToApply.push({ invoiceId: invoice._id, invoiceNo: invoice.invoiceId, amountApplied });
        invoiceDeductions.set(invoice._id.toString(), amountApplied);
        remainingPayment = parseFloat((remainingPayment - amountApplied).toFixed(2));
      }

      if (invoicesToApply.length === 0) continue;

      const totalAppliedForPayment = parseFloat((paymentUnused - remainingPayment).toFixed(2));

      attemptedMappings += 1;
      try {
        await applyAdvancePaymentReceivedAgainstInvoice(payment._id, companyId, invoicesToApply, [], userId);

        paymentUnusedMap.set(payment._id.toString(), remainingPayment);
        for (const [invId, deduction] of invoiceDeductions) {
          const prev = invoiceRemainingMap.get(invId) || 0;
          invoiceRemainingMap.set(invId, parseFloat((prev - deduction).toFixed(2)));
        }

        touchedPaymentIds.add(payment._id.toString());
        totalMappedAmount = parseFloat((totalMappedAmount + totalAppliedForPayment).toFixed(2));
        mappedInvoices += invoicesToApply.length;
        successfulMappings += 1;
      } catch (error) {
        failedMappings += 1;
        if (failures.length < 100) {
          failures.push(
            buildAutoApplyFailure(payment, {
              amountApplied: totalAppliedForPayment,
              invoicesToApply,
              message: error?.message || 'Failed to apply advance payment against invoices',
            }),
          );
        }
      }
    }

    if (touchedPaymentIds.size > 0) {
      groupsProcessed += 1;
      mappedPayments += touchedPaymentIds.size;

      await PaymentReceived.updateMany(
        { _id: { $in: [...touchedPaymentIds].map(id => new mongoose.Types.ObjectId(id)) } },
        {
          $set: { updatedBy: userId },
          $push: {
            commentHistory: {
              message: 'Auto payment mapping applied against pending invoices',
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
      customerObjectId ? PAYMENT_MESSAGES.AUTO_APPLY_NO_INVOICE_OR_ADVANCE : PAYMENT_MESSAGES.AUTO_APPLY_NO_INVOICES,
    );
  }

  // Selected customer: if nothing applied successfully, surface the first failure as a blocking warning.
  if (customerObjectId && attemptedMappings > 0 && successfulMappings === 0 && failedMappings > 0 && failures[0]?.message) {
    throw new ApiError(httpStatus.BAD_REQUEST, failures[0].message);
  }

  const message = failedMappings > 0 ? PAYMENT_MESSAGES.AUTO_APPLY_FAILURE : PAYMENT_MESSAGES.AUTO_APPLY_COMPLETED;

  const success = hasPendingWork && failedMappings === 0;

  return {
    groupsProcessed,
    mappedPayments,
    mappedInvoices,
    totalMappedAmount,
    attemptedMappings,
    successfulMappings,
    failedMappings,
    failures,
    success,
    message,
  };
};

const removeAdvancePaymentReceivedAgainstInvoice = async (paymentReceivedId, companyId, body = {}, userId = null) => {
  const { invoiceId, openingBalanceLineId, expenseLineId } = body;
  if (!invoiceId && !openingBalanceLineId && !expenseLineId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'invoiceId, openingBalanceLineId or expenseLineId is required');
  }

  const { Invoice, Expenses } = getBooksModels();
  const { PaymentReceived, OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const paymentReceived = await PaymentReceived.findOne({
      _id: paymentReceivedId,
      companyId,
    }).session(session);

    if (!paymentReceived) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Received not found');
    }

    const currencyDoc = await getCurrency(companyId, paymentReceived.currency);

    if (paymentReceived.status !== PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment Received is not approved');
    }

    if (openingBalanceLineId) {
      const obLine = (paymentReceived.openingBalanceTransactions || []).find(
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
      paymentReceived.openingBalanceTransactions = (paymentReceived.openingBalanceTransactions || []).filter(
        line => !(line._id && line._id.toString() === String(openingBalanceLineId)),
      );
      paymentReceived.unusedAmount += amountApplied;

      const obTxn = await OpeningBalanceTransaction.findById(obTxnId).select('branchId').session(session).lean();
      await moveAdvanceApplyBranchBalances({
        customerId: paymentReceived.customerId,
        paymentBranchId: paymentReceived.branchId,
        documentBranchId: obTxn?.branchId,
        amount: amountApplied,
        session,
        reverse: true,
      });

      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId: obLine._id },
        session,
      );
      const ok = await OpeningBalanceTransaction.findOneAndUpdate(
        { _id: obTxnId, companyId },
        {
          $inc: { remainingAmount: amountApplied },
          $pull: {
            paymentReceivedEntries: { paymentReceivedId: paymentReceived._id, amountApplied },
          },
        },
        { session, new: true },
      );
      if (!ok) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not revert opening balance for this payment');
      }
      paymentReceived.commentHistory.push({
        message: `Advance payment application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed from opening balance`,
        addedBy: userId,
        createdAt: new Date(),
      });
    } else if (expenseLineId) {
      const expenseLine = paymentReceived.expenses.find(line => String(line._id) === String(expenseLineId));
      if (!expenseLine) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Expense not found in payment received');
      }
      paymentReceived.expenses = paymentReceived.expenses.filter(line => String(line._id) !== String(expenseLineId));
      paymentReceived.unusedAmount += expenseLine.amountApplied;

      const expense = await Expenses.findById(expenseLine.expenseId).select('branchId').session(session).lean();
      await moveAdvanceApplyBranchBalances({
        customerId: paymentReceived.customerId,
        paymentBranchId: paymentReceived.branchId,
        documentBranchId: expense.branchId,
        amount: expenseLine.amountApplied,
        session,
        reverse: true,
      });
      await updateExpensePaymentStatus(expenseLine.expenseId, -expenseLine.amountApplied, session);
      paymentReceived.commentHistory.push({
        message: `Advance payment application of ${currencyDoc?.symbol || '₹'}${expenseLine.amountApplied} removed from expense ${expenseLine.expenseNo}`,
        addedBy: userId,
        createdAt: new Date(),
      });
    } else {
      const invLine = paymentReceived.invoices.find(inv => inv._id.toString() === String(invoiceId));
      if (!invLine) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found in payment received');
      }
      const invoice = await Invoice.findById(invLine.invoiceId).session(session);
      if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found');
      }
      paymentReceived.invoices = paymentReceived.invoices.filter(inv => inv._id.toString() !== String(invoiceId));
      paymentReceived.unusedAmount += invLine.amountApplied;
      const tdsAmount = Number(invLine.tdsAmount) || 0;

      await moveAdvanceApplyBranchBalances({
        customerId: paymentReceived.customerId,
        paymentBranchId: paymentReceived.branchId,
        documentBranchId: invoice.branchId,
        amount: invLine.amountApplied,
        session,
        reverse: true,
      });
      if (tdsAmount > 0) {
        await updateBranchCurrentBalance({
          customerId: paymentReceived.customerId,
          branchId: invoice.branchId || paymentReceived.branchId,
          amount: tdsAmount,
          session,
        });
      }

      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId: invLine._id },
        session,
      );
      paymentReceived.commentHistory.push({
        message: `Advance payment application of ${currencyDoc?.symbol || '₹'}${invLine.amountApplied} removed from invoice ${invLine.invoiceId || invLine.invoiceNo}`,
        addedBy: userId,
        createdAt: new Date(),
      });
      await cancelInvoicePayment(invoice._id, invLine.amountApplied + tdsAmount, userId, session);
      await Invoice.updateOne(
        { _id: invoice._id },
        {
          $push: {
            commentHistory: {
              message: `Advance Payment ${paymentReceived.paymentReceivedId} application of ${currencyDoc?.symbol || '₹'}${invLine.amountApplied} removed`,
              addedBy: userId,
              createdAt: new Date(),
              referenceType: 'PaymentReceived',
              referenceId: paymentReceived._id,
            },
          },
        },
        { session },
      );
    }

    // Save first: the payment journal re-reads the remaining TDS lines from the stored payment.
    await paymentReceived.save({ session });

    if (paymentReceived.status === PAYMENT_STATUS.APPROVED) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId: paymentReceived._id },
        session,
      );
      const remainingApplied =
        (paymentReceived.invoices || []).reduce((sum, inv) => sum + (Number(inv.amountApplied) || 0), 0) +
        (paymentReceived.openingBalanceTransactions || []).reduce((sum, ob) => sum + (Number(ob.amountApplied) || 0), 0) +
        paymentReceived.expenses.reduce((sum, line) => sum + line.amountApplied, 0);
      const appliedAt = await ledgerService.buildAppliedAt(paymentReceived, session);
      await ledgerService.postPaymentReceivedJournal(
        {
          companyId,
          depositAccountId: paymentReceived.depositToAccountId,
          appliedAmount: remainingApplied,
          unusedAmount:
            paymentReceived.unusedAmount +
            (paymentReceived.refunds || []).reduce((sum, refund) => sum + (Number(refund.amountRefunded) || 0), 0),
          partyId: paymentReceived.customerId,
          postingDate: paymentReceived.paymentDate,
          sourceId: paymentReceived._id,
          narration: `Payment received ${paymentReceived.paymentReceivedId}`,
          addedBy: userId,
          isSplit: paymentReceived.isSplit,
          currencyId: paymentReceived.currency,
          exchangeRate: paymentReceived.exchangeRate,
          appliedAt,
        },
        session,
      );
    }

    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, paymentReceived.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const buildModuleTree = async paymentId => {
  const { SalesOrder, PaymentReceived, Quote } = getBooksCrmModels();
  const { DeliveryChallan, Invoice, ProductionOrder } = getBooksModels();

  const moduleTree = { quotes: [] };

  /* ================= PAYMENT ================= */

  const payment = await PaymentReceived.findById(paymentId).select(
    '_id paymentReceivedId paymentDate status amountReceived invoices',
  );

  if (!payment) return moduleTree;

  const paymentNode = {
    id: payment._id,
    paymentReceivedId: payment.paymentReceivedId,
    paymentDate: payment.paymentDate,
    status: payment.status,
    amountReceived: payment.amountReceived,
  };

  /* ================= INVOICES ================= */

  const invoiceIds = payment.invoices?.map(i => i.invoiceId) || [];

  const invoices = await Invoice.find({
    _id: { $in: invoiceIds },
    isSplit: { $ne: true },
  }).select('_id invoiceId invoiceDate status total deliveryChallanIds salesOrderIds quoteId');

  const quoteMap = new Map();
  const rootSalesOrders = [];

  for (const invoice of invoices) {
    // Fetch ALL payments for this invoice (not just the current one)
    const allPayments = await PaymentReceived.find({
      'invoices.invoiceId': invoice._id,
    }).select('_id paymentReceivedId paymentDate status amountReceived');

    const invoiceNode = {
      id: invoice._id,
      invoiceId: invoice.invoiceId,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status,
      total: invoice.total,
      payments: allPayments.length > 0 ? allPayments : [paymentNode],
    };

    /* ========== CASE 1: FROM DELIVERY CHALLAN ========== */

    if (invoice.deliveryChallanIds?.length) {
      const dcIds = invoice.deliveryChallanIds.map(d => d.deliveryChallanId);

      const dcs = await DeliveryChallan.find({
        _id: { $in: dcIds },
      }).select('_id challanId challanDate status total salesOrders');

      for (const dc of dcs) {
        const dcNode = {
          id: dc._id,
          challanId: dc.challanId,
          challanDate: dc.challanDate,
          status: dc.status,
          total: dc.total,
          invoices: [invoiceNode],
        };

        const soIds = dc.salesOrders?.map(s => s.salesOrderId) || [];

        const salesOrders = await SalesOrder.find({
          _id: { $in: soIds },
        }).select('_id orderId orderDate status total quoteId');

        for (const so of salesOrders) {
          const soNode = {
            id: so._id,
            orderId: so.orderId,
            orderDate: so.orderDate,
            status: so.status,
            total: so.total,
            deliveryChallans: [dcNode],
          };

          const soProductionOrders = await ProductionOrder.find({ salesOrderId: so._id })
            .select('_id productionOrderCode productionDate status quantity itemId')
            .populate({
              path: 'itemId',
              model: getBooksCrmModels().Item,
              select: 'itemNo',
            });

          if (soProductionOrders?.length) {
            soNode.productionOrders = soProductionOrders;
          }

          if (so.quoteId) {
            const quote = await Quote.findById(so.quoteId).select('_id quoteId quoteDate status total');

            if (quote) {
              if (!quoteMap.has(quote._id.toString())) {
                quoteMap.set(quote._id.toString(), {
                  id: quote._id,
                  quoteId: quote.quoteId,
                  quoteDate: quote.quoteDate,
                  status: quote.status,
                  total: quote.total,
                  salesOrders: [],
                });
              }

              quoteMap.get(quote._id.toString()).salesOrders.push(soNode);
            }
          } else {
            rootSalesOrders.push(soNode);
          }
        }
      }
    }

    /* ========== CASE 2: DIRECT FROM SALES ORDER ========== */

    if (invoice.salesOrderIds?.length) {
      const soIds = invoice.salesOrderIds.map(s => s.salesOrderId);

      const salesOrders = await SalesOrder.find({
        _id: { $in: soIds },
      }).select('_id orderId orderDate status total quoteId');

      for (const so of salesOrders) {
        const soNode = {
          id: so._id,
          orderId: so.orderId,
          orderDate: so.orderDate,
          status: so.status,
          total: so.total,
          invoices: [invoiceNode],
        };

        const soProductionOrders = await ProductionOrder.find({ salesOrderId: so._id })
          .select('_id productionOrderCode productionDate status quantity itemId')
          .populate({
            path: 'itemId',
            model: getBooksCrmModels().Item,
            select: 'itemNo',
          });

        if (soProductionOrders?.length) {
          soNode.productionOrders = soProductionOrders;
        }

        if (so.quoteId) {
          const quote = await Quote.findById(so.quoteId).select('_id quoteId quoteDate status total');

          if (quote) {
            if (!quoteMap.has(quote._id.toString())) {
              quoteMap.set(quote._id.toString(), {
                id: quote._id,
                quoteId: quote.quoteId,
                quoteDate: quote.quoteDate,
                status: quote.status,
                total: quote.total,
                salesOrders: [],
              });
            }

            quoteMap.get(quote._id.toString()).salesOrders.push(soNode);
          }
        } else {
          rootSalesOrders.push(soNode);
        }
      }
    }

    /* ========== CASE 3: DIRECT FROM QUOTE ========== */

    if (invoice.quoteId) {
      const quote = await Quote.findById(invoice.quoteId).select('_id quoteId quoteDate status total');

      if (quote) {
        quoteMap.set(quote._id.toString(), {
          id: quote._id,
          quoteId: quote.quoteId,
          quoteDate: quote.quoteDate,
          status: quote.status,
          total: quote.total,
          invoices: [invoiceNode],
        });
      }
    }

    /* ========== CASE 4: DIRECT INVOICE ========== */

    if (!invoice.deliveryChallanIds?.length && !invoice.salesOrderIds?.length && !invoice.quoteId) {
      moduleTree.invoice = invoiceNode;
    }
  }

  /* ================= BUILD ROOT ================= */

  moduleTree.quotes = Array.from(quoteMap.values());

  if (rootSalesOrders.length) {
    moduleTree.salesOrders = rootSalesOrders;
  }

  if (!moduleTree.quotes.length && !rootSalesOrders.length && !moduleTree.invoice) {
    moduleTree.payment = paymentNode;
  }

  return moduleTree;
};

async function countPaymentsDaysByStatus(invoiceId, paymentReceivedId, session) {
  const { PaymentReceived } = getBooksCrmModels();
  const { Invoice } = getBooksModels();

  const invoice = await Invoice.findById(invoiceId).session(session);
  if (!invoice) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found');
  }

  if (invoice.status === INVOICE_STATUS.PAID) {
    if (invoice.orderToPaymentDays != null && invoice.orderToPaymentDays !== -1) return;

    const paymentReceived = await PaymentReceived.findOne({
      _id: paymentReceivedId,
    }).session(session);

    if (paymentReceived) {
      const invoiceDate = new Date(invoice.invoiceDate);
      invoiceDate.setUTCHours(0, 0, 0, 0);

      const paymentDate = new Date(paymentReceived.paymentDate);
      paymentDate.setUTCHours(0, 0, 0, 0);

      if (paymentDate < invoiceDate) return;

      const orderToPaymentDays = Math.round((paymentDate - invoiceDate) / (1000 * 60 * 60 * 24));

      await Invoice.findByIdAndUpdate(
        invoiceId,
        {
          $set: {
            orderToPaymentDays,
          },
        },
        { session },
      );
    }
  } else {
    await Invoice.findByIdAndUpdate(invoiceId, { $unset: { orderToPaymentDays: '' } }, { session });
  }
}

const addRefund = async (refundBody, companyId) => {
  const { PaymentReceived } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentReceived = await PaymentReceived.findOne({
      _id: refundBody.paymentReceivedId,
      companyId,
    }).session(session);

    if (!paymentReceived) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Received not found');
    }

    if (paymentReceived.status !== PAYMENT_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only approved payments can be refunded');
    }

    if (paymentReceived.unusedAmount <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No available balance to refund');
    }

    if (refundBody.amountRefunded > paymentReceived.unusedAmount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount exceeds available balance');
    }

    paymentReceived.refunds = paymentReceived.refunds || [];

    const { Account } = getBooksModels();
    const fromAccount = await Account.findOne({
      _id: refundBody.fromAccountId,
      companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).session(session);
    if (!fromAccount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'From account not found or not a valid payment account');
    }

    paymentReceived.refunds.push({
      refundedAt: refundBody.refundedAt,
      paymentMode: refundBody.paymentMode,
      fromAccountId: refundBody.fromAccountId,
      amountRefunded: refundBody.amountRefunded,
      description: refundBody.description,
    });
    paymentReceived.unusedAmount -= refundBody.amountRefunded;

    await paymentReceived.save({ session });
    // Refunded money is no longer the customer's credit.
    await updateBranchCurrentBalance({
      customerId: paymentReceived.customerId,
      branchId: paymentReceived.branchId,
      amount: refundBody.amountRefunded,
      session,
    });

    // Post the refund: Dr Unearned Revenue (customer) / Cr from account.
    const refund = paymentReceived.refunds[paymentReceived.refunds.length - 1];
    await ledgerService.postCustomerRefundJournal(
      {
        companyId,
        fromAccountId: refund.fromAccountId,
        amount: refund.amountRefunded,
        partyId: paymentReceived.customerId,
        postingDate: refund.refundedAt,
        sourceId: refund._id,
        narration: `Refund against ${paymentReceived.paymentReceivedId}`,
        addedBy: paymentReceived.addedBy,
        currencyId: paymentReceived.currency,
        exchangeRate: paymentReceived.exchangeRate,
      },
      session,
    );

    await session.commitTransaction();

    return enrichDocumentCurrency(companyId, paymentReceived.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteRefund = async (paymentReceivedId, refundId, companyId) => {
  const { PaymentReceived } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentReceived = await PaymentReceived.findOne({
      _id: paymentReceivedId,
      companyId,
    }).session(session);

    if (!paymentReceived) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Received not found');
    }

    const refund = paymentReceived.refunds?.find(r => r._id.toString() === refundId.toString());

    if (!refund) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund not found');
    }

    paymentReceived.unusedAmount += refund.amountRefunded;
    paymentReceived.refunds = paymentReceived.refunds.filter(r => r._id.toString() !== refundId.toString());

    await paymentReceived.save({ session });
    await updateBranchCurrentBalance({
      customerId: paymentReceived.customerId,
      branchId: paymentReceived.branchId,
      amount: -refund.amountRefunded,
      session,
    });

    // Deleting a refund = reverse its ledger journal.
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId: refund._id },
      session,
    );

    await session.commitTransaction();

    return paymentReceived;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateRefund = async (refundBody, paymentReceivedId, companyId) => {
  const { PaymentReceived } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const paymentReceived = await PaymentReceived.findOne({
      _id: paymentReceivedId,
      companyId,
    }).session(session);

    if (!paymentReceived) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment Received not found');
    }

    const refund = paymentReceived.refunds?.find(r => r._id.toString() === refundBody.refundId.toString());

    if (!refund) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund not found');
    }

    const effectiveUnusedAmount = paymentReceived.unusedAmount + refund.amountRefunded;

    if (refundBody.amountRefunded > effectiveUnusedAmount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount exceeds available balance');
    }

    if (refundBody.fromAccountId) {
      const { Account } = getBooksModels();
      const fromAccount = await Account.findOne({
        _id: refundBody.fromAccountId,
        companyId,
        isActive: true,
        category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      }).session(session);
      if (!fromAccount) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'From account not found or not a valid payment account');
      }
    }

    // Real money: undo the old refund, apply the new one (account or amount may change).
    const previousAmountRefunded = refund.amountRefunded;
    if (refundBody.fromAccountId) refund.fromAccountId = refundBody.fromAccountId;

    refund.paymentMode = refundBody.paymentMode;
    refund.amountRefunded = refundBody.amountRefunded;
    refund.description = refundBody.description;

    paymentReceived.unusedAmount -= refundBody.amountRefunded - previousAmountRefunded;

    await paymentReceived.save({ session });
    await updateBranchCurrentBalance({
      customerId: paymentReceived.customerId,
      branchId: paymentReceived.branchId,
      amount: refundBody.amountRefunded - previousAmountRefunded,
      session,
    });

    // Editing a refund = reverse its old journal, then post the new one.
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.PAYMENT_RECEIVED, sourceId: refund._id },
      session,
    );
    await ledgerService.postCustomerRefundJournal(
      {
        companyId,
        fromAccountId: refund.fromAccountId,
        amount: refund.amountRefunded,
        partyId: paymentReceived.customerId,
        postingDate: refund.refundedAt,
        sourceId: refund._id,
        narration: `Refund against ${paymentReceived.paymentReceivedId}`,
        addedBy: paymentReceived.addedBy,
        currencyId: paymentReceived.currency,
        exchangeRate: paymentReceived.exchangeRate,
      },
      session,
    );

    await session.commitTransaction();

    return enrichDocumentCurrency(companyId, paymentReceived.toJSON());
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
  createPayment: withTransientRetry(createPayment),
  queryPayments,
  queryPaymentsExports,
  getPaymentById,
  updatePaymentById,
  deletePaymentById,
  approvePaymentReceivedById,
  rejectPaymentReceivedById,
  cancelPaymentReceivedById,
  deletePaymentReceiveInvoice,
  applyAdvancePaymentReceivedAgainstInvoice,
  autoApplyPendingAdvancePayments,
  removeAdvancePaymentReceivedAgainstInvoice,
  addRefund,
  deleteRefund,
  updateRefund,
};
