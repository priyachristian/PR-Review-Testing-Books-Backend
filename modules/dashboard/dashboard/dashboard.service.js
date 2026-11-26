const { getBooksCrmModels, getCommonModels, getBooksModels } = require('../../../services/model.service');
const { PAYMENT_ACCOUNT_CATEGORIES, ACCOUNT_CATEGORIES } = require('../../../utils/enum');
const mongoose = require('mongoose');
const moment = require('moment');
const { PAYMENT_STATUS, BILL_STATUSES, INVOICE_STATUS, LEDGER_PARTY_TYPES } = require('../../../utils/enum');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const ledgerService = require('../../accountant/ledger/ledger.service');

const top5SalesOrders = async filter => {
  const { Customer } = getBooksCrmModels();
  const { Invoice } = getBooksModels();
  const { companyId, isSplit } = filter;
  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'invoiceDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  const condition = {
    companyId,
    ...query,
    status: { $ne: INVOICE_STATUS.CANCELLED },
  };

  const invoice = await Invoice.find(condition)
    .sort({ total: -1 })
    .select('invoiceId total exchangeRate customerId invoiceDate')
    .limit(5);

  const result = [];
  for (let i of invoice) {
    const customer = await Customer.findById(i?.customerId).select('customerDisplayName');
    result.push({
      ...i.toObject(),
      id: i?._id,
      total: i.total * (i.exchangeRate ?? 1),
      customerName: customer ? customer.customerDisplayName : null,
    });
  }
  return result;
};

const top5PurchaseOrders = async filter => {
  const { Bill } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'billDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  const condition = {
    companyId,
    ...query,
    status: { $ne: BILL_STATUSES.CANCELLED },
  };

  const bills = await Bill.find(condition).sort({ total: -1 }).select('billId total exchangeRate billDate vendor').limit(5);

  const result = [];
  for (let i of bills) {
    const customer = await Customer.findById(i?.vendor).select('customerDisplayName');
    result.push({
      ...i.toObject(),
      id: i?._id,
      total: i.total * (i.exchangeRate ?? 1),
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }

  return result;
};

const top5PaymentReceived = async filter => {
  const { PaymentReceived } = getBooksCrmModels();
  const { companyId, isSplit } = filter;
  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'paymentDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  const condition = {
    companyId,
    ...query,
    status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
  };

  const paymentReceived = await PaymentReceived.find(condition)
    .sort({ amountReceived: -1 })
    .select('paymentReceivedId amountReceived exchangeRate customerId paymentDate ')
    .populate('customerId', 'customerDisplayName')
    .limit(5);

  const result = [];
  for (let i of paymentReceived) {
    result.push({
      customerName: i?.customerId?.customerDisplayName || null,
      customerId: i?.customerId?.id,
      paymentReceivedId: i?.paymentReceivedId,
      paymentDate: i?.paymentDate,
      amountReceived: i.amountReceived * (i.exchangeRate ?? 1),
      id: i?.id,
      _id: i?._id,
    });
  }
  return result;
};

const top5PaymentMade = async filter => {
  const { PaymentMade } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'paymentDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  const condition = {
    companyId,
    ...query,
    status: { $nin: [PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REJECTED] },
  };

  const paymentMade = await PaymentMade.find(condition)
    .sort({ paymentMade: -1 })
    .select('paymentMadeId paymentMade exchangeRate paymentDate vendorId')
    .limit(5);

  const result = [];
  for (let i of paymentMade) {
    const customer = await Customer.findById(i?.vendorId).select('customerDisplayName');
    result.push({
      ...i.toObject(),
      paymentMade: i.paymentMade * (i.exchangeRate ?? 1),
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }

  return result;
};

const top5Expense = async filter => {
  const { Expenses } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId } = filter;

  let query = {};

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'date' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  const condition = {
    companyId: new mongoose.Types.ObjectId(companyId),
    ...query,
  };

  // Rank by the cost to the company; expenses saved before the line rebuild have no expenseCost.
  const expenses = await Expenses.aggregate([
    { $match: condition },
    { $addFields: { amount: { $multiply: [{ $ifNull: ['$expenseCost', '$total'] }, { $ifNull: ['$exchangeRate', 1] }] } } },
    { $match: { amount: { $gt: 0 } } },
    { $sort: { amount: -1 } },
    { $limit: 5 },
    { $project: { expenseId: 1, total: 1, exchangeRate: 1, date: 1, party: 1, amount: 1 } },
  ]);

  const result = [];
  for (let i of expenses) {
    const customer = await Customer.findById(i?.party).select('customerDisplayName');
    result.push({
      ...i,
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }

  return result;
};

const dashboardSummary = async query => {
  const { PaymentReceived } = getBooksCrmModels();
  const { Bill, PaymentMade, Expenses, Invoice } = getBooksModels();

  const { companyId, isSplit, startDate, endDate, branchId, divisionId } = query;
  let extraFilter = {};
  let branchDivisionFilter = {};

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      branchDivisionFilter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      branchDivisionFilter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }
  if (isSplit == undefined) {
    extraFilter.isSplit = false;
  }

  const invoiceDateFilter = buildDateFilter(startDate, endDate, 'invoiceDate');

  const invoice = await Invoice.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: { $nin: [INVOICE_STATUS.CANCELLED] },
        ...extraFilter,
        ...invoiceDateFilter,
        ...branchDivisionFilter,
      },
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
  ]);

  const totalOfSalesOrders = invoice[0]?.totalSales || 0;

  const billDateFilter = buildDateFilter(startDate, endDate, 'billDate');

  const bills = await Bill.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: { $nin: [BILL_STATUSES.CANCELLED] },
        ...extraFilter,
        ...billDateFilter,
        ...branchDivisionFilter,
      },
    },
    {
      $group: {
        _id: null,
        totalPurchase: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
  ]);

  const totalOfPurchaseOrders = bills[0]?.totalPurchase || 0;

  const expensesDateFilter = buildDateFilter(startDate, endDate, 'date');

  const expenses = await Expenses.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        ...expensesDateFilter,
        ...branchDivisionFilter,
      },
    },
    {
      $group: {
        _id: null,
        totalExpense: { $sum: { $multiply: [{ $ifNull: ['$expenseCost', '$total'] }, { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
  ]);

  const totalOfExpenses = expenses[0]?.totalExpense || 0;

  // Real money on hand: the balance of every bank/cash account, read directly from the ledger; since Account has no currentBalance field, each ledger balance is already converted to the base currency at posting time, so a foreign bank's figure is its balance × its exchange rate.
  const { Account } = getBooksModels();
  const moneyAccountIds = await Account.find({
    companyId: new mongoose.Types.ObjectId(companyId),
    category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    isActive: true,
  }).distinct('_id');

  const moneyAccountBalances = await ledgerService.getAccountBalances({ companyId });
  const totalAvailableBalance = moneyAccountIds.reduce((sum, accountId) => {
    const totals = moneyAccountBalances.get(String(accountId));
    return sum + (totals ? totals.debit - totals.credit : 0);
  }, 0);

  const paymentMadeDateFilter = buildDateFilter(startDate, endDate, 'paymentDate');

  const paymentMade = await PaymentMade.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: { $in: [PAYMENT_STATUS.APPROVED] },
        ...extraFilter,
        ...paymentMadeDateFilter,
        ...branchDivisionFilter,
      },
    },
    {
      $group: {
        _id: null,
        totalPaymentMade: { $sum: { $multiply: ['$paymentMade', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
  ]);

  const totalPaymentMade = paymentMade[0]?.totalPaymentMade || 0;

  const paymentReceived = await PaymentReceived.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: { $in: [PAYMENT_STATUS.APPROVED] },
        ...extraFilter,
        ...paymentMadeDateFilter,
        ...branchDivisionFilter,
      },
    },
    {
      $group: {
        _id: null,
        totalPaymentReceived: { $sum: { $multiply: ['$amountReceived', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
  ]);

  const totalPaymentReceived = paymentReceived[0]?.totalPaymentReceived || 0;

  const totalVendorDue = await vendorTotalDue(companyId, extraFilter, startDate, endDate, branchDivisionFilter);
  const totalCustomerDue = await customerTotalDue(companyId, extraFilter, startDate, endDate, branchDivisionFilter);
  const outstandingFilter = {
    companyId,
    includeSplit: isSplit != undefined,
    branchId: branchId ? branchId.split(',').filter(Boolean) : null,
    divisionId: divisionId ? divisionId.split(',').filter(Boolean) : null,
  };
  const totalCustomerOutstanding = await partyLedgerOutstanding({
    ...outstandingFilter,
    category: ACCOUNT_CATEGORIES.ACCOUNTS_RECEIVABLE.code,
    partyType: LEDGER_PARTY_TYPES.CUSTOMER,
  });
  const totalVendorOutstanding = -(await partyLedgerOutstanding({
    ...outstandingFilter,
    category: ACCOUNT_CATEGORIES.ACCOUNTS_PAYABLE.code,
    partyType: LEDGER_PARTY_TYPES.VENDOR,
  }));

  return {
    totalOfSalesOrders,
    totalOfPurchaseOrders,
    totalOfExpenses,
    totalAvailableBalance,
    totalPaymentMade,
    totalPaymentReceived,
    totalCustomerDue,
    totalVendorDue,
    totalCustomerOutstanding,
    totalVendorOutstanding,
  };
};

function buildDateFilter(startDate, endDate, fieldName) {
  if (!startDate || !endDate) return {};

  return {
    [fieldName]: {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    },
  };
}

async function vendorTotalDue(companyId, extraFilter, startDate, endDate, branchDivisionFilter) {
  const { Bill } = getBooksModels();
  const overdueBillsDateFilter = buildDateFilter(startDate, endDate, 'billDate');

  const overdueBills = await Bill.aggregate([
    {
      $match: {
        status: { $in: [BILL_STATUSES.OVERDUE] },
        companyId: new mongoose.Types.ObjectId(companyId),
        ...extraFilter,
        ...overdueBillsDateFilter,
        ...branchDivisionFilter,
      },
    },
    {
      $group: {
        _id: '$vendor',
        totalDueAmount: {
          $sum: { $multiply: [{ $ifNull: ['$balanceAmount', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
    },
    {
      $project: {
        customerId: '$_id',
        totalDueAmount: 1,
        _id: 0,
      },
    },
    {
      $sort: {
        totalDueAmount: -1,
      },
    },
  ]);

  const overdueBillMap = new Map(overdueBills.map(b => [b.customerId.toString(), b.totalDueAmount]));
  const totalOverdueAmount = [...overdueBillMap.values()].reduce((sum, amount) => sum + amount, 0);

  return totalOverdueAmount;
}

async function customerTotalDue(companyId, extraFilter, startDate, endDate, branchDivisionFilter) {
  const { Invoice } = getBooksModels();

  const today = new Date();

  const matchStage = {
    companyId: new mongoose.Types.ObjectId(companyId),
    status: { $in: [INVOICE_STATUS.OVERDUE] },
    dueDate: { $lt: today },
    balanceAmount: { $gt: 0 },
    ...extraFilter,
    ...branchDivisionFilter,
  };

  const result = await Invoice.aggregate([
    { $match: matchStage },
    { $group: { _id: null, totalDueAmount: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } } } },
  ]);

  return result[0]?.totalDueAmount || 0;
}

// Outstanding is the receivable/payable ledger balance: every posted document, opening balance and note counts; advances do not.
async function partyLedgerOutstanding({ companyId, category, partyType, includeSplit, branchId, divisionId }) {
  const { Account } = getBooksModels();
  const accountIds = await Account.find({ companyId: new mongoose.Types.ObjectId(companyId), category }).distinct('_id');
  if (!accountIds.length) return 0;

  const balances = await ledgerService.getAccountBalances({
    companyId,
    accountIds,
    partyType,
    includeSplit,
    branchId,
    divisionId,
  });
  let total = 0;
  for (const { debit, credit } of balances.values()) {
    total += debit - credit;
  }
  return total;
}

const userWiseSummary = async filter => {
  const { companyId } = filter;
  const { SalesOrder, Quote, PaymentReceived } = getBooksCrmModels();
  const {
    Invoice,
    DeliveryChallan,
    Bill,
    PurchaseOrder,
    Expenses,
    PaymentMade,
    CreditNote,
    DebitNote,
    GrpoOrder,
    UserRole,
    Role,
  } = getBooksModels();
  const { User } = getCommonModels();

  const cid = new mongoose.Types.ObjectId(companyId);
  const isSplitActive = !!filter?.isSplit;

  const aggregateByUser = async (Model, dateField, amountField, cancelledStatus, hasSplitField = false) => {
    const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField });

    const match = {
      companyId: cid,
      addedBy: { $exists: true, $ne: null },
      ...(branchDivisionCond || {}),
    };

    if (hasSplitField && !isSplitActive) {
      match.isSplit = { $ne: true };
    }

    if (cancelledStatus) match.status = { $ne: cancelledStatus };
    return Model.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$addedBy',
          count: { $sum: 1 },
          total: { $sum: { $multiply: [{ $ifNull: [`$${amountField}`, 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
        },
      },
    ]);
  };

  const [
    salesOrders,
    quotes,
    invoices,
    challans,
    paymentsReceived,
    creditNotes,
    bills,
    purchaseOrders,
    grpoOrders,
    paymentsMade,
    debitNotes,
    expenses,
  ] = await Promise.all([
    aggregateByUser(SalesOrder, 'orderDate', 'total', 'CANCELLED'),
    aggregateByUser(Quote, 'quoteDate', 'total', 'CANCELLED'),
    aggregateByUser(Invoice, 'invoiceDate', 'total', 'CANCELLED', true),
    aggregateByUser(DeliveryChallan, 'challanDate', 'total', 'CANCELLED'),
    aggregateByUser(PaymentReceived, 'paymentDate', 'amountReceived', 'CANCELLED', true),
    aggregateByUser(CreditNote, 'creditNoteDate', 'total', 'CANCELLED', true),
    aggregateByUser(Bill, 'billDate', 'total', 'CANCELLED', true),
    aggregateByUser(PurchaseOrder, 'createdAt', 'total', 'CANCELLED'),
    aggregateByUser(GrpoOrder, 'date', 'total', 'CANCELLED'),
    aggregateByUser(PaymentMade, 'paymentDate', 'paymentMade', 'CANCELLED', true),
    aggregateByUser(DebitNote, 'debitNoteDate', 'total', 'CANCELLED', true),
    aggregateByUser(Expenses, 'date', 'total', null),
  ]);

  const toMap = arr => {
    const m = {};
    arr.forEach(r => {
      m[r._id.toString()] = { count: r.count, total: r.total };
    });
    return m;
  };

  const soMap = toMap(salesOrders);
  const qMap = toMap(quotes);
  const invMap = toMap(invoices);
  const dcMap = toMap(challans);
  const prMap = toMap(paymentsReceived);
  const cnMap = toMap(creditNotes);
  const billMap = toMap(bills);
  const poMap = toMap(purchaseOrders);
  const grpoMap = toMap(grpoOrders);
  const pmMap = toMap(paymentsMade);
  const dnMap = toMap(debitNotes);
  const expMap = toMap(expenses);

  const userIds = new Set([
    ...Object.keys(soMap),
    ...Object.keys(qMap),
    ...Object.keys(invMap),
    ...Object.keys(dcMap),
    ...Object.keys(prMap),
    ...Object.keys(cnMap),
    ...Object.keys(billMap),
    ...Object.keys(poMap),
    ...Object.keys(grpoMap),
    ...Object.keys(pmMap),
    ...Object.keys(dnMap),
    ...Object.keys(expMap),
  ]);

  const activeUserObjectIds = [...userIds].map(id => new mongoose.Types.ObjectId(id));

  // Fetch all company users to identify those with no activity
  const allCompanyUserRoles = await UserRole.find({ companyId: cid }).select('userId roleId').lean();
  const allCompanyUserIds = [...new Set(allCompanyUserRoles.map(ur => ur.userId?.toString()).filter(Boolean))];

  const inactiveUserIds = allCompanyUserIds.filter(id => !userIds.has(id));
  const inactiveUserObjectIds = inactiveUserIds.map(id => new mongoose.Types.ObjectId(id));

  const fetchUsers = ids =>
    ids.length
      ? User.find({ _id: { $in: ids } })
          .select('firstName lastName email')
          .lean()
      : Promise.resolve([]);

  const [activeUsers, inactiveUsers] = await Promise.all([fetchUsers(activeUserObjectIds), fetchUsers(inactiveUserObjectIds)]);

  const roleIds = [...new Set(allCompanyUserRoles.map(ur => ur.roleId?.toString()).filter(Boolean))];
  const roles = roleIds.length
    ? await Role.find({ _id: { $in: roleIds.map(id => new mongoose.Types.ObjectId(id)) } })
        .select('role')
        .lean()
    : [];

  const roleMap = {};
  roles.forEach(r => {
    roleMap[r._id.toString()] = r.role;
  });

  const userRoleMap = {};
  allCompanyUserRoles.forEach(ur => {
    if (ur.roleId) userRoleMap[ur.userId.toString()] = roleMap[ur.roleId.toString()] || null;
  });

  const buildActiveUser = u => {
    const uid = u._id.toString();
    return {
      userId: u._id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || '-',
      email: u.email,
      roleName: userRoleMap[uid] || null,
      quotations: qMap[uid] || { count: 0, total: 0 },
      salesOrders: soMap[uid] || { count: 0, total: 0 },
      deliveryChallans: dcMap[uid] || { count: 0, total: 0 },
      invoices: invMap[uid] || { count: 0, total: 0 },
      paymentsReceived: prMap[uid] || { count: 0, total: 0 },
      creditNotes: cnMap[uid] || { count: 0, total: 0 },
      purchaseOrders: poMap[uid] || { count: 0, total: 0 },
      grpoOrders: grpoMap[uid] || { count: 0, total: 0 },
      bills: billMap[uid] || { count: 0, total: 0 },
      paymentsMade: pmMap[uid] || { count: 0, total: 0 },
      debitNotes: dnMap[uid] || { count: 0, total: 0 },
      expenses: expMap[uid] || { count: 0, total: 0 },
    };
  };

  const buildInactiveUser = u => {
    const uid = u._id.toString();
    return {
      userId: u._id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || '-',
      email: u.email,
      roleName: userRoleMap[uid] || null,
    };
  };

  return {
    activeUsers: activeUsers.map(buildActiveUser),
    inactiveUsers: inactiveUsers.map(buildInactiveUser),
  };
};

module.exports = {
  top5SalesOrders,
  top5PurchaseOrders,
  top5PaymentReceived,
  top5PaymentMade,
  top5Expense,
  dashboardSummary,
  userWiseSummary,
};
