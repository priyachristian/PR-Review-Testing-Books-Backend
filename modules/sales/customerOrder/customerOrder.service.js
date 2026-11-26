const httpStatus = require('http-status');
const mongoose = require('mongoose');
const { getBooksModels, getBooksCrmModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { CUSTOMER_ORDER_STATUS, NOTIFICATION_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');
const { CUSTOMER_ORDER_TYPE } = require('../../../utils/enum');
const ApiError = require('../../../utils/ApiError');
const { CUSTOMER_ORDER_MESSAGES } = require('../../../utils/messages');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const { enrichDocumentCurrency, getCurrency } = require('../../../services/currencyResolver.service');

const CUSTOMER_ORDER_NOTIFICATION_TYPE = {
  [CUSTOMER_ORDER_STATUS.UNDER_REVIEW]: NOTIFICATION_TYPE.CUSTOMER_ORDER_UNDER_REVIEW,
  [CUSTOMER_ORDER_STATUS.ACCEPTED]: NOTIFICATION_TYPE.CUSTOMER_ORDER_ACCEPTED,
  [CUSTOMER_ORDER_STATUS.REJECTED]: NOTIFICATION_TYPE.CUSTOMER_ORDER_REJECTED,
  [CUSTOMER_ORDER_STATUS.COMPLETED]: NOTIFICATION_TYPE.CUSTOMER_ORDER_COMPLETED,
};

const { SENT, UNDER_REVIEW, ACCEPTED, REJECTED, COMPLETED } = CUSTOMER_ORDER_STATUS;

// Allowed status changes per order type. Drafts are read-only for the supplier until the customer sends them.
const STATUS_TRANSITIONS = {
  [CUSTOMER_ORDER_TYPE.REGULAR]: {
    [SENT]: [ACCEPTED, REJECTED],
    [ACCEPTED]: [COMPLETED],
  },
  [CUSTOMER_ORDER_TYPE.SAMPLE]: {
    [SENT]: [UNDER_REVIEW, ACCEPTED, REJECTED],
    [UNDER_REVIEW]: [ACCEPTED, REJECTED],
    [ACCEPTED]: [COMPLETED],
  },
};

// An order placed from a sample catalog is a sample order; everything else, including older orders, is regular.
const orderTypeOf = order => (order?.sampleCatalogId ? CUSTOMER_ORDER_TYPE.SAMPLE : CUSTOMER_ORDER_TYPE.REGULAR);

const savedLimits = line => (line?.sampleMaxQty != null ? { minQty: line.sampleMinQty ?? 0, maxQty: line.sampleMaxQty } : null);

// Returns line => { minQty, maxQty } for a sample order, or null when not found.
// Limits saved on the line win; the current catalog is read only for older orders without them.
const loadSampleUnitLookup = async (order, companyId, session) => {
  if ((order.items || []).every(savedLimits)) return savedLimits;

  const { SampleCatalog } = getBooksModels();
  const query = SampleCatalog.findOne({ _id: order.sampleCatalogId, companyId }).select('items.itemId items.units');
  if (session) query.session(session);
  const catalog = await query.lean();
  // An item appears once per catalog, so itemId identifies the catalog line.
  const catalogLines = new Map((catalog?.items || []).map(line => [String(line.itemId), line]));
  return line =>
    savedLimits(line) ||
    catalogLines
      .get(String(line.itemId?._id || line.itemId))
      ?.units?.find(unit => String(unit.itemUnitId) === String(line.itemUnitId?._id || line.itemUnitId)) ||
    null;
};

// Sales order lines from a sample order must stay within the catalog's min/max; lines added in Books are not checked.
const assertSampleQuantitiesInRange = async ({ customerOrderId, companyId, items = [], session }) => {
  const { CustomerOrder } = getBooksModels();
  const order = await CustomerOrder.findOne({ _id: customerOrderId, companyId, sampleCatalogId: { $type: 'objectId' } })
    .select('sampleCatalogId items.itemId items.itemUnitId items.itemName items.itemUnit items.sampleMinQty items.sampleMaxQty')
    .session(session)
    .lean();
  if (!order) return;

  const unitFor = await loadSampleUnitLookup(order, companyId, session);
  const lineKey = (itemId, itemUnitId) => `${String(itemId)}:${String(itemUnitId)}`;
  const qtyByKey = new Map();
  items.forEach(line => {
    if (!line?.itemId || !line?.itemUnitId) return;
    const key = lineKey(line.itemId?._id || line.itemId, line.itemUnitId);
    qtyByKey.set(key, (qtyByKey.get(key) || 0) + (Number(line.quantity) || 0));
  });

  order.items.forEach(sampleLine => {
    const qty = qtyByKey.get(lineKey(sampleLine.itemId, sampleLine.itemUnitId));
    if (qty === undefined) return;
    const unit = unitFor(sampleLine);
    if (!unit) return;
    if (qty < unit.minQty || qty > unit.maxQty) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        CUSTOMER_ORDER_MESSAGES.SAMPLE_QTY_OUT_OF_RANGE(sampleLine.itemName, unit.minQty, unit.maxQty, sampleLine.itemUnit || ''),
      );
    }
  });
};

const queryCustomerOrders = async (filter, options) => {
  const { CustomerOrder } = getBooksModels();
  const { Customer, ItemUnit } = getBooksCrmModels();
  const { User, Company } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  if (filter.customerId) {
    query.customerId = new mongoose.Types.ObjectId(filter.customerId);
  }

  if (filter.sampleCatalogId) {
    query.sampleCatalogId = new mongoose.Types.ObjectId(filter.sampleCatalogId);
  } else if (filter.orderType === CUSTOMER_ORDER_TYPE.SAMPLE) {
    query.sampleCatalogId = { $type: 'objectId' };
  } else if (filter.orderType === CUSTOMER_ORDER_TYPE.REGULAR) {
    query.sampleCatalogId = null;
  }

  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter.startDate && filter.endDate) {
    query.createdAt = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());

    const customers = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const customerIds = customers.map(c => c._id);

    query.$or = [{ customerOrderId: searchRegex }, { customerId: { $in: customerIds } }];
  }

  const [paginatedResults, totalSum, company] = await Promise.all([
    CustomerOrder.paginate(query, options),
    CustomerOrder.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalAmount: {
            $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          },
        },
      },
    ]),
    Company.findById(companyId).select('baseCurrency').lean(),
  ]);
  const baseCurrency = await getCurrency(companyId, company?.baseCurrency);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await CustomerOrder.populate(paginatedResults.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  const orderIds = paginatedResults.results.map(o => o._id);
  const rawCurrencyRows = orderIds.length
    ? await CustomerOrder.find({ _id: { $in: orderIds } })
        .select('currency exchangeRate')
        .lean()
    : [];
  const rawCurrencyMap = new Map(rawCurrencyRows.map(row => [String(row._id), row]));

  const customerIds = [...new Set(paginatedResults.results.map(o => o.customerId?.toString()).filter(Boolean))];
  const customers = await Customer.find({ _id: { $in: customerIds } })
    .select('customerDisplayName companyName')
    .lean();
  const customerMap = customers.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const userActorIds = [];
  paginatedResults.results.forEach(order => {
    const addedByStr = order.addedBy?.toString();
    if (addedByStr && order.addedByType === 'User') userActorIds.push(addedByStr);
    if (order.updatedBy?.length > 0) {
      const last = order.updatedBy[order.updatedBy.length - 1];
      const updatedByStr = last.updatedBy?.toString();
      if (updatedByStr && last.updatedByType === 'User') userActorIds.push(updatedByStr);
    }
  });

  const usersResult = userActorIds.length
    ? await User.find({ _id: { $in: [...new Set(userActorIds)] } })
        .select('firstName lastName')
        .lean()
    : [];

  const userMap = usersResult.reduce((acc, u) => {
    acc[u._id.toString()] = { firstName: u.firstName, lastName: u.lastName };
    return acc;
  }, {});

  const populatedOrders = paginatedResults.results.map(order => {
    const orderObj = order.toObject ? order.toObject() : order;
    const rawCurrency = rawCurrencyMap.get(String(orderObj._id));
    orderObj.currency = rawCurrency?.currency ?? null;
    orderObj.exchangeRate = rawCurrency?.exchangeRate ?? null;
    const customer = customerMap[orderObj.customerId?.toString()];
    orderObj.customerId = customer || orderObj.customerId;

    // addedBy: if Customer portal user, reuse the customer name from customerMap
    if (orderObj.addedByType === 'Customer') {
      orderObj.addedBy = customer
        ? { firstName: customer.customerDisplayName || customer.companyName || '', lastName: '' }
        : null;
    } else {
      orderObj.addedBy = userMap[orderObj.addedBy?.toString()] || null;
    }

    // updatedBy: last entry in array
    let updatedBy = null;
    if (orderObj.updatedBy?.length > 0) {
      const last = orderObj.updatedBy[orderObj.updatedBy.length - 1];
      if (last.updatedByType === 'Customer') {
        updatedBy = customer ? { firstName: customer.customerDisplayName || customer.companyName || '', lastName: '' } : null;
      } else {
        updatedBy = userMap[last.updatedBy?.toString()] || null;
      }
    }
    orderObj.updatedBy = updatedBy;
    return orderObj;
  });

  const enrichedOrders = await enrichDocumentCurrency(companyId, populatedOrders);

  return {
    ...paginatedResults,
    results: enrichedOrders,
    totalAmount: totalSum[0]?.totalAmount || 0,
    currency: baseCurrency,
  };
};

const updateCustomerOrderStatus = async (customerOrderId, companyId, newStatus, userId, rejectionReason) => {
  const { CustomerOrder } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const order = await CustomerOrder.findOne({ _id: customerOrderId, companyId }).session(session);
    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Customer Order not found');
    }

    const allowed = STATUS_TRANSITIONS[orderTypeOf(order)][order.status] || [];
    if (!allowed.includes(newStatus)) {
      throw new ApiError(httpStatus.BAD_REQUEST, CUSTOMER_ORDER_MESSAGES.INVALID_STATUS_CHANGE(order.status, newStatus));
    }

    const oldStatus = order.status;
    order.status = newStatus;
    if (newStatus === REJECTED) order.rejectionReason = rejectionReason;
    order.updatedBy.push({ updatedByType: 'User', updatedBy: userId, updatedAt: new Date() });
    order.commentHistory.push({
      message: `Order status changed from ${oldStatus} to ${newStatus}${rejectionReason ? `: ${rejectionReason}` : ''}`,
      addedByType: 'User',
      addedBy: userId,
      timestamp: new Date(),
    });

    await order.save({ session });
    await session.commitTransaction();

    const notificationType = CUSTOMER_ORDER_NOTIFICATION_TYPE[newStatus];
    if (notificationType) {
      sendTransactionNotification({
        customerId: order.customerId,
        companyId: order.companyId,
        notificationType,
        entityId: order._id,
        entityDisplayId: order.customerOrderId,
        triggeredByUserId: userId,
      });
    }

    return order;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getCustomerOrderById = async (customerOrderId, companyId, branchId) => {
  const { CustomerOrder } = getBooksModels();
  const { Customer, ItemUnit } = getBooksCrmModels();
  const { User, CompanySettings } = getCommonModels();

  // ItemUnit lives in booksCrm, so pass the model explicitly
  const order = await CustomerOrder.findOne({ _id: customerOrderId, companyId })
    .populate({ path: 'items.itemUnitId', select: 'name', model: ItemUnit })
    .lean();

  if (!order) throw new ApiError(httpStatus.NOT_FOUND, 'Customer Order not found');

  const customer = await Customer.findById(order.customerId)
    .select(
      'customerDisplayName companyName address otherDetails _id customerPhoneNumber paymentTermsId useBranchPaymentTerms branch customerNumber',
    )
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  order.customerId = customer;

  order.shippingAddress = customer?.address?.shipping || {};
  order.orderType = orderTypeOf(order);

  if (order.orderType === CUSTOMER_ORDER_TYPE.SAMPLE) {
    const unitFor = await loadSampleUnitLookup(order, companyId);
    order.items = order.items.map(line => {
      const unit = unitFor(line);
      return { ...line, sampleMinQty: unit?.minQty ?? null, sampleMaxQty: unit?.maxQty ?? null };
    });
  }

  const userIdSet = new Set();

  if (order.addedByType === 'User' && order.addedBy) {
    userIdSet.add(order.addedBy.toString());
  }

  let lastUpdatedByEntry = null;
  if (Array.isArray(order.updatedBy) && order.updatedBy.length > 0) {
    lastUpdatedByEntry = order.updatedBy[order.updatedBy.length - 1];
    if (lastUpdatedByEntry.updatedByType === 'User' && lastUpdatedByEntry.updatedBy) {
      userIdSet.add(lastUpdatedByEntry.updatedBy.toString());
    }
  }

  if (order.commentHistory?.length) {
    order.commentHistory.filter(h => h.addedByType === 'User' && h.addedBy).forEach(h => userIdSet.add(h.addedBy.toString()));
  }

  const userIds = [...userIdSet];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }, 'firstName lastName email phone').lean() : [];
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  if (order.addedByType === 'Customer') {
    order.addedBy = customer ? { firstName: customer.customerDisplayName || '', lastName: '' } : null;
  } else {
    order.addedBy = userMap.get(order.addedBy?.toString()) || null;
  }

  if (lastUpdatedByEntry) {
    if (lastUpdatedByEntry.updatedByType === 'Customer') {
      order.updatedBy = customer ? { firstName: customer.customerDisplayName || '', lastName: '' } : null;
    } else {
      order.updatedBy = userMap.get(lastUpdatedByEntry.updatedBy?.toString()) || null;
    }
  } else {
    order.updatedBy = null;
  }

  if (order.commentHistory?.length) {
    order.commentHistory = order.commentHistory.map(h => ({
      ...h,
      createdAt: h.timestamp,
      addedBy:
        h.addedByType === 'User'
          ? userMap.get(h.addedBy?.toString()) || h.addedBy
          : customer
            ? { firstName: customer.customerDisplayName || '', lastName: '' }
            : h.addedBy,
    }));
  }
  order.paymentTermsId = order.paymentTermsId || null;

  return enrichDocumentCurrency(companyId, order);
};

module.exports = {
  queryCustomerOrders,
  updateCustomerOrderStatus,
  getCustomerOrderById,
  assertSampleQuantitiesInRange,
};
