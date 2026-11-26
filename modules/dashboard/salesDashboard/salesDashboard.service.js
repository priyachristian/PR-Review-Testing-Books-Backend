const mongoose = require('mongoose');
const moment = require('moment');
const { getBooksCrmModels, getBooksModels, getAbssAdminModels, getCommonModels } = require('../../../services/model.service');
const { INVOICE_STATUS, PAYMENT_STATUS, SALES_ORDER_STATUS } = require('../../../utils/enum');
const { buildBranchDivisionOrCondition, resolveFinancialYearRange } = require('../../../utils/queryBuilder');

// ─── Shared Utilities ─────────────────────────────────────────────────────────

/** Convert a comma-separated ID string to a MongoDB $in ObjectId array. */
const toObjectIds = str =>
  str
    .split(',')
    .filter(Boolean)
    .map(id => new mongoose.Types.ObjectId(id));

/** Deduplicate customer IDs from invoices, payments, and optional overdue lists. */
const extractCustomerIds = (...lists) => [
  ...new Set(
    lists
      .flat()
      .map(d => d.customerId?.toString())
      .filter(Boolean),
  ),
];

// ─── Filter Builders ──────────────────────────────────────────────────────────

const buildInvoiceFilter = filter => {
  const { companyId, startDate, endDate, branchId, divisionId, userId, isSplit } = filter;

  const query = {
    companyId,
    status: { $ne: INVOICE_STATUS.CANCELLED },
  };

  if (!isSplit || isSplit === 'false') query.isSplit = false;

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'invoiceDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  if (userId) query.addedBy = new mongoose.Types.ObjectId(userId);

  return query;
};

const buildSalesOrderFilter = filter => {
  const { companyId, startDate, endDate, branchId, divisionId, userId } = filter;

  const query = {
    companyId,
    status: { $ne: SALES_ORDER_STATUS.CANCELLED },
  };

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'orderDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  if (userId) query.addedBy = new mongoose.Types.ObjectId(userId);

  return query;
};

const buildPaymentFilter = filter => {
  const { companyId, startDate, endDate, branchId, divisionId, userId, isSplit } = filter;

  const query = {
    companyId,
    status: PAYMENT_STATUS.APPROVED,
  };

  if (!isSplit || isSplit === 'false') query.isSplit = false;

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'paymentDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  if (userId) query.addedBy = new mongoose.Types.ObjectId(userId);

  return query;
};

/**
 * Overdue match stage — mirrors customerTotalDue() in dashboard.service.js exactly.
 * No invoiceDate range, no userId. isSplit uses loose == undefined (same as general dashboard).
 */
const buildOverdueMatchStage = filter => {
  const { companyId, isSplit } = filter;

  const stage = {
    companyId: new mongoose.Types.ObjectId(companyId),
    status: { $ne: INVOICE_STATUS.CANCELLED },
    dueDate: { $lt: new Date() },
    balanceAmount: { $gt: 0 },
  };

  if (isSplit == undefined) stage.isSplit = false;

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'invoiceDate' });
  if (branchDivisionCond) {
    Object.assign(stage, branchDivisionCond);
  }

  return stage;
};

// ─── Customer Helpers ─────────────────────────────────────────────────────────

/**
 * Returns { [customerId]: { state, city, name } } for the given ID strings.
 */
const buildCustomerLocationMap = async customerIdStrings => {
  if (!customerIdStrings.length) return {};

  const { Customer } = getBooksCrmModels();

  const customers = await Customer.find({
    _id: { $in: customerIdStrings.map(id => new mongoose.Types.ObjectId(id)) },
  })
    .select('_id address customerDisplayName')
    .lean();

  const map = {};
  customers.forEach(c => {
    map[c._id.toString()] = {
      state: c.address?.billing?.state?.trim() || '',
      city: c.address?.billing?.city?.trim() || '',
      name: c.customerDisplayName || '',
    };
  });

  return map;
};

/**
 * Returns { [customerId]: outstandingBalance } using Customer.branch.currentBalance —
 * the live running balance maintained by the system (same source as normal dashboard).
 */
const buildCustomerBalanceMap = async customerIdStrings => {
  if (!customerIdStrings.length) return {};

  const { Customer } = getBooksCrmModels();

  const rows = await Customer.aggregate([
    { $match: { _id: { $in: customerIdStrings.map(id => new mongoose.Types.ObjectId(id)) } } },
    { $unwind: { path: '$branch', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$_id', outstanding: { $sum: { $ifNull: ['$branch.currentBalance', 0] } } } },
  ]);

  const map = {};
  rows.forEach(r => {
    map[r._id.toString()] = r.outstanding || 0;
  });
  return map;
};

/**
 * Returns total outstanding for the company — exact same logic as
 * customerTotalOutstanding() in dashboard.service.js.
 */
const getCompanyOutstanding = async filter => {
  const { Customer } = getBooksCrmModels();

  const matchStage = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    'Role.isCustomer': true,
    isActive: true,
  };

  if (filter.branchId) {
    const ids = toObjectIds(filter.branchId);
    if (ids.length) matchStage['branch.branchId'] = { $in: ids };
  }

  if (filter.divisionId) {
    const ids = toObjectIds(filter.divisionId);
    if (ids.length) matchStage['branch.divisionId'] = { $in: ids };
  }

  const result = await Customer.aggregate([
    { $match: matchStage },
    { $unwind: '$branch' },
    { $group: { _id: null, totalOutstanding: { $sum: { $ifNull: ['$branch.currentBalance', 0] } } } },
  ]);

  return result[0]?.totalOutstanding || 0;
};

// ─── 1. Summary ───────────────────────────────────────────────────────────────

const getSummary = async filter => {
  const { Invoice } = getBooksModels();
  const { PaymentReceived } = getBooksCrmModels();

  const invoiceQuery = buildInvoiceFilter(filter);
  const paymentQuery = buildPaymentFilter(filter);
  const companyObjectId = new mongoose.Types.ObjectId(filter.companyId);

  const [invoiceAgg, paymentAgg, dueAgg] = await Promise.all([
    Invoice.aggregate([
      { $match: { ...invoiceQuery, companyId: companyObjectId } },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
          uniqueCustomers: { $addToSet: '$customerId' },
          invoiceCount: { $sum: 1 },
        },
      },
    ]),
    PaymentReceived.aggregate([
      { $match: { ...paymentQuery, companyId: companyObjectId } },
      { $group: { _id: null, totalCollection: { $sum: { $multiply: ['$amountReceived', { $ifNull: ['$exchangeRate', 1] }] } } } },
    ]),
    Invoice.aggregate([
      { $match: buildOverdueMatchStage(filter) },
      {
        $group: {
          _id: null,
          totalDue: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } },
          dueCount: { $sum: 1 },
        },
      },
    ]),
  ]);

  const outstanding = await getCompanyOutstanding(filter);

  return {
    result: {
      totalSales: invoiceAgg[0]?.totalSales || 0,
      totalCollection: paymentAgg[0]?.totalCollection || 0,
      uniqueCustomers: (invoiceAgg[0]?.uniqueCustomers || []).length,
      outstanding,
      invoiceCount: invoiceAgg[0]?.invoiceCount || 0,
      totalDue: dueAgg[0]?.totalDue || 0,
      dueCount: dueAgg[0]?.dueCount || 0,
    },
  };
};

// ─── 2. State-wise Performance ────────────────────────────────────────────────

const getStateWise = async (filter, options = {}) => {
  const { Invoice } = getBooksModels();
  const { SalesOrder, PaymentReceived } = getBooksCrmModels();
  const { Country, State } = getAbssAdminModels();
  const { Company } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const company = await Company.findById(companyId).select('address.country').lean();

  const companyCountryName = company?.address?.country?.trim();
  let stateIdMap = new Map();

  if (companyCountryName) {
    const countryDoc = await Country.findOne({ name: companyCountryName }).select('_id').lean();

    if (countryDoc?._id) {
      const states = await State.find({ countryId: countryDoc._id }).select('_id name').lean();

      stateIdMap = new Map(states.map(state => [state.name?.trim(), state._id?.toString() || null]));
    }
  }

  const [invoices, salesOrders, payments, overdueInvoices] = await Promise.all([
    Invoice.find(buildInvoiceFilter(filter)).select('customerId total exchangeRate').lean(),
    SalesOrder.find(buildSalesOrderFilter(filter)).select('customerId total exchangeRate').lean(),
    PaymentReceived.find(buildPaymentFilter(filter)).select('customerId amountReceived exchangeRate').lean(),
    Invoice.find(buildOverdueMatchStage(filter)).select('customerId balanceAmount exchangeRate').lean(),
  ]);

  const allCustomerIds = extractCustomerIds(invoices, salesOrders, payments, overdueInvoices);
  const [customerLocationMap, balanceMap] = await Promise.all([
    buildCustomerLocationMap(allCustomerIds),
    buildCustomerBalanceMap(allCustomerIds),
  ]);

  const stateMap = {};

  const ensureState = (state, id) => {
    if (!state) return null;

    const normalizedState = state.trim();
    if (!normalizedState) return null;

    if (!stateMap[normalizedState]) {
      stateMap[normalizedState] = {
        state: normalizedState,
        stateId: id ? String(id) : null,
        totalSales: 0,
        invoiceCount: 0,
        salesOrderCount: 0,
        salesOrderAmount: 0,
        customerSet: new Set(),
        collection: 0,
        outstanding: 0,
        dueAmount: 0,
      };
    } else if (id && !stateMap[normalizedState].stateId) {
      stateMap[normalizedState].stateId = String(id);
    }

    return stateMap[normalizedState];
  };

  invoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    if (!custId) return;
    const { state } = customerLocationMap[custId] || {};
    const stateId = state ? stateIdMap.get(state.trim()) || null : null;
    const row = ensureState(state, stateId);
    if (!row) return;

    row.totalSales += (inv.total || 0) * (inv.exchangeRate ?? 1);
    row.invoiceCount += 1;

    if (!row.customerSet.has(custId)) {
      row.outstanding += balanceMap[custId] || 0;
      row.customerSet.add(custId);
    }
  });

  salesOrders.forEach(so => {
    const custId = so.customerId?.toString();
    if (!custId) return;
    const { state } = customerLocationMap[custId] || {};
    const stateId = state ? stateIdMap.get(state.trim()) || null : null;
    const row = ensureState(state, stateId);
    if (!row) return;

    row.salesOrderCount += 1;
    row.salesOrderAmount += (so.total || 0) * (so.exchangeRate ?? 1);

    row.customerSet.add(custId);
  });

  payments.forEach(pay => {
    const custId = pay.customerId?.toString();
    if (!custId) return;

    const { state } = customerLocationMap[custId] || {};
    const row = ensureState(state);
    if (!row) return;

    row.collection += (pay.amountReceived || 0) * (pay.exchangeRate ?? 1);
  });

  overdueInvoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    if (!custId) return;

    const { state } = customerLocationMap[custId] || {};
    const row = ensureState(state);
    if (!row) return;

    row.dueAmount += (inv.balanceAmount || 0) * (inv.exchangeRate ?? 1);
  });

  let result = Object.values(stateMap).map(row => ({
    state: row.state,
    stateId: row.stateId,
    totalSales: row.totalSales,
    invoiceCount: row.invoiceCount,
    salesOrderCount: row.salesOrderCount,
    salesOrderAmount: row.salesOrderAmount,
    customerCount: row.customerSet.size,
    collection: row.collection,
    outstanding: row.outstanding,
    dueAmount: row.dueAmount,
  }));

  if (options.sortBy) {
    const [sortField, sortOrder] = options.sortBy.split(':');
    const order = sortOrder === 'desc' ? -1 : 1;

    result.sort((a, b) => {
      const aValue = a[sortField] ?? 0;
      const bValue = b[sortField] ?? 0;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return order * aValue.localeCompare(bValue);
      }

      return order * (aValue - bValue);
    });
  } else {
    result.sort((a, b) => b.totalSales - a.totalSales);
  }

  return {
    result,
    totalResults: result.length,
  };
};

// ─── 3. City-wise Performance ─────────────────────────────────────────────────

const getCityWise = async (filter, options = {}) => {
  const { Invoice } = getBooksModels();
  const { PaymentReceived, SalesOrder } = getBooksCrmModels();

  const { state } = filter;
  const salesOrderQuery = buildSalesOrderFilter(filter);

  const [invoices, salesOrders, payments, overdueInvoices] = await Promise.all([
    Invoice.find(buildInvoiceFilter(filter)).select('customerId total exchangeRate').lean(),
    SalesOrder.find(salesOrderQuery).select('customerId total exchangeRate').lean(),
    PaymentReceived.find(buildPaymentFilter(filter)).select('customerId amountReceived exchangeRate').lean(),
    Invoice.find(buildOverdueMatchStage(filter)).select('customerId balanceAmount exchangeRate').lean(),
  ]);

  const allCustomerIds = extractCustomerIds(invoices, salesOrders, payments, overdueInvoices);
  const [customerLocationMap, balanceMap] = await Promise.all([
    buildCustomerLocationMap(allCustomerIds),
    buildCustomerBalanceMap(allCustomerIds),
  ]);

  const cityMap = {};

  const ensureCity = city => {
    const cityKey = (city || '').trim();
    if (!cityKey) return null;

    if (!cityMap[cityKey]) {
      cityMap[cityKey] = {
        city: cityKey,
        totalSales: 0,
        invoiceCount: 0,
        salesOrderCount: 0,
        salesOrderAmount: 0,
        customerSet: new Set(),
        collection: 0,
        outstanding: 0,
        dueAmount: 0,
      };
    }

    return cityMap[cityKey];
  };

  invoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    if (!custId) return;

    const loc = customerLocationMap[custId] || {};
    if (state && loc.state !== state) return;
    if (!loc.city) return;

    const row = ensureCity(loc.city);
    if (!row) return;

    row.totalSales += (inv.total || 0) * (inv.exchangeRate ?? 1);
    row.invoiceCount += 1;

    if (!row.customerSet.has(custId)) {
      row.outstanding += balanceMap[custId] || 0;
      row.customerSet.add(custId);
    }
  });

  salesOrders.forEach(order => {
    const custId = order.customerId?.toString();
    if (!custId) return;

    const loc = customerLocationMap[custId] || {};
    if (state && loc.state !== state) return;
    if (!loc.city) return;

    const row = ensureCity(loc.city);
    if (!row) return;

    row.salesOrderCount += 1;
    row.salesOrderAmount += (order.total || 0) * (order.exchangeRate ?? 1);
    row.customerSet.add(custId);
  });

  payments.forEach(pay => {
    const custId = pay.customerId?.toString();
    if (!custId) return;

    const loc = customerLocationMap[custId] || {};
    if (state && loc.state !== state) return;
    if (!loc.city) return;

    const row = ensureCity(loc.city);
    if (!row) return;

    row.collection += (pay.amountReceived || 0) * (pay.exchangeRate ?? 1);
  });

  overdueInvoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    if (!custId) return;

    const loc = customerLocationMap[custId] || {};
    if (state && loc.state !== state) return;
    if (!loc.city) return;

    const row = ensureCity(loc.city);
    if (!row) return;

    row.dueAmount += (inv.balanceAmount || 0) * (inv.exchangeRate ?? 1);
  });

  let result = Object.values(cityMap).map(row => ({
    city: row.city,
    totalSales: row.totalSales,
    invoiceCount: row.invoiceCount,
    salesOrderCount: row.salesOrderCount,
    salesOrderAmount: row.salesOrderAmount,
    customerCount: row.customerSet.size,
    collection: row.collection,
    outstanding: row.outstanding,
    dueAmount: row.dueAmount,
  }));

  if (options.sortBy) {
    const [sortField, sortOrder] = options.sortBy.split(':');
    const order = sortOrder === 'desc' ? -1 : 1;

    result.sort((a, b) => {
      const aValue = a[sortField] ?? 0;
      const bValue = b[sortField] ?? 0;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return order * aValue.localeCompare(bValue);
      }

      return order * (aValue - bValue);
    });
  } else {
    result.sort((a, b) => b.totalSales - a.totalSales);
  }

  const totalResults = result.length;
  const page = Number(options.page) > 0 ? Number(options.page) : 1;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
  const isPaginationEnabled = options.pagination !== 'false';
  const skip = (page - 1) * limit;

  const paginatedResults = isPaginationEnabled ? result.slice(skip, skip + limit) : result;
  const totalPages = isPaginationEnabled ? Math.ceil(totalResults / limit) || 1 : 1;

  return {
    result: paginatedResults,
    page,
    limit: isPaginationEnabled ? limit : totalResults,
    totalPages,
    totalResults,
  };
};

const getCustomerWise = async (filter, options = {}) => {
  const { Invoice } = getBooksModels();
  const { PaymentReceived, Customer, SalesOrder } = getBooksCrmModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const invoiceQuery = buildInvoiceFilter(filter);
  const paymentQuery = buildPaymentFilter(filter);
  const overdueQuery = buildOverdueMatchStage(filter);
  const salesOrderQuery = buildSalesOrderFilter(filter);

  const [invoices, payments, overdueInvoices, customers, salesOrders] = await Promise.all([
    Invoice.find(invoiceQuery).select('customerId total exchangeRate').lean(),
    PaymentReceived.find(paymentQuery).select('customerId amountReceived exchangeRate').lean(),
    Invoice.find(overdueQuery).select('customerId balanceAmount exchangeRate').lean(),
    Customer.find({
      companyId,
      'Role.isCustomer': true,
      ...(filter.customerId ? { _id: { $in: toObjectIds(filter.customerId) } } : {}),
    })
      .select('_id customerDisplayName customerNumber companyName')
      .lean(),
    SalesOrder.find(salesOrderQuery).select('customerId total exchangeRate').lean(),
  ]);

  const customerMap = {};

  const ensureCustomer = (customerId, customerName = '', customerNumber = '') => {
    if (!customerId) return null;

    const key = customerId.toString();

    if (!customerMap[key]) {
      customerMap[key] = {
        customerId: key,
        customerName: customerName || '-',
        customerNumber: customerNumber || '-',
        actualSales: 0,
        invoiceCount: 0,
        salesOrderCount: 0,
        salesOrderAmount: 0,
        collection: 0,
        dueAmount: 0,
      };
    }

    if (customerName && !customerMap[key].customerName) {
      customerMap[key].customerName = customerName;
    }

    if (customerNumber && customerMap[key].customerNumber === '-') {
      customerMap[key].customerNumber = customerNumber;
    }

    return customerMap[key];
  };

  customers.forEach(customer => {
    const customerName = customer.companyName || customer.customerDisplayName || '-';
    const customerNumber = customer.customerNumber || '-';
    ensureCustomer(customer._id, customerName, customerNumber);
  });

  invoices.forEach(invoice => {
    if (!invoice.customerId) return;

    const row = ensureCustomer(invoice.customerId);
    if (!row) return;

    row.actualSales += (invoice.total || 0) * (invoice.exchangeRate ?? 1);
    row.invoiceCount += 1;
  });

  payments.forEach(payment => {
    if (!payment.customerId) return;

    const row = ensureCustomer(payment.customerId);
    if (!row) return;

    row.collection += (payment.amountReceived || 0) * (payment.exchangeRate ?? 1);
  });

  overdueInvoices.forEach(invoice => {
    if (!invoice.customerId) return;

    const row = ensureCustomer(invoice.customerId);
    if (!row) return;

    row.dueAmount += (invoice.balanceAmount || 0) * (invoice.exchangeRate ?? 1);
  });

  salesOrders.forEach(order => {
    if (!order.customerId) return;

    const row = ensureCustomer(order.customerId);
    if (!row) return;

    row.salesOrderCount += 1;
    row.salesOrderAmount += (order.total || 0) * (order.exchangeRate ?? 1);
  });

  let result = Object.values(customerMap).map(row => ({
    customerId: row.customerId,
    customerName: row.customerName,
    customerNumber: row.customerNumber,
    actualSales: row.actualSales,
    invoiceCount: row.invoiceCount,
    salesOrderCount: row.salesOrderCount,
    salesOrderAmount: row.salesOrderAmount,
    collection: row.collection,
    dueAmount: row.dueAmount,
  }));

  if (options.sortBy) {
    const [sortField, sortOrder] = options.sortBy.split(':');
    const order = sortOrder === 'desc' ? -1 : 1;

    result.sort((a, b) => {
      const aValue = a[sortField] ?? 0;
      const bValue = b[sortField] ?? 0;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return order * aValue.localeCompare(bValue);
      }

      return order * (aValue - bValue);
    });
  } else {
    result.sort((a, b) => b.actualSales - a.actualSales);
  }

  const totalResults = result.length;
  const page = Number(options.page) > 0 ? Number(options.page) : 1;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
  const isPaginationEnabled = options.pagination !== 'false';
  const skip = (page - 1) * limit;

  const paginatedResults = isPaginationEnabled ? result.slice(skip, skip + limit) : result;
  const totalPages = isPaginationEnabled ? Math.ceil(totalResults / limit) || 1 : 1;

  return {
    result: paginatedResults,
    page,
    limit: isPaginationEnabled ? limit : totalResults,
    totalPages,
    totalResults,
  };
};

const getItemWise = async (filter, options = {}) => {
  const { Invoice } = getBooksModels();
  const { SalesOrder, Item } = getBooksCrmModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const invoiceQuery = buildInvoiceFilter(filter);
  const salesOrderQuery = buildSalesOrderFilter(filter);

  const itemIdsFilter = filter.itemId ? toObjectIds(filter.itemId).map(id => id.toString()) : null;

  const [invoices, salesOrders, items] = await Promise.all([
    Invoice.find(invoiceQuery).select('_id items exchangeRate isSplit splitWiseType splitInvoiceId').lean(),
    SalesOrder.find(salesOrderQuery).select('_id items exchangeRate').lean(),
    Item.find({
      companyId,
      ...(filter.itemId ? { _id: { $in: toObjectIds(filter.itemId) } } : {}),
    })
      .select('_id itemName itemNo')
      .lean(),
  ]);

  const itemMap = {};

  const ensureItem = (itemId, itemName = '', itemNo = '') => {
    if (!itemId) return null;

    const key = itemId.toString();

    if (!itemMap[key]) {
      itemMap[key] = {
        itemId: key,
        itemName: itemName || '-',
        itemNo: itemNo || '-',
        actualSales: 0,
        invoiceCount: 0,
        invoiceQty: 0,
        salesOrderCount: 0,
        salesOrderAmount: 0,
        salesOrderQty: 0,
        invoiceIds: new Set(),
        salesOrderIds: new Set(),
      };
    }

    if (itemName && (!itemMap[key].itemName || itemMap[key].itemName === '-')) {
      itemMap[key].itemName = itemName;
    }

    if (itemNo && (!itemMap[key].itemNo || itemMap[key].itemNo === '-')) {
      itemMap[key].itemNo = itemNo;
    }

    return itemMap[key];
  };

  const splitInvoiceMap = buildSplitInvoiceMap(invoices);

  // preload items
  items.forEach(item => {
    ensureItem(item._id, item.itemName || '-', item.itemNo || '-');
  });

  // invoices => actualSales + distinct invoiceCount
  invoices.forEach(invoice => {
    const exchangeRate = invoice.exchangeRate ?? 1;
    const invoiceItems = Array.isArray(invoice.items) ? invoice.items : [];
    const countQty = shouldCountSplitInvoiceQty(invoice, splitInvoiceMap);

    invoiceItems.forEach(line => {
      if (!line?.itemId) return;

      const itemId = line.itemId.toString();
      if (itemIdsFilter && !itemIdsFilter.includes(itemId)) return;

      const row = ensureItem(itemId);
      if (!row) return;

      const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

      row.actualSales += (lineAmount || 0) * exchangeRate;
      row.invoiceIds.add(invoice._id.toString());

      if (countQty) {
        row.invoiceQty += Number(line.quantity || 0);
      }
    });
  });

  salesOrders.forEach(order => {
    const exchangeRate = order.exchangeRate ?? 1;
    const orderItems = Array.isArray(order.items) ? order.items : [];

    orderItems.forEach(line => {
      if (!line?.itemId) return;

      const itemId = line.itemId.toString();
      if (itemIdsFilter && !itemIdsFilter.includes(itemId)) return;

      const row = ensureItem(itemId);
      if (!row) return;

      const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

      row.salesOrderAmount += (lineAmount || 0) * exchangeRate;
      row.salesOrderIds.add(order._id.toString());
      row.salesOrderQty += Number(line.quantity || 0);
    });
  });

  let result = Object.values(itemMap).map(row => ({
    itemId: row.itemId,
    itemNo: row.itemNo,
    itemName: row.itemName,
    actualSales: row.actualSales,
    invoiceCount: row.invoiceIds.size,
    invoiceQty: row.invoiceQty,
    salesOrderCount: row.salesOrderIds.size,
    salesOrderQty: row.salesOrderQty,
    salesOrderAmount: row.salesOrderAmount,
  }));

  if (options.sortBy) {
    const [sortField, sortOrder] = options.sortBy.split(':');
    const order = sortOrder === 'desc' ? -1 : 1;

    result.sort((a, b) => {
      const aValue = a[sortField] ?? 0;
      const bValue = b[sortField] ?? 0;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return order * aValue.localeCompare(bValue);
      }

      return order * (aValue - bValue);
    });
  } else {
    result.sort((a, b) => b.actualSales - a.actualSales);
  }

  const totalResults = result.length;
  const page = Number(options.page) > 0 ? Number(options.page) : 1;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
  const isPaginationEnabled = options.pagination !== 'false';
  const skip = (page - 1) * limit;

  const paginatedResults = isPaginationEnabled ? result.slice(skip, skip + limit) : result;
  const totalPages = isPaginationEnabled ? Math.ceil(totalResults / limit) || 1 : 1;

  return {
    result: paginatedResults,
    page,
    limit: isPaginationEnabled ? limit : totalResults,
    totalPages,
    totalResults,
  };
};

const getStateWiseGraph = async filter => {
  const { Invoice } = getBooksModels();

  const [invoices, overdueInvoices] = await Promise.all([
    Invoice.find(buildInvoiceFilter(filter)).select('customerId total exchangeRate').lean(),
    Invoice.find(buildOverdueMatchStage(filter)).select('customerId balanceAmount exchangeRate').lean(),
  ]);

  const allCustomerIds = extractCustomerIds(invoices, overdueInvoices);
  const customerLocationMap = await buildCustomerLocationMap(allCustomerIds);

  const stateMap = {};

  const ensureState = state => {
    const normalizedState = (state || '').trim();
    if (!normalizedState) return null;

    if (!stateMap[normalizedState]) {
      stateMap[normalizedState] = {
        state: normalizedState,
        actualSales: 0,
        overdueAmount: 0,
      };
    }

    return stateMap[normalizedState];
  };

  invoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    if (!custId) return;

    const { state } = customerLocationMap[custId] || {};
    const row = ensureState(state);
    if (!row) return;

    row.actualSales += (inv.total || 0) * (inv.exchangeRate ?? 1);
  });

  overdueInvoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    if (!custId) return;

    const { state } = customerLocationMap[custId] || {};
    const row = ensureState(state);
    if (!row) return;

    row.overdueAmount += (inv.balanceAmount || 0) * (inv.exchangeRate ?? 1);
  });

  const result = Object.values(stateMap)
    .map(row => ({
      state: row.state,
      actualSales: row.actualSales || 0,
      overdueAmount: row.overdueAmount || 0,
    }))
    .sort((a, b) => b.actualSales - a.actualSales);

  return { result };
};

const getOrderInvoicePaymentTrend = async filter => {
  const { Invoice } = getBooksModels();
  const { SalesOrder, PaymentReceived } = getBooksCrmModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const invoiceQuery = buildInvoiceFilter(filter);
  const salesOrderQuery = buildSalesOrderFilter(filter);
  const paymentQuery = buildPaymentFilter(filter);

  const { startDate, endDate } = resolveDashboardPeriodRange(filter);

  const [invoices, salesOrders, payments] = await Promise.all([
    Invoice.find(invoiceQuery).select('invoiceDate total exchangeRate').lean(),
    SalesOrder.find(salesOrderQuery).select('orderDate total exchangeRate').lean(),
    PaymentReceived.find(paymentQuery).select('paymentDate amountReceived exchangeRate').lean(),
  ]);

  const monthMap = {};

  const formatMonth = date => {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return null;

    return d.toLocaleString('en-US', {
      month: 'short',
      year: '2-digit',
    });
  };

  const getMonthStart = date => {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  };

  let cursor = getMonthStart(startDate);
  const lastMonth = getMonthStart(endDate);

  while (cursor <= lastMonth) {
    const key = formatMonth(cursor);

    monthMap[key] = {
      month: key,
      salesAmount: 0,
      invoiceAmount: 0,
      paymentAmount: 0,
      sortDate: cursor.getTime(),
    };

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  invoices.forEach(inv => {
    const month = formatMonth(inv.invoiceDate);
    if (month && monthMap[month]) {
      monthMap[month].invoiceAmount += (inv.total || 0) * (inv.exchangeRate ?? 1);
    }
  });

  salesOrders.forEach(order => {
    const month = formatMonth(order.orderDate);
    if (month && monthMap[month]) {
      monthMap[month].salesAmount += (order.total || 0) * (order.exchangeRate ?? 1);
    }
  });

  payments.forEach(payment => {
    const month = formatMonth(payment.paymentDate);
    if (month && monthMap[month]) {
      monthMap[month].paymentAmount += (payment.amountReceived || 0) * (payment.exchangeRate ?? 1);
    }
  });

  const result = Object.values(monthMap)
    .sort((a, b) => a.sortDate - b.sortDate)
    .map(({ sortDate, ...row }) => row);

  return { result };
};

const getOrderStatusSummary = async filter => {
  const { SalesOrder } = getBooksCrmModels();

  const query = { companyId: new mongoose.Types.ObjectId(filter.companyId) };

  // No status exclusion here (unlike buildSalesOrderFilter) — Cancelled orders are one of the buckets being counted.
  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'orderDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  if (filter.userId) query.addedBy = new mongoose.Types.ObjectId(filter.userId);

  const salesOrders = await SalesOrder.find(query).select('status').lean();

  const statusMap = {
    Completed: 0,
    Pending: 0,
    Cancelled: 0,
  };

  salesOrders.forEach(order => {
    switch (order.status) {
      case SALES_ORDER_STATUS.COMPLETED:
        statusMap.Completed += 1;
        break;

      case SALES_ORDER_STATUS.DRAFT:
      case SALES_ORDER_STATUS.OPEN:
      case SALES_ORDER_STATUS.PARTIALLY_RECORDED:
        statusMap.Pending += 1;
        break;

      case SALES_ORDER_STATUS.CANCELLED:
        statusMap.Cancelled += 1;
        break;

      default:
        break;
    }
  });

  const total = Object.values(statusMap).reduce((sum, count) => sum + count, 0);

  const result = [
    {
      status: 'Completed',
      count: statusMap.Completed,
      percentage: total ? Number(((statusMap.Completed / total) * 100).toFixed(1)) : 0,
    },
    {
      status: 'Pending',
      count: statusMap.Pending,
      percentage: total ? Number(((statusMap.Pending / total) * 100).toFixed(1)) : 0,
    },
    {
      status: 'Cancelled',
      count: statusMap.Cancelled,
      percentage: total ? Number(((statusMap.Cancelled / total) * 100).toFixed(1)) : 0,
    },
  ];

  return { result };
};

const getItemWiseDetails = async (id, filter, options = {}) => {
  const { Invoice } = getBooksModels();
  const { SalesOrder, Item, Customer, ItemGroup } = getBooksCrmModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const itemId = new mongoose.Types.ObjectId(id);

  const invoiceQuery = {
    ...buildInvoiceFilter(filter),
    'items.itemId': itemId,
  };

  const salesOrderQuery = {
    ...buildSalesOrderFilter(filter),
    'items.itemId': itemId,
  };

  const [invoices, salesOrders, customers, item, company] = await Promise.all([
    Invoice.find(invoiceQuery).select('_id customerId addressId items exchangeRate isSplit splitWiseType splitInvoiceId').lean(),
    SalesOrder.find(salesOrderQuery).select('_id customerId addressId items exchangeRate').lean(),
    Customer.find({
      companyId,
      'Role.isCustomer': true,
    })
      .select('_id customerDisplayName customerNumber address companyName')
      .lean(),
    Item.findOne({ _id: itemId, companyId }).select('_id itemName itemNo itemGroup itemUnit').lean(),
  ]);

  let itemGroup = null;
  if (item?.itemGroup) {
    itemGroup = await ItemGroup.findById(item.itemGroup).select('_id name').lean();
  }

  const itemDetails = {
    itemId: item?._id || itemId,
    itemName: item?.itemName || '-',
    itemNo: item?.itemNo || '-',
    itemGroupId: item?.itemGroup || null,
    itemGroupName: itemGroup?.name || '-',
    itemUnit: item?.itemUnit || '-',
  };

  const customerMap = new Map();
  customers.forEach(customer => {
    customerMap.set(customer._id.toString(), customer);
  });

  const splitInvoiceMap = buildSplitInvoiceMap(invoices);

  const getCustomerName = customer => {
    return customer?.companyName || customer?.customerDisplayName || '-';
  };

  const getCustomerNumber = customer => {
    return customer?.customerNumber || '-';
  };

  const getCustomerState = (customer, addressId) => {
    if (!customer) return '-';

    const customerAddress = customer.address || {};
    const billing = customerAddress.billing || null;
    const shipping = customerAddress.shipping || null;
    const additionalShippingAddresses = Array.isArray(customerAddress.additionalShippingAddresses)
      ? customerAddress.additionalShippingAddresses
      : [];

    const targetAddressId = addressId?.toString();

    if (targetAddressId && billing?._id?.toString() === targetAddressId) {
      return billing?.state?.trim() || '-';
    }

    if (targetAddressId && shipping?._id?.toString() === targetAddressId) {
      return shipping?.state?.trim() || '-';
    }

    const matchedAdditional = additionalShippingAddresses.find(addr => addr?._id?.toString() === targetAddressId);

    if (matchedAdditional) {
      return matchedAdditional?.state?.trim() || '-';
    }

    return billing?.state?.trim() || shipping?.state?.trim() || additionalShippingAddresses[0]?.state?.trim() || '-';
  };

  if (filter.tab === 'customer') {
    const customerMapData = {};

    const ensureCustomer = customerId => {
      if (!customerId) return null;

      const key = customerId.toString();
      const customer = customerMap.get(key);

      if (!customerMapData[key]) {
        customerMapData[key] = {
          customerId: key,
          customerName: getCustomerName(customer),
          customerNumber: getCustomerNumber(customer),
          salesOrderQty: 0,
          salesOrderAmount: 0,
          salesOrderCount: 0,
          invoiceQty: 0,
          invoiceAmount: 0,
          invoiceCount: 0,
        };
      }

      return customerMapData[key];
    };

    invoices.forEach(invoice => {
      const exchangeRate = invoice.exchangeRate ?? 1;
      const countQty = shouldCountSplitInvoiceQty(invoice, splitInvoiceMap);
      const invoiceItems = Array.isArray(invoice.items) ? invoice.items : [];

      let itemExistsInInvoice = false;

      invoiceItems.forEach(line => {
        if (!line?.itemId || line.itemId.toString() !== itemId.toString()) return;
        if (!invoice.customerId) return;

        const row = ensureCustomer(invoice.customerId);
        if (!row) return;

        const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

        row.invoiceAmount += (lineAmount || 0) * exchangeRate;

        if (countQty) {
          row.invoiceQty += Number(line.quantity || 0);
        }

        itemExistsInInvoice = true;
      });

      if (itemExistsInInvoice && invoice.customerId) {
        const row = ensureCustomer(invoice.customerId);
        if (row) row.invoiceCount += 1;
      }
    });

    salesOrders.forEach(order => {
      const exchangeRate = order.exchangeRate ?? 1;
      const orderItems = Array.isArray(order.items) ? order.items : [];

      let itemExistsInOrder = false;

      orderItems.forEach(line => {
        if (!line?.itemId || line.itemId.toString() !== itemId.toString()) return;
        if (!order.customerId) return;

        const row = ensureCustomer(order.customerId);
        if (!row) return;

        const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

        row.salesOrderAmount += (lineAmount || 0) * exchangeRate;
        row.salesOrderQty += Number(line.quantity || 0);

        itemExistsInOrder = true;
      });

      if (itemExistsInOrder && order.customerId) {
        const row = ensureCustomer(order.customerId);
        if (row) row.salesOrderCount += 1;
      }
    });

    let result = Object.values(customerMapData).map(row => ({
      customerId: row.customerId,
      customerName: row.customerName,
      customerNumber: row.customerNumber,
      salesOrderQty: row.salesOrderQty,
      salesOrderAmount: row.salesOrderAmount,
      invoiceQty: row.invoiceQty,
      invoiceAmount: row.invoiceAmount,
      salesOrderCount: row.salesOrderCount,
      invoiceCount: row.invoiceCount,
    }));

    if (options.sortBy) {
      const [sortField, sortOrder] = options.sortBy.split(':');
      const order = sortOrder === 'desc' ? -1 : 1;

      result.sort((a, b) => {
        const aValue = a[sortField] ?? 0;
        const bValue = b[sortField] ?? 0;

        if (typeof aValue === 'string' && typeof bValue === 'string') {
          return order * aValue.localeCompare(bValue);
        }

        return order * (aValue - bValue);
      });
    } else {
      result.sort((a, b) => b.invoiceAmount - a.invoiceAmount);
    }

    const totalResults = result.length;
    const page = Number(options.page) > 0 ? Number(options.page) : 1;
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
    const isPaginationEnabled = options.pagination !== 'false';
    const skip = (page - 1) * limit;

    const paginatedResults = isPaginationEnabled ? result.slice(skip, skip + limit) : result;
    const totalPages = isPaginationEnabled ? Math.ceil(totalResults / limit) || 1 : 1;

    return {
      itemDetails,
      result: paginatedResults,
      page,
      limit: isPaginationEnabled ? limit : totalResults,
      totalPages,
      totalResults,
    };
  }

  if (filter.tab === 'state') {
    const stateMap = {};

    const ensureState = stateName => {
      const normalizedState = (stateName || '').trim() || '-';

      if (!stateMap[normalizedState]) {
        stateMap[normalizedState] = {
          state: normalizedState,
          salesOrderQty: 0,
          salesOrderAmount: 0,
          salesOrderCount: 0,
          invoiceQty: 0,
          invoiceAmount: 0,
          invoiceCount: 0,
        };
      }

      return stateMap[normalizedState];
    };

    invoices.forEach(invoice => {
      const exchangeRate = invoice.exchangeRate ?? 1;
      const countQty = shouldCountSplitInvoiceQty(invoice, splitInvoiceMap);
      const invoiceItems = Array.isArray(invoice.items) ? invoice.items : [];
      const customer = invoice.customerId ? customerMap.get(invoice.customerId.toString()) : null;
      const state = getCustomerState(customer, invoice.addressId);

      let itemExistsInInvoice = false;

      invoiceItems.forEach(line => {
        if (!line?.itemId || line.itemId.toString() !== itemId.toString()) return;

        const row = ensureState(state);
        if (!row) return;

        const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

        row.invoiceAmount += (lineAmount || 0) * exchangeRate;

        if (countQty) {
          row.invoiceQty += Number(line.quantity || 0);
        }

        itemExistsInInvoice = true;
      });

      if (itemExistsInInvoice) {
        const row = ensureState(state);
        if (row) row.invoiceCount += 1;
      }
    });

    salesOrders.forEach(order => {
      const exchangeRate = order.exchangeRate ?? 1;
      const orderItems = Array.isArray(order.items) ? order.items : [];
      const customer = order.customerId ? customerMap.get(order.customerId.toString()) : null;
      const state = getCustomerState(customer, order.addressId);

      let itemExistsInOrder = false;

      orderItems.forEach(line => {
        if (!line?.itemId || line.itemId.toString() !== itemId.toString()) return;

        const row = ensureState(state);
        if (!row) return;

        const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

        row.salesOrderAmount += (lineAmount || 0) * exchangeRate;
        row.salesOrderQty += Number(line.quantity || 0);

        itemExistsInOrder = true;
      });

      if (itemExistsInOrder) {
        const row = ensureState(state);
        if (row) row.salesOrderCount += 1;
      }
    });

    let result = Object.values(stateMap).map(row => ({
      state: row.state,
      salesOrderQty: row.salesOrderQty,
      salesOrderAmount: row.salesOrderAmount,
      invoiceQty: row.invoiceQty,
      invoiceAmount: row.invoiceAmount,
      salesOrderCount: row.salesOrderCount,
      invoiceCount: row.invoiceCount,
    }));

    if (options.sortBy) {
      const [sortField, sortOrder] = options.sortBy.split(':');
      const order = sortOrder === 'desc' ? -1 : 1;

      result.sort((a, b) => {
        const aValue = a[sortField] ?? 0;
        const bValue = b[sortField] ?? 0;

        if (typeof aValue === 'string' && typeof bValue === 'string') {
          return order * aValue.localeCompare(bValue);
        }

        return order * (aValue - bValue);
      });
    } else {
      result.sort((a, b) => b.invoiceAmount - a.invoiceAmount);
    }

    return {
      itemDetails,
      result,
      page: 1,
      limit: result.length,
      totalPages: 1,
      totalResults: result.length,
    };
  }

  return {
    result: [],
    page: 1,
    limit: 0,
    totalPages: 0,
    totalResults: 0,
  };
};

const getCustomerWiseDetails = async (id, filter, options = {}) => {
  const { Invoice } = getBooksModels();
  const { SalesOrder, Item, Customer } = getBooksCrmModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const customerId = new mongoose.Types.ObjectId(id);

  const invoiceQuery = {
    ...buildInvoiceFilter(filter),
    customerId,
  };

  const salesOrderQuery = {
    ...buildSalesOrderFilter(filter),
    customerId,
  };

  const [invoices, salesOrders, customer] = await Promise.all([
    Invoice.find(invoiceQuery).select('_id customerId items exchangeRate isSplit splitWiseType splitInvoiceId').lean(),
    SalesOrder.find(salesOrderQuery).select('_id customerId items exchangeRate').lean(),
    Customer.findOne({
      _id: customerId,
      companyId,
      'Role.isCustomer': true,
    })
      .select('_id customerDisplayName companyName bpEmail customerNumber customerPhoneNumber')
      .lean(),
  ]);

  const splitInvoiceMap = buildSplitInvoiceMap(invoices);

  const customerDetails = {
    customerId: customer?._id || customerId,
    customerDisplayName: customer?.customerDisplayName || '-',
    customerNumber: customer?.customerNumber || '-',
    customerEmail: customer?.bpEmail || '-',
    phoneNumber: customer?.customerPhoneNumber || '-',
    companyName: customer?.companyName || '-',
  };

  // collect only used itemIds
  const itemIds = new Set();

  invoices.forEach(invoice => {
    (invoice.items || []).forEach(line => {
      if (line?.itemId) itemIds.add(line.itemId.toString());
    });
  });

  salesOrders.forEach(order => {
    (order.items || []).forEach(line => {
      if (line?.itemId) itemIds.add(line.itemId.toString());
    });
  });

  const items = await Item.find({
    _id: { $in: [...itemIds].map(itemId => new mongoose.Types.ObjectId(itemId)) },
  })
    .select('_id itemName itemNo')
    .lean();

  const itemMasterMap = new Map();
  items.forEach(item => {
    itemMasterMap.set(item._id.toString(), item);
  });

  const itemMap = {};

  const ensureItem = itemId => {
    if (!itemId) return null;

    const key = itemId.toString();
    const item = itemMasterMap.get(key);

    if (!itemMap[key]) {
      itemMap[key] = {
        itemId: key,
        itemNo: item?.itemNo || '-',
        itemName: item?.itemName || '-',
        salesOrderQty: 0,
        salesOrderAmount: 0,
        salesOrderCount: 0,
        invoiceQty: 0,
        invoiceAmount: 0,
        invoiceCount: 0,
      };
    }

    return itemMap[key];
  };

  invoices.forEach(invoice => {
    const exchangeRate = invoice.exchangeRate ?? 1;
    const countQty = shouldCountSplitInvoiceQty(invoice, splitInvoiceMap);
    const invoiceItems = Array.isArray(invoice.items) ? invoice.items : [];

    const countedItemIds = new Set();

    invoiceItems.forEach(line => {
      if (!line?.itemId) return;

      const row = ensureItem(line.itemId);
      if (!row) return;

      const key = line.itemId.toString();
      const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

      row.invoiceAmount += (lineAmount || 0) * exchangeRate;

      if (countQty) {
        row.invoiceQty += Number(line.quantity || 0);
      }

      if (!countedItemIds.has(key)) {
        row.invoiceCount += 1;
        countedItemIds.add(key);
      }
    });
  });

  salesOrders.forEach(order => {
    const exchangeRate = order.exchangeRate ?? 1;
    const orderItems = Array.isArray(order.items) ? order.items : [];

    const countedItemIds = new Set();

    orderItems.forEach(line => {
      if (!line?.itemId) return;

      const row = ensureItem(line.itemId);
      if (!row) return;

      const key = line.itemId.toString();
      const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

      row.salesOrderAmount += (lineAmount || 0) * exchangeRate;
      row.salesOrderQty += Number(line.quantity || 0);

      if (!countedItemIds.has(key)) {
        row.salesOrderCount += 1;
        countedItemIds.add(key);
      }
    });
  });

  let result = Object.values(itemMap).map(row => ({
    itemId: row.itemId,
    itemNo: row.itemNo,
    itemName: row.itemName,
    salesOrderQty: row.salesOrderQty,
    salesOrderAmount: row.salesOrderAmount,
    invoiceQty: row.invoiceQty,
    invoiceAmount: row.invoiceAmount,
    invoiceCount: row.invoiceCount,
    salesOrderCount: row.salesOrderCount,
  }));

  if (options.sortBy) {
    const [sortField, sortOrder] = options.sortBy.split(':');
    const order = sortOrder === 'desc' ? -1 : 1;

    result.sort((a, b) => {
      const aValue = a[sortField] ?? 0;
      const bValue = b[sortField] ?? 0;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return order * aValue.localeCompare(bValue);
      }

      return order * (aValue - bValue);
    });
  } else {
    result.sort((a, b) => b.invoiceQty - a.invoiceQty);
  }

  const totalResults = result.length;
  const page = Number(options.page) > 0 ? Number(options.page) : 1;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
  const isPaginationEnabled = options.pagination !== 'false';
  const skip = (page - 1) * limit;

  const paginatedResults = isPaginationEnabled ? result.slice(skip, skip + limit) : result;
  const totalPages = isPaginationEnabled ? Math.ceil(totalResults / limit) || 1 : 1;

  return {
    customerDetails,
    result: paginatedResults,
    page,
    limit: isPaginationEnabled ? limit : totalResults,
    totalPages,
    totalResults,
  };
};

const getStateWiseDetails = async (stateId, filter, options = {}) => {
  const { Invoice } = getBooksModels();
  const { SalesOrder, PaymentReceived, Customer, Item } = getBooksCrmModels();
  const { State } = getAbssAdminModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const targetStateId = new mongoose.Types.ObjectId(stateId);

  const invoiceQuery = buildInvoiceFilter(filter);
  const salesOrderQuery = buildSalesOrderFilter(filter);
  const paymentQuery = buildPaymentFilter(filter);
  const overdueQuery = buildOverdueMatchStage(filter);

  const [invoices, overdueInvoices, salesOrders, payments, customers, items, stateDoc] = await Promise.all([
    Invoice.find(invoiceQuery)
      .select('_id customerId addressId items total exchangeRate isSplit splitWiseType splitInvoiceId')
      .lean(),
    Invoice.find(overdueQuery).select('_id customerId addressId balanceAmount exchangeRate').lean(),
    SalesOrder.find(salesOrderQuery).select('_id customerId addressId items total exchangeRate').lean(),
    PaymentReceived.find(paymentQuery).select('_id customerId addressId amountReceived exchangeRate').lean(),
    Customer.find({
      companyId,
      'Role.isCustomer': true,
    })
      .select('_id customerDisplayName customerNumber address companyName')
      .lean(),
    Item.find({ companyId }).select('_id itemNo itemName').lean(),
    State.findById(targetStateId).select('_id name').lean(),
  ]);

  if (!stateDoc) {
    return {
      result: [],
      page: 1,
      limit: 0,
      totalPages: 0,
      totalResults: 0,
    };
  }

  const targetStateName = (stateDoc.name || '').trim().toLowerCase();

  const customerMap = new Map();
  customers.forEach(customer => {
    customerMap.set(customer._id.toString(), customer);
  });

  const itemMap = new Map();
  items.forEach(item => {
    itemMap.set(item._id.toString(), item);
  });

  const splitInvoiceMap = buildSplitInvoiceMap(invoices);

  const getCustomerState = (customer, addressId) => {
    if (!customer) return '-';

    const customerAddress = customer.address || {};
    const billing = customerAddress.billing || null;
    const shipping = customerAddress.shipping || null;
    const additionalShippingAddresses = Array.isArray(customerAddress.additionalShippingAddresses)
      ? customerAddress.additionalShippingAddresses
      : [];

    const targetAddressId = addressId?.toString();

    const getStateFromAddress = addr => addr?.state?.trim() || addr?.address?.state?.trim() || '-';

    if (targetAddressId && billing?._id?.toString() === targetAddressId) {
      return getStateFromAddress(billing);
    }

    if (targetAddressId && shipping?._id?.toString() === targetAddressId) {
      return getStateFromAddress(shipping);
    }

    const matchedAdditional = additionalShippingAddresses.find(addr => addr?._id?.toString() === targetAddressId);
    if (matchedAdditional) {
      return getStateFromAddress(matchedAdditional);
    }

    return (
      getStateFromAddress(billing) || getStateFromAddress(shipping) || getStateFromAddress(additionalShippingAddresses[0]) || '-'
    );
  };

  const isTargetState = (customer, addressId) => {
    const state = getCustomerState(customer, addressId);
    return (state || '').trim().toLowerCase() === targetStateName;
  };

  const applySorting = (rows, defaultSortField) => {
    if (options.sortBy) {
      const [sortField, sortOrder] = options.sortBy.split(':');
      const order = sortOrder === 'desc' ? -1 : 1;

      rows.sort((a, b) => {
        const aValue = a[sortField] ?? 0;
        const bValue = b[sortField] ?? 0;

        if (typeof aValue === 'string' && typeof bValue === 'string') {
          return order * aValue.localeCompare(bValue);
        }

        return order * (aValue - bValue);
      });

      return rows;
    }

    rows.sort((a, b) => (b[defaultSortField] || 0) - (a[defaultSortField] || 0));
    return rows;
  };

  const applyPagination = rows => {
    const totalResults = rows.length;
    const page = Number(options.page) > 0 ? Number(options.page) : 1;
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
    const isPaginationEnabled = options.pagination !== 'false';

    if (!isPaginationEnabled) {
      return {
        result: rows,
        page: 1,
        limit: totalResults,
        totalPages: totalResults > 0 ? 1 : 0,
        totalResults,
      };
    }

    const skip = (page - 1) * limit;
    const paginatedResults = rows.slice(skip, skip + limit);
    const totalPages = Math.ceil(totalResults / limit) || 1;

    return {
      result: paginatedResults,
      page,
      limit,
      totalPages,
      totalResults,
    };
  };

  if (filter.tab === 'customer') {
    const customerDataMap = {};

    const ensureCustomer = customerId => {
      if (!customerId) return null;

      const key = customerId.toString();
      const customer = customerMap.get(key);

      if (!customerDataMap[key]) {
        customerDataMap[key] = {
          customerId: key,
          customerName: customer?.companyName || customer?.customerDisplayName || '-',
          customerNumber: customer?.customerNumber || '-',
          actualSales: 0,
          invoiceCount: 0,
          salesOrderCount: 0,
          salesOrderAmount: 0,
          collection: 0,
          dueAmount: 0,
          _invoiceIds: new Set(),
          _salesOrderIds: new Set(),
        };
      }

      return customerDataMap[key];
    };

    invoices.forEach(invoice => {
      if (!invoice.customerId) return;

      const customer = customerMap.get(invoice.customerId.toString());
      if (!isTargetState(customer, invoice.addressId)) return;

      const row = ensureCustomer(invoice.customerId);
      if (!row) return;

      row.actualSales += (invoice.total || 0) * (invoice.exchangeRate ?? 1);
      row._invoiceIds.add(invoice._id.toString());
    });

    overdueInvoices.forEach(invoice => {
      if (!invoice.customerId) return;

      const customer = customerMap.get(invoice.customerId.toString());
      if (!isTargetState(customer, invoice.addressId)) return;

      const row = ensureCustomer(invoice.customerId);
      if (!row) return;

      row.dueAmount += (invoice.balanceAmount || 0) * (invoice.exchangeRate ?? 1);
    });

    salesOrders.forEach(order => {
      if (!order.customerId) return;

      const customer = customerMap.get(order.customerId.toString());
      if (!isTargetState(customer, order.addressId)) return;

      const row = ensureCustomer(order.customerId);
      if (!row) return;

      row.salesOrderAmount += (order.total || 0) * (order.exchangeRate ?? 1);
      row._salesOrderIds.add(order._id.toString());
    });

    payments.forEach(payment => {
      if (!payment.customerId) return;

      const customer = customerMap.get(payment.customerId.toString());
      if (!isTargetState(customer, payment.addressId)) return;

      const row = ensureCustomer(payment.customerId);
      if (!row) return;

      row.collection += (payment.amountReceived || 0) * (payment.exchangeRate ?? 1);
    });

    let result = Object.values(customerDataMap).map(row => ({
      customerId: row.customerId,
      customerName: row.customerName,
      customerNumber: row.customerNumber,
      actualSales: row.actualSales,
      invoiceCount: row._invoiceIds.size,
      salesOrderCount: row._salesOrderIds.size,
      salesOrderAmount: row.salesOrderAmount,
      collection: row.collection,
      dueAmount: row.dueAmount,
    }));

    result = applySorting(result, 'actualSales');
    return applyPagination(result);
  }

  if (filter.tab === 'item') {
    const itemDataMap = {};

    const ensureItem = itemId => {
      if (!itemId) return null;

      const key = itemId.toString();
      const item = itemMap.get(key);

      if (!itemDataMap[key]) {
        itemDataMap[key] = {
          itemId: key,
          itemNo: item?.itemNo || '-',
          itemName: item?.itemName || '-',
          actualSales: 0,
          invoiceCount: 0,
          invoiceQty: 0,
          salesOrderCount: 0,
          salesOrderQty: 0,
          salesOrderAmount: 0,
          _invoiceIds: new Set(),
          _salesOrderIds: new Set(),
        };
      }

      return itemDataMap[key];
    };

    invoices.forEach(invoice => {
      if (!invoice.customerId) return;

      const customer = customerMap.get(invoice.customerId.toString());
      if (!isTargetState(customer, invoice.addressId)) return;

      const exchangeRate = invoice.exchangeRate ?? 1;
      const countQty = shouldCountSplitInvoiceQty(invoice, splitInvoiceMap);
      const invoiceItems = Array.isArray(invoice.items) ? invoice.items : [];

      invoiceItems.forEach(line => {
        if (!line?.itemId) return;

        const row = ensureItem(line.itemId);
        if (!row) return;

        const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

        row.actualSales += (lineAmount || 0) * exchangeRate;
        row._invoiceIds.add(invoice._id.toString());

        if (countQty) {
          row.invoiceQty += Number(line.quantity || 0);
        }
      });
    });

    salesOrders.forEach(order => {
      if (!order.customerId) return;

      const customer = customerMap.get(order.customerId.toString());
      if (!isTargetState(customer, order.addressId)) return;

      const exchangeRate = order.exchangeRate ?? 1;
      const orderItems = Array.isArray(order.items) ? order.items : [];

      orderItems.forEach(line => {
        if (!line?.itemId) return;

        const row = ensureItem(line.itemId);
        if (!row) return;

        const lineAmount = line.amount ?? line.total ?? (line.quantity || 0) * (line.rate || 0);

        row.salesOrderAmount += (lineAmount || 0) * exchangeRate;
        row.salesOrderQty += Number(line.quantity || 0);
        row._salesOrderIds.add(order._id.toString());
      });
    });

    let result = Object.values(itemDataMap).map(row => ({
      itemId: row.itemId,
      itemNo: row.itemNo,
      itemName: row.itemName,
      actualSales: row.actualSales,
      invoiceCount: row._invoiceIds.size,
      invoiceQty: row.invoiceQty,
      salesOrderCount: row._salesOrderIds.size,
      salesOrderQty: row.salesOrderQty,
      salesOrderAmount: row.salesOrderAmount,
    }));

    result = applySorting(result, 'actualSales');
    return applyPagination(result);
  }

  return {
    result: [],
    page: 1,
    limit: 0,
    totalPages: 0,
    totalResults: 0,
  };
};

// ─── 4. Customer Performance ──────────────────────────────────────────────────

const getCustomers = async filter => {
  const { Invoice } = getBooksModels();
  const { PaymentReceived } = getBooksCrmModels();

  const { state, city } = filter;

  const [invoices, payments, overdueInvoices] = await Promise.all([
    Invoice.find(buildInvoiceFilter(filter)).select('customerId total exchangeRate invoiceDate').lean(),
    PaymentReceived.find(buildPaymentFilter(filter)).select('customerId amountReceived exchangeRate').lean(),
    Invoice.find(buildOverdueMatchStage(filter)).select('customerId balanceAmount exchangeRate').lean(),
  ]);

  const allCustomerIds = extractCustomerIds(invoices, payments, overdueInvoices);
  const [customerLocationMap, balanceMap] = await Promise.all([
    buildCustomerLocationMap(allCustomerIds),
    buildCustomerBalanceMap(allCustomerIds),
  ]);

  const customerMap = {};

  invoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    const loc = customerLocationMap[custId] || {};
    if (loc.state !== state || loc.city !== city) return;

    if (!customerMap[custId]) {
      customerMap[custId] = {
        customerId: custId,
        customerName: loc.name,
        totalSales: 0,
        invoiceCount: 0,
        collection: 0,
        lastInvoiceDate: null,
        dueAmount: 0,
      };
    }

    customerMap[custId].totalSales += (inv.total || 0) * (inv.exchangeRate ?? 1);
    customerMap[custId].invoiceCount += 1;

    if (!customerMap[custId].lastInvoiceDate || inv.invoiceDate > customerMap[custId].lastInvoiceDate) {
      customerMap[custId].lastInvoiceDate = inv.invoiceDate;
    }
  });

  payments.forEach(pay => {
    const custId = pay.customerId?.toString();
    const loc = customerLocationMap[custId] || {};
    if (loc.state !== state || loc.city !== city) return;
    if (customerMap[custId]) customerMap[custId].collection += (pay.amountReceived || 0) * (pay.exchangeRate ?? 1);
  });

  overdueInvoices.forEach(inv => {
    const custId = inv.customerId?.toString();
    const loc = customerLocationMap[custId] || {};
    if (loc.state !== state || loc.city !== city) return;
    if (customerMap[custId]) customerMap[custId].dueAmount += (inv.balanceAmount || 0) * (inv.exchangeRate ?? 1);
  });

  const result = Object.values(customerMap)
    .map(c => ({ ...c, outstanding: balanceMap[c.customerId] || 0 }))
    .sort((a, b) => b.totalSales - a.totalSales);

  return { result };
};

// ─── 5. Inactive Customers (no invoice in last 90 days) ───────────────────────

const getInactiveCustomers = async filter => {
  const { Invoice } = getBooksModels();
  const { state, city } = filter;

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const matchStage = {
    ...buildInvoiceFilter({ ...filter, startDate: undefined, endDate: undefined }),
    companyId: new mongoose.Types.ObjectId(filter.companyId),
  };

  const latestInvoices = await Invoice.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$customerId',
        lastInvoiceDate: { $max: '$invoiceDate' },
        totalLifetime: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
    { $match: { lastInvoiceDate: { $lt: ninetyDaysAgo } } },
    { $sort: { lastInvoiceDate: -1 } },
  ]);

  const customerIds = latestInvoices.map(i => i._id?.toString()).filter(Boolean);
  const customerLocationMap = await buildCustomerLocationMap(customerIds);

  const result = latestInvoices
    .filter(inv => {
      const loc = customerLocationMap[inv._id?.toString()] || {};
      if (state && loc.state !== state) return false;
      if (city && loc.city !== city) return false;
      return true;
    })
    .map(inv => {
      const loc = customerLocationMap[inv._id?.toString()] || {};
      return {
        customerId: inv._id?.toString(),
        customerName: loc.name || '',
        state: loc.state || '',
        city: loc.city || '',
        lastInvoice: inv.lastInvoiceDate,
        totalLifetime: inv.totalLifetime,
      };
    });

  return { result };
};

// ─── 6. Non-Order Customers by State ─────────────────────────────────────────

const getNonOrderCustomers = async filter => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const allTimeInvoiceQuery = buildInvoiceFilter({ ...filter });

  const [allCustomers, orderedIds] = await Promise.all([
    Customer.find({ companyId: new mongoose.Types.ObjectId(filter.companyId), 'Role.isCustomer': true })
      .select('_id address.billing')
      .lean(),
    Invoice.distinct('customerId', allTimeInvoiceQuery),
  ]);

  const orderedSet = new Set(orderedIds.map(id => id.toString()));

  const stateMap = {};
  allCustomers
    .filter(c => !orderedSet.has(c._id.toString()))
    .forEach(c => {
      const state = c.address?.billing?.state?.trim() || '';
      if (state) stateMap[state] = (stateMap[state] || 0) + 1;
    });

  const result = Object.entries(stateMap)
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count);

  return { result };
};

// ─── 7. Non-Order Customer List ───────────────────────────────────────────────

const getNonOrderCustomerList = async filter => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { state, city } = filter;
  const allTimeInvoiceQuery = buildInvoiceFilter({ ...filter, startDate: undefined, endDate: undefined });

  const [allCustomers, orderedIds] = await Promise.all([
    Customer.find({ companyId: new mongoose.Types.ObjectId(filter.companyId), 'Role.isCustomer': true })
      .select('_id customerDisplayName address.billing customerPhoneNumber bpEmail')
      .lean(),
    Invoice.distinct('customerId', allTimeInvoiceQuery),
  ]);

  const orderedSet = new Set(orderedIds.map(id => id.toString()));

  const result = allCustomers
    .filter(c => {
      if (orderedSet.has(c._id.toString())) return false;
      if ((c.address?.billing?.state?.trim() || '') !== state) return false;
      if (city && (c.address?.billing?.city?.trim() || '') !== city) return false;
      return true;
    })
    .map(c => ({
      customerId: c._id.toString(),
      name: c.customerDisplayName || '',
      city: c.address?.billing?.city?.trim() || '',
      state: c.address?.billing?.state?.trim() || '',
      phone: c.customerPhoneNumber || '',
      email: c.bpEmail || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { result };
};

// ─── 8. Customer Invoices (drill-down) ───────────────────────────────────────

const getCustomerInvoices = async filter => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { customerId } = filter;
  const invoiceQuery = { ...buildInvoiceFilter(filter), customerId: new mongoose.Types.ObjectId(customerId) };

  const [customer, invoices] = await Promise.all([
    Customer.findById(customerId).select('customerDisplayName address.billing otherDetails companyLogo branch').lean(),
    Invoice.find(invoiceQuery)
      .select('invoiceId invoiceDate dueDate total paidAmount balanceAmount exchangeRate status')
      .sort({ invoiceDate: -1 })
      .lean(),
  ]);

  return {
    result: {
      customer: {
        name: customer?.customerDisplayName || '',
        city: customer?.address?.billing?.city || '',
        state: customer?.address?.billing?.state || '',
        gstinUin: customer?.otherDetails?.gstinUin || '',
        companyLogo: customer?.companyLogo || null,
      },
      summary: {
        totalBilled: invoices.reduce((s, i) => s + (i.total || 0) * (i.exchangeRate ?? 1), 0),
        totalCollection: invoices.reduce((s, i) => s + (i.paidAmount || 0) * (i.exchangeRate ?? 1), 0),
        outstanding: (customer?.branch || []).reduce((s, b) => s + (b.currentBalance || 0), 0),
        invoiceCount: invoices.length,
      },
      invoices: invoices.map(inv => ({
        _id: inv._id,
        invoiceId: inv.invoiceId || '',
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        total: (inv.total || 0) * (inv.exchangeRate ?? 1),
        paidAmount: (inv.paidAmount || 0) * (inv.exchangeRate ?? 1),
        balanceAmount: (inv.balanceAmount || 0) * (inv.exchangeRate ?? 1),
        status: inv.status || '',
      })),
    },
  };
};

// ─── 9. Item Group Analytics (all customers) ──────────────────────────────────

const getItemGroupAnalytics = async filter => {
  const { Invoice } = getBooksModels();
  const { Item, ItemGroup } = getBooksCrmModels();

  const { startDate, endDate } = resolveDashboardPeriodRange(filter);
  const invoiceQuery = {
    ...buildInvoiceFilter(filter),
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    invoiceDate: { $gte: startDate, $lte: endDate },
  };

  const invoiceItems = await Invoice.aggregate([
    {
      $match: invoiceQuery,
    },
    {
      $unwind: '$items',
    },
    {
      $project: {
        _id: 0,
        invoiceDate: 1,
        isSplit: 1,
        splitWiseType: 1,
        itemId: '$items.itemId',
        amount: {
          $multiply: [{ $ifNull: ['$items.amount', 0] }, { $ifNull: ['$exchangeRate', 1] }],
        },
        taxAmount: {
          $multiply: [{ $ifNull: ['$items.taxAmount', 0] }, { $ifNull: ['$exchangeRate', 1] }],
        },
        quantity: {
          $ifNull: ['$items.quantity', 0],
        },
      },
    },
  ]);

  const itemIds = [...new Set(invoiceItems.map(item => item.itemId?.toString()).filter(Boolean))].map(
    id => new mongoose.Types.ObjectId(id),
  );

  const items = itemIds.length
    ? await Item.find({ _id: { $in: itemIds } })
        .select('itemGroup')
        .lean()
    : [];

  const itemMap = new Map();
  items.forEach(item => {
    itemMap.set(item._id.toString(), item);
  });

  const itemGroupIds = [...new Set(items.map(item => item.itemGroup?.toString()).filter(Boolean))].map(
    id => new mongoose.Types.ObjectId(id),
  );

  const itemGroups = itemGroupIds.length
    ? await ItemGroup.find({ _id: { $in: itemGroupIds } })
        .select('name')
        .lean()
    : [];

  const itemGroupMap = new Map();
  itemGroups.forEach(group => {
    itemGroupMap.set(group._id.toString(), group.name);
  });

  const { seriesList, monthlySeries } = buildMonthlyItemGroupAnalytics(invoiceItems, itemMap, itemGroupMap, startDate, endDate);

  return {
    result: {
      period: {
        from: startDate,
        to: endDate,
      },
      monthlySales: {
        itemGroups: seriesList,
        months: monthlySeries.map(monthRow => ({
          month: monthRow.month,
          year: monthRow.year,
          label: monthRow.label,
          itemGroups: monthRow.series,
          grandTotal: monthRow.grandTotal,
        })),
      },
    },
  };
};

const resolveDashboardPeriodRange = filter => {
  if (filter.startDate && filter.endDate) {
    return {
      startDate: moment(filter.startDate).startOf('day').toDate(),
      endDate: moment(filter.endDate).endOf('day').toDate(),
    };
  }
  const { startDate, endDate } = resolveFinancialYearRange({});
  return { startDate, endDate };
};

const buildMonthlyItemGroupAnalytics = (invoiceItems, itemMap, itemGroupMap, startDate, endDate) => {
  const monthlyMap = new Map();

  for (const invItem of invoiceItems) {
    const invoiceDate = new Date(invItem.invoiceDate);

    const year = invoiceDate.getFullYear();
    const month = invoiceDate.getMonth() + 1;

    const sales = invItem.amount + invItem.taxAmount;

    let qty = invItem.quantity;

    if (invItem?.isSplit && invItem?.splitWiseType == 'Split By Price') {
      qty = 0;
    }

    const itemDoc = itemMap.get(invItem.itemId?.toString());

    if (!itemDoc?.itemGroup) continue;

    const groupName = itemGroupMap.get(itemDoc.itemGroup.toString());

    if (!groupName) continue;

    const key = `${year}-${String(month).padStart(2, '0')}-${groupName}`;

    if (!monthlyMap.has(key)) {
      monthlyMap.set(key, {
        _id: {
          year,
          month,
          series: groupName,
        },
        sales: 0,
        qty: 0,
      });
    }

    const row = monthlyMap.get(key);

    row.sales += sales;
    row.qty += qty;
  }

  const seriesMonthlyAgg = Array.from(monthlyMap.values());

  const monthlyBuckets = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cursor <= endDate) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    monthlyBuckets.push({
      key: `${year}-${String(month).padStart(2, '0')}`,
      year,
      month,
      monthLabel: cursor.toLocaleString('en-US', { month: 'short' }),
      displayLabel: `${cursor.toLocaleString('en-US', { month: 'short' })} '${String(year).slice(-2)}`,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const seriesSet = new Set();
  const seriesByMonth = new Map();

  for (const row of seriesMonthlyAgg) {
    const seriesName = row?._id?.series;
    if (!seriesName) continue;

    const monthKey = `${row._id.year}-${String(row._id.month).padStart(2, '0')}`;
    seriesSet.add(seriesName);

    if (!seriesByMonth.has(monthKey)) {
      seriesByMonth.set(monthKey, {});
    }
    seriesByMonth.get(monthKey)[seriesName] = {
      sales: row.sales || 0,
      qty: row.qty || 0,
    };
  }

  const seriesList = Array.from(seriesSet).sort((a, b) => a.localeCompare(b));

  const monthlySeries = monthlyBuckets.map(bucket => {
    const row = seriesByMonth.get(bucket.key) || {};
    let grandSales = 0;
    let grandQty = 0;

    for (const seriesName of seriesList) {
      const values = row[seriesName] || { sales: 0, qty: 0 };
      grandSales += values.sales;
      grandQty += values.qty;
    }

    const seriesValues = {};
    for (const seriesName of seriesList) {
      const values = row[seriesName] || { sales: 0, qty: 0 };
      seriesValues[seriesName] = {
        sales: values.sales,
        qty: values.qty,
        contribution: grandSales > 0 ? +((values.sales / grandSales) * 100).toFixed(1) : 0,
      };
    }

    return {
      month: bucket.monthLabel,
      year: bucket.year,
      label: bucket.displayLabel,
      series: seriesValues,
      grandTotal: { sales: grandSales, qty: grandQty },
    };
  });

  return { seriesList, monthlySeries };
};

const buildSplitInvoiceMap = invoices => {
  const splitInvoiceMap = new Map();

  for (const invoice of invoices || []) {
    if (invoice?.isSplit && invoice?._id) {
      splitInvoiceMap.set(invoice._id.toString(), invoice);
    }
  }

  return splitInvoiceMap;
};

const shouldCountSplitInvoiceQty = (invoice, splitInvoiceMap) => {
  if (!invoice?.splitInvoiceId) return true;

  const parentSplitInvoice = splitInvoiceMap.get(invoice.splitInvoiceId.toString());
  if (!parentSplitInvoice) return true;

  if (!invoice.isSplit && parentSplitInvoice.splitWiseType === 'Split By Price') {
    return false;
  }

  return true;
};

module.exports = {
  getSummary,
  getStateWise,
  getCityWise,
  getCustomerWise,
  getItemWise,
  getStateWiseGraph,
  getOrderInvoicePaymentTrend,
  getOrderStatusSummary,
  getItemWiseDetails,
  getCustomerWiseDetails,
  getStateWiseDetails,
  getCustomers,
  getInactiveCustomers,
  getNonOrderCustomers,
  getNonOrderCustomerList,
  getCustomerInvoices,
  getItemGroupAnalytics,
};
