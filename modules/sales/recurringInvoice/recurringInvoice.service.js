const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { SOURCE_TYPES, MODULE_NAMES, SALES_ORDER_INVOICE_STATUS, LEDGER_SOURCE_MODULES } = require('../../../utils/enum');
const { getBooksModels, getClientConnection, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const moment = require('moment');
const { RECURRING_INVOICE_MESSAGES, COMPANY_MESSAGES } = require('../../../utils/messages');
const { getPrimaryBank } = require('../../banking/bank/bank.service');
const { getInventoryConfig, validateStockAvailability } = require('../../../utils/inventoryConfig');
const { defaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
} = require('../../../services/warehouseBatch.service');
const {
  RECURRING_INVOICE_STATUS,
  RECURRING_DOC_STATUS,
  NOTIFICATION_TYPE,
} = require('@smit9313/abss-models-core/src/utils/enum');
const { calculateDueDate, calculateFinalPrice } = require('../../../services/calculateDiscount.service');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const {
  enrichDocumentItemLines,
  assertSelectableForNewLines,
  assertResolvable,
  assertLineUnitsValid,
  SNAPSHOT_MODE,
} = require('../../../services/documentItemEnricher.service');
const { validateCustomerForModule, updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const { processIncentiveEarn } = require('../../setting/incentiveScheme/incentiveScheme.service');
/**
 * Create a recurring invoice
 * @param {Object} recurringInvoiceBody
 * @param {string} userId
 * @returns {Promise<RecurringInvoice>}
 */
const createRecurringInvoice = async (recurringInvoiceBody, userId) => {
  const { RecurringInvoice, RecurringConfig } = getBooksModels();
  const { Company } = getCommonModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    const company = await Company.findById(recurringInvoiceBody.companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
    await session.startTransaction();

    recurringInvoiceBody.recurringInvoiceId = await generateUniqueId(
      RecurringInvoice,
      recurringInvoiceBody.companyId,
      MODULE_NAMES.RECURRING_INVOICE,
      'recurringInvoiceId',
      'RECI',
      session,
      recurringInvoiceBody.recurringInvoiceId,
    );

    const now = new Date();

    const { currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
      companyId: recurringInvoiceBody.companyId,
      customerId: recurringInvoiceBody.customerId,
    });
    const currencyDoc = await getCurrency(recurringInvoiceBody.companyId, currency);

    // Enforce item selectability: a newly added item must be active. (Display snapshot is repaired on read.)
    const itemSelectabilityCheck = await enrichDocumentItemLines(recurringInvoiceBody.items, {
      companyId: recurringInvoiceBody.companyId,
      warehouseId: recurringInvoiceBody.warehouseId,
      session,
      snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
    });
    assertSelectableForNewLines(itemSelectabilityCheck, 'recurring invoice');
    await assertLineUnitsValid(itemSelectabilityCheck, { companyId: recurringInvoiceBody.companyId, session });

    const commentHistory = [
      {
        message: `Recurring Invoice created for ${currencyDoc?.symbol || '₹'}${recurringInvoiceBody.total || 0}`,
        addedBy: userId,
        referenceType: 'RecurringInvoice',
        createdAt: new Date(),
      },
    ];

    const nextExecutionDate = getNextExecutionDate(
      recurringInvoiceBody.startDate,
      now,
      recurringInvoiceBody.repeatEvery.frequency,
      recurringInvoiceBody.repeatEvery.period,
    );
    const recurringInvoiceData = {
      ...recurringInvoiceBody,
      currency,
      exchangeRate: recurringInvoiceBody.exchangeRate ?? 1,
      decimalPlaces,
      authorizedSignature: company?.authorizedSignature,
      nextExecutionDate,
      addedBy: userId,
      commentHistory,
      updatedBy: userId,
    };

    const [recurringInvoice] = await RecurringInvoice.create([recurringInvoiceData], { session });

    // create recurring config
    const configObj = {
      companyId: recurringInvoice.companyId,
      sourceType: SOURCE_TYPES.RECURRING_INVOICE,
      sourceId: recurringInvoice._id,
      repeatEvery: recurringInvoice.repeatEvery,
      nextOccurrence: recurringInvoice.startDate,
      isActive: true,
    };

    await RecurringConfig.create([configObj], { session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return enrichDocumentCurrency(recurringInvoiceBody.companyId, recurringInvoice.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getNextRecurringInvoiceNumber = async companyId => {
  try {
    const { RecurringInvoice } = getBooksModels();

    const latestRecurringInvoiceNo = await RecurringInvoice.findOne(
      { companyId },
      { recurringInvoiceId: 1 },
      { sort: { createdAt: -1 } },
    );

    let nextNumber = 1;
    if (latestRecurringInvoiceNo && latestRecurringInvoiceNo.recurringInvoiceId) {
      const match = latestRecurringInvoiceNo.recurringInvoiceId.match(/REC-(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1], 10) + 1;
      }
    }

    return `REC-${nextNumber}`;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Error calculating the next recurring invoice number');
  }
};
/**
 * Query for recurring invoices
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @returns {Promise<QueryResult>}
 */
const queryRecurringInvoices = async (filter, options) => {
  const { RecurringInvoice } = getBooksModels();
  const { Customer, Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
  const { User } = getCommonModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const query = { companyId };

  // date filter
  if (filter.recurringInvoiceDate) {
    query.recurringInvoiceDate = {
      $gte: new Date(filter.recurringInvoiceDate),
      $lte: new Date(filter.recurringInvoiceDate),
    };
  }

  if (filter.startDate && filter.endDate) {
    query.recurringInvoiceDate = {
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

  // Search filtering
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search);

    const customers = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const customerIds = customers.map(c => c._id); // keep ObjectId

    query.$or = [
      { subject: searchRegex },
      { recurringInvoiceId: searchRegex },
      { referenceNumber: searchRegex },
      { customerId: { $in: customerIds } },
    ];
  }
  const result = await RecurringInvoice.paginate(query, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await RecurringInvoice.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  // Collect all customerIds from results
  const customerIds = [...new Set(result.results.map(i => i.customerId))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  // Collect all itemIds from results
  const itemIds = [...new Set(result.results.flatMap(invoice => invoice.items.map(item => item.itemId)))];
  const divisionIds = [...new Set(result.results.map(invoice => invoice.divisionId).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(invoice => invoice.branchId).filter(Boolean))];
  const warehouseIds = [...new Set(result.results.map(invoice => invoice.warehouseId).filter(Boolean))];

  // Get customer data
  const customers = await Customer.find({
    _id: { $in: customerIds },
  })
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails')
    .lean();

  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName')
    .lean();
  // Get item data
  const items = await Item.find({
    _id: { $in: itemIds },
  })
    .select('itemName')
    .lean();

  const [divisions, branches, warehouses] = await Promise.all([
    Division.find({ _id: { $in: divisionIds } })
      .select('name')
      .lean(),
    Branch.find({ _id: { $in: branchIds } })
      .select('name')
      .lean(),
    Warehouse.find({ _id: { $in: warehouseIds } })
      .select('name')
      .lean(),
  ]);

  // Create maps
  const customerMap = customers.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const itemMap = items.reduce((acc, i) => {
    acc[i._id.toString()] = i;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  const divisionMap = divisions.reduce((acc, division) => {
    acc[division._id.toString()] = division;
    return acc;
  }, {});

  const branchMap = branches.reduce((acc, branch) => {
    acc[branch._id.toString()] = branch;
    return acc;
  }, {});

  const warehouseMap = warehouses.reduce((acc, warehouse) => {
    acc[warehouse._id.toString()] = warehouse;
    return acc;
  }, {});

  const populatedResults = result.results.map(invoice => {
    const invoiceObj = invoice.toObject();
    invoiceObj.id = invoiceObj._id;
    invoiceObj.customerId = customerMap[invoice.customerId?.toString()] || null;
    invoiceObj.divisionName = divisionMap[invoice.divisionId?.toString()]?.name || null;
    invoiceObj.branchName = branchMap[invoice.branchId?.toString()]?.name || null;
    invoiceObj.warehouseName = warehouseMap[invoice.warehouseId?.toString()]?.name || null;

    invoiceObj.items = invoiceObj.items.map(item => ({
      ...item,
      itemId: itemMap[item.itemId?.toString()] || null,
    }));

    invoiceObj.addedBy = userMap[invoice.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(invoiceObj.updatedBy);
    invoiceObj.updatedBy = updatedById ? (userMap[updatedById] ?? null) : null;
    return invoiceObj;
  });
  const nextRecNo = await getNextRecurringInvoiceNumber(filter.companyId);

  const populatedResultsWithCurrency = await enrichDocumentCurrency(String(filter.companyId), populatedResults);

  return { ...result, results: populatedResultsWithCurrency, nextRecNo };
};

/**
 * Get recurring invoice by id
 * @param {ObjectId} id
 * @returns {Promise<RecurringInvoice>}
 */
const getRecurringInvoiceById = async (id, companyId) => {
  const { RecurringInvoice, RecurringInvoiceHistory } = getBooksModels();
  const { Customer, Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
  const { User } = getCommonModels();

  const recurringInvoice = await RecurringInvoice.findOne({ _id: id, companyId }).populate({
    path: 'items.itemUnitId',
    select: 'name',
    model: ItemUnit,
  });
  if (!recurringInvoice) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_INVOICE_MESSAGES.FETCH_NOT_FOUND);
  }

  const bank = await getPrimaryBank(recurringInvoice?.companyId, null);

  let commentHistoryWithUser = [];
  if (recurringInvoice.commentHistory?.length) {
    const userIds = recurringInvoice.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = recurringInvoice.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy,
      };
    });
  }
  // Get all unique item IDs from the invoice items
  const itemIds = recurringInvoice.items.map(item => item.itemId);
  const addedBy = await User.findById(recurringInvoice.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(recurringInvoice.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findById(recurringInvoice.branchId).select('name');
  const division = await Division.findById(recurringInvoice.divisionId).select('name');
  const warehouse = await Warehouse.findById(recurringInvoice.warehouseId).select('name');
  // Fetch all items in one query
  const items = await Item.find({
    _id: { $in: itemIds },
  })
    .select('itemName')
    .lean();

  // Create a map for quick item lookup
  const itemMap = items.reduce((acc, item) => {
    acc[item._id.toString()] = item;
    return acc;
  }, {});

  const recurringInvoiceObj = recurringInvoice.toObject();
  const customer = await Customer.findById(recurringInvoiceObj?.customerId)
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails isCustomerDirectTax')
    .lean();

  let shippingAddress = null;
  if (recurringInvoice.addressId) {
    if (recurringInvoice?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
      shippingAddress = customer.address.shipping;
    }

    if (!shippingAddress) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        addr => addr._id.toString() === recurringInvoice.addressId.toString(),
      );
    }
  }

  recurringInvoiceObj.branchName = branch.name;
  recurringInvoiceObj.divisionName = division.name;
  recurringInvoiceObj.warehouseName = warehouse.name;
  recurringInvoiceObj.commentHistory = commentHistoryWithUser;
  recurringInvoiceObj.addedBy = addedBy;
  recurringInvoiceObj.updatedBy = updatedBy;
  recurringInvoiceObj.bankAccountId = bank;
  // Populate item data
  recurringInvoiceObj.items = recurringInvoiceObj.items.map(item => ({
    ...item,
    itemId: item.itemId,
    itemName: itemMap[item.itemId?.toString()]?.itemName || null,
  }));

  recurringInvoiceObj.customerId = customer;
  recurringInvoiceObj.shippingAddress = shippingAddress || null;

  const history = await RecurringInvoiceHistory.find({ recurringInvoiceId: id }).sort({ createdAt: -1 }).lean();

  recurringInvoiceObj.history = history;

  // Repair any blank snapshot from the Item master and attach a per-line itemIssue for the UI warning.
  recurringInvoiceObj.items = await enrichDocumentItemLines(recurringInvoiceObj.items, {
    companyId,
    warehouseId: recurringInvoiceObj.warehouseId,
    snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
  });

  return enrichDocumentCurrency(companyId, recurringInvoiceObj);
};

const updateRecurringInvoiceById = async (recurringInvoiceId, updateBody, userId) => {
  const { RecurringInvoice } = getBooksModels();
  const { Company } = getCommonModels();
  const recurringInvoice = await RecurringInvoice.findById(recurringInvoiceId);
  if (!recurringInvoice) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_INVOICE_MESSAGES.FETCH_NOT_FOUND);
  }
  if (recurringInvoice.status !== RECURRING_DOC_STATUS.DRAFT) {
    throw new ApiError(httpStatus.BAD_REQUEST, RECURRING_INVOICE_MESSAGES.UPDATE_DRAFT_ONLY);
  }

  // Enforce item selectability on update: newly added items must be active; items already on the
  // template are tolerated even if deactivated afterwards. (Display snapshot is repaired on read.)
  if (Array.isArray(updateBody.items) && updateBody.items.length) {
    const existingItemIds = new Set((recurringInvoice.items || []).map(line => line.itemId?.toString()));
    const enrichedUpdateItems = await enrichDocumentItemLines(updateBody.items, {
      companyId: recurringInvoice.companyId,
      warehouseId: updateBody.warehouseId,
      snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
    });
    assertResolvable(enrichedUpdateItems);
    assertSelectableForNewLines(
      enrichedUpdateItems.filter(line => line.itemId && !existingItemIds.has(String(line.itemId))),
      'recurring invoice',
    );
  }

  const company = await Company.findById(recurringInvoice.companyId).populate('baseCurrency');
  if (!company) throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);

  const { customerId } = updateBody;
  if (customerId && String(customerId) !== String(recurringInvoice.customerId)) {
    const { currency, decimalPlaces } = await resolveTransactionCurrency({
      companyId: recurringInvoice.companyId,
      customerId,
    });
    updateBody.currency = currency;
    updateBody.decimalPlaces = decimalPlaces;
  }
  updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

  const currencyDoc = await getCurrency(recurringInvoice.companyId, updateBody.currency || recurringInvoice.currency);

  const oldTotal = recurringInvoice.total || 0;
  const newTotal = updateBody.total || oldTotal;

  let updateMsg = 'Recurring Invoice updated.';

  if (oldTotal !== newTotal) {
    updateMsg = `Recurring Invoice updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldTotal} to ${currencyDoc?.symbol || '₹'}${newTotal}`;
  }

  recurringInvoice.commentHistory = recurringInvoice.commentHistory || [];

  recurringInvoice.commentHistory.push({
    message: updateMsg,
    addedBy: userId,
    createdAt: new Date(),
  });

  Object.assign(recurringInvoice, {
    ...updateBody,
    updatedBy: userId,
    authorizedSignature: company?.authorizedSignature,
  });

  await recurringInvoice.save();
  return enrichDocumentCurrency(recurringInvoice.companyId, recurringInvoice.toJSON());
};

const updateRecurringInvoiceStatus = async (recurringInvoiceId, status, userId, companyId) => {
  const { RecurringInvoice, Invoice } = getBooksModels();
  const recurringInvoice = await RecurringInvoice.findOne({ _id: recurringInvoiceId, companyId });
  if (!recurringInvoice) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_INVOICE_MESSAGES.FETCH_NOT_FOUND);
  }

  const oldStatus = recurringInvoice.status;

  if (status === RECURRING_DOC_STATUS.CANCELLED) {
    await Invoice.updateMany(
      { 'commentHistory.referenceId': recurringInvoice._id },
      {
        $set: {
          'commentHistory.$[target].isCancelled': true,
        },
      },
      { arrayFilters: [{ 'target.referenceId': recurringInvoice._id }] },
    );
  }

  recurringInvoice.commentHistory = recurringInvoice.commentHistory || [];
  recurringInvoice.commentHistory.push({
    message: `Status changed from ${oldStatus} to ${status}.`,
    addedBy: userId,
    createdAt: new Date(),
  });

  recurringInvoice.status = status;
  recurringInvoice.updatedBy = userId;

  await recurringInvoice.save();
  return recurringInvoice;
};

/**
 * Delete recurring invoice by id
 * @param {ObjectId} recurringInvoiceId
 * @returns {Promise<RecurringInvoice>}
 */
const deleteRecurringInvoiceById = async (recurringInvoiceId, companyId) => {
  const { RecurringInvoice, Invoice } = getBooksModels();
  const recurringInvoice = await RecurringInvoice.findOne({ _id: recurringInvoiceId, companyId });
  if (!recurringInvoice) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_INVOICE_MESSAGES.FETCH_NOT_FOUND);
  }
  if (recurringInvoice.status !== RECURRING_DOC_STATUS.DRAFT) {
    throw new ApiError(httpStatus.BAD_REQUEST, RECURRING_INVOICE_MESSAGES.DELETE_DRAFT_ONLY);
  }

  await Invoice.updateMany(
    { 'commentHistory.referenceId': recurringInvoice._id },
    {
      $set: {
        'commentHistory.$[target].isDeleted': true,
      },
    },
    { arrayFilters: [{ 'target.referenceId': recurringInvoice._id }] },
  );

  await RecurringInvoice.deleteOne({ _id: recurringInvoiceId });
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

const createInvoiceFromRecurringDoc = async (recurringInvoiceHistoryId, userId, companyId) => {
  const { RecurringInvoice, Invoice, RecurringInvoiceHistory } = getBooksModels();
  const connection = await getClientConnection();
  const { Customer, Branch, PaymentTerm } = getBooksCrmModels();
  const { Company } = getCommonModels();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const recurringInvoiceHistory = await RecurringInvoiceHistory.findById(recurringInvoiceHistoryId).session(session);
    if (!recurringInvoiceHistory) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Recurring invoice history record not found');
    }
    if (recurringInvoiceHistory.status !== 'FAILED') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invoice can only be created from a failed history record');
    }

    const recurringInvoice = await RecurringInvoice.findById(recurringInvoiceHistory.recurringInvoiceId).session(session);
    if (!recurringInvoice) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Recurring invoice template not found');
    }
    const now = new Date();

    const invoiceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.INVOICE, session);
    const company = await Company.findById(companyId).session(session);

    const ids = await generateMultipleUniqueIdsForModules(
      Invoice,
      companyId,
      [
        {
          moduleName: MODULE_NAMES.INVOICE,
          idField: 'invoiceId',
          defaultPrefix: 'INV',
          count: 1,
          resultKey: 'mainInvoiceId',
        },
      ],
      session,
    );

    const nextExecutionDate = getNextExecutionDate(
      recurringInvoiceHistory.scheduledDate,
      recurringInvoiceHistory?.executedDate,
      recurringInvoice.repeatEvery.frequency,
      recurringInvoice.repeatEvery.period,
    );

    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(recurringInvoice.customerId),
      'branch.branchId': recurringInvoice.branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(recurringInvoice.customerId, recurringInvoice.branchId, session);
    }

    await validateCustomerForModule({
      customerId: recurringInvoice.customerId,
      branchId: recurringInvoice.branchId,
      companyId: recurringInvoice.companyId,
      totalAmount: recurringInvoice.total,
      addressId: recurringInvoice.addressId,
      moduleName: MODULE_NAMES.INVOICE,
      session,
      models: { Customer, Branch, Invoice },
    });

    if (recurringInvoice?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: recurringInvoice.items,
          warehouseId: recurringInvoice.warehouseId,
          branchId: recurringInvoice.branchId,
          divisionId: recurringInvoice.divisionId,
          companyId: recurringInvoice.companyId,
        },
        session,
      );
    }

    if (inventoryConfig?.stockCheckEnabled || inventoryConfig?.stockDeductEnabled) {
      await validateStockAvailability(
        { items: recurringInvoice.items, companyId: recurringInvoice.companyId, warehouseId: recurringInvoice.warehouseId },
        session,
      );
    }

    const primaryBank = await getPrimaryBank(companyId, session);

    const paymentTerm = recurringInvoice.paymentTermsId
      ? await PaymentTerm.findById(recurringInvoice.paymentTermsId).session(session).lean()
      : null;

    const invoiceObj = {
      items: recurringInvoice.items,
      subTotal: recurringInvoice.subTotal,
      sgst: recurringInvoice.sgst,
      cgst: recurringInvoice.cgst,
      igst: recurringInvoice.igst,
      totalTax: recurringInvoice.totalTax,
      total: recurringInvoice.total,
      divisionId: recurringInvoice.divisionId,
      branchId: recurringInvoice.branchId,
      warehouseId: recurringInvoice.warehouseId,
      additionalCharges: recurringInvoice.additionalCharges,
      tax: recurringInvoice.tax,
      companyId: recurringInvoice.companyId,
      customerId: recurringInvoice.customerId,
      invoiceId: ids.mainInvoiceId,
      referenceNumber: recurringInvoice.referenceNumber,
      dueDate: calculateDueDate(paymentTerm),
      paymentTermsId: recurringInvoice.paymentTermsId,
      subject: recurringInvoice.subject,
      customerNotes: recurringInvoice.customerNotes,
      termsAndConditions: recurringInvoice.termsAndConditions,
      authorizedSignature: recurringInvoice.authorizedSignature,
      attachments: recurringInvoice.attachments,
      priceListId: recurringInvoice.priceListId,
      isSplit: false,
      status: SALES_ORDER_INVOICE_STATUS.DRAFT,
      balanceAmount: recurringInvoice.total,
      inventoryConfig,
      invoiceDate,
      addressId: recurringInvoice.addressId,
      addedBy: userId,
      isRoundOff: recurringInvoice.isRoundOff,
      roundOffAmount: recurringInvoice.roundOffAmount,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
      bankAccountId: primaryBank?.accountId,
      appliesTo: recurringInvoice?.appliesTo,
      discountConfig: recurringInvoice?.discountConfig,
      currency: recurringInvoice.currency,
      exchangeRate: recurringInvoice.exchangeRate,
      decimalPlaces: recurringInvoice.decimalPlaces,
      commentHistory: [
        {
          message: `Invoice created from recurring invoice ${recurringInvoice.recurringInvoiceId}`,
          addedBy: userId,
          referenceType: 'RecurringInvoice',
          referenceId: recurringInvoice?._id,
          createdAt: new Date(),
        },
      ],
      recurringInvoiceId: recurringInvoice?._id,
    };

    const [created] = await Invoice.create([invoiceObj], { session });

    await RecurringInvoiceHistory.updateOne(
      { _id: recurringInvoiceHistoryId },
      {
        $set: {
          generatedInvoiceId: created._id,
          generatedInvoiceNumber: ids.mainInvoiceId,
          status: RECURRING_INVOICE_STATUS.SUCCESS,
          nextExecutionDate,
        },
        $unset: { errorMessage: '', metadata: '' },
      },
      {
        session,
      },
    );

    if (inventoryConfig?.stockDeductEnabled) {
      for (let item of created.items) {
        const finalSellingPrice = calculateFinalPrice(item);

        const warehouseStockObj = {
          action: 'deductStock',
          stockData: {
            itemId: item.itemId,
            companyId: created.companyId,
            branchId: created.branchId,
            warehouseId: created.warehouseId,
            quantity: item.quantity,
            itemUnitId: item.itemUnitId,
            deductedSourceType: MODULE_NAMES.INVOICE,
            deductedSourceId: created._id,
            sellingPrice: finalSellingPrice,
          },
          session,
        };

        const deductionSummary = await handleWarehouseStock(warehouseStockObj);

        if (!item.batches) item.batches = [];
        item.batches.push(...deductionSummary);
      }

      await checkCompanyStockLevels({
        itemIds: created.items.map(item => item.itemId),
        companyId: created.companyId,
        docType: MODULE_NAMES.INVOICE,
        docId: created._id,
        docNo: created.invoiceId,
        userId,
        session,
      });

      await Invoice.updateOne({ _id: created._id }, { $set: { items: created.items } }, { session });
    }

    await updateBranchCurrentBalance({
      customerId: recurringInvoice.customerId,
      branchId: recurringInvoice.branchId,
      amount: recurringInvoice.total,
      session,
    });

    // Guard against double-posting if this history record is ever reprocessed for the same invoice.
    await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: created._id }, session);
    await ledgerService.postInvoiceJournal({ companyId, invoice: created, addedBy: userId }, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: recurringInvoice.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.INVOICE_CREATED,
      entityId: created._id,
      entityDisplayId: created.invoiceId,
      triggeredByUserId: userId,
    });

    processIncentiveEarn(companyId, userId, 'INVOICE', created._id, created.total, created.items);

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

module.exports = {
  createRecurringInvoice: withTransientRetry(createRecurringInvoice),
  queryRecurringInvoices,
  getRecurringInvoiceById,
  updateRecurringInvoiceById,
  deleteRecurringInvoiceById,
  createInvoiceFromRecurringDoc: withTransientRetry(createInvoiceFromRecurringDoc),
  updateRecurringInvoiceStatus,
};
