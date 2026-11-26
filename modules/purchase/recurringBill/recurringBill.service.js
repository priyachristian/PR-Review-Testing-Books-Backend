const { SOURCE_TYPES, MODULE_NAMES, BILL_STATUSES, LEDGER_SOURCE_MODULES } = require('../../../utils/enum');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getBooksModels, getClientConnection, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const mongoose = require('mongoose');
const moment = require('moment');
const ApiError = require('../../../utils/ApiError');
const httpStatus = require('http-status');
const { RECURRING_BILL_MESSAGES, COMPANY_MESSAGES } = require('../../../utils/messages');
const { getInventoryConfig } = require('../../../utils/inventoryConfig');
const { defaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { RECURRING_BILL_STATUS, RECURRING_DOC_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
} = require('../../../services/warehouseBatch.service');
const { calculateDueDate, calculateFinalPrice } = require('../../../services/calculateDiscount.service');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { validateVendorForModule, updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const { preparePurchaseDocumentSave } = require('../../../services/purchaseDocumentGuard.service');
const ledgerService = require('../../accountant/ledger/ledger.service');

const createRecurringBill = async (billBody, userId) => {
  const { RecurringBills, RecurringConfig } = getBooksModels();
  const connection = await getClientConnection();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    billBody.recurringBillId = await generateUniqueId(
      RecurringBills,
      billBody.companyId,
      MODULE_NAMES.RECURRING_BILL,
      'recurringBillId',
      'RECB',
      session,
      billBody.recurringBillId,
    );
    const now = new Date();

    const company = await Company.findById(billBody.companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    const { activateVendorBranch, activateItemWarehouse } = billBody;
    delete billBody.activateVendorBranch;
    delete billBody.activateItemWarehouse;
    await preparePurchaseDocumentSave({
      vendorId: billBody.vendorId,
      branchId: billBody.branchId,
      warehouseId: billBody.warehouseId,
      items: billBody.items,
      companyId: billBody.companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'recurring bill',
    });

    let shippingAddressId = null;
    if (!billBody?.customerId) {
      if (billBody?.addressId === company?.address?._id?.toString()) {
        shippingAddressId = company?.address?._id;
      } else if (company?.additionalShippingAddresses?.some(address => address?._id?.toString() === billBody?.addressId)) {
        shippingAddressId = company?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === billBody?.addressId,
        )?._id;
      }
    } else {
      const customer = await Customer.findById(billBody.customerId);

      if (!customer) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Customer not found');
      }

      if (customer?.address?.shipping?._id?.toString() === billBody?.addressId?.toString()) {
        shippingAddressId = customer?.address?.shipping?._id;
      } else if (
        customer?.address?.additionalShippingAddresses?.some(
          address => address?._id?.toString() === billBody?.addressId?.toString(),
        )
      ) {
        shippingAddressId = customer?.address?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === billBody?.addressId?.toString(),
        )?._id;
      }
    }

    if (!shippingAddressId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
    }

    const nextExecutionDate = getNextExecutionDate(
      billBody.startDate,
      now,
      billBody.repeatEvery.frequency,
      billBody.repeatEvery.period,
    );

    const { currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
      companyId: billBody.companyId,
      vendorId: billBody.vendorId,
    });
    const currencyDoc = await getCurrency(billBody.companyId, currency);

    const commentHistory = [
      {
        message: `Recurring Bill created for ${currencyDoc?.symbol || '₹'}${billBody.total || 0}`,
        addedBy: userId,
        referenceType: 'RecurringBill',
        createdAt: new Date(),
      },
    ];

    const recurringBillData = {
      ...billBody,
      currency,
      exchangeRate: billBody.exchangeRate ?? 1,
      decimalPlaces,
      authorizedSignature: company?.authorizedSignature,
      addedBy: userId,
      nextExecutionDate: nextExecutionDate,
      commentHistory,
      updatedBy: userId,
      customerId: billBody.customerId,
      addressId: shippingAddressId,
    };
    const [bill] = await RecurringBills.create([recurringBillData], { session });

    // create recurring config
    const configObj = {
      companyId: bill.companyId,
      sourceType: SOURCE_TYPES.RECURRING_BILL,
      sourceId: bill._id,
      repeatEvery: bill.repeatEvery,
      nextOccurrence: bill.startDate,
      isActive: true,
    };

    await RecurringConfig.create([configObj], { session });

    await bill.save();
    await flushCompanyStockLevels(session);
    await session.commitTransaction();

    return enrichDocumentCurrency(billBody.companyId, bill.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryRecurringBills = async (filter, options) => {
  const { RecurringBills } = getBooksModels();
  const { User } = getCommonModels();
  const { Customer, Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  // date filter
  if (filter.recurringBillDate) {
    query.recurringBillDate = {
      $gte: new Date(filter.recurringBillDate),
      $lte: new Date(filter.recurringBillDate),
    };
  }

  if (filter.startDate && filter.endDate) {
    query.recurringBillDate = {
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
      { recurringBillId: searchRegex },
      { referenceNumber: searchRegex },
      { vendorId: { $in: customerIds } },
    ];
  }

  const result = await RecurringBills.paginate(query, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await RecurringBills.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  // Collect all customerIds from results
  const vendorIds = [...new Set(result.results.map(i => i.vendorId))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  // Collect all itemIds from results
  const itemIds = [...new Set(result.results.flatMap(bill => bill.items.map(item => item.itemId)))];
  const divisionIds = [...new Set(result.results.map(bill => bill.divisionId).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(bill => bill.branchId).filter(Boolean))];
  const warehouseIds = [...new Set(result.results.map(bill => bill.warehouseId).filter(Boolean))];

  // Get customer data
  const vendors = await Customer.find({
    _id: { $in: vendorIds },
  })
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails')
    .lean();

  // Get item data
  const items = await Item.find({
    _id: { $in: itemIds },
  })
    .select('itemName')
    .lean();

  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName')
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
  const vendorMap = vendors.reduce((acc, c) => {
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

  const populatedResults = result.results.map(bill => {
    const billObj = bill.toObject();
    billObj.id = billObj._id;
    billObj.vendorId = vendorMap[bill.vendorId?.toString()] || null;
    billObj.divisionName = divisionMap[bill.divisionId?.toString()]?.name || null;
    billObj.branchName = branchMap[bill.branchId?.toString()]?.name || null;
    billObj.warehouseName = warehouseMap[bill.warehouseId?.toString()]?.name || null;

    billObj.items = billObj.items.map(item => ({
      ...item,
      itemId: itemMap[item.itemId?.toString()] || null,
    }));

    billObj.addedBy = userMap[bill.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(billObj.updatedBy);
    billObj.updatedBy = updatedById ? (userMap[updatedById] ?? null) : null;

    return billObj;
  });

  return { ...result, results: await enrichDocumentCurrency(String(filter.companyId), populatedResults) };
};

const getRecurringBillById = async (id, companyId) => {
  const { RecurringBills, RecurringBillHistory } = getBooksModels();
  const { Company, User } = getCommonModels();
  const { Customer, Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
  // ItemUnit lives in booksCrm, so pass the model explicitly
  const recurringBill = await RecurringBills.findOne({ _id: id, companyId }).populate({
    path: 'items.itemUnitId',
    select: 'name',
    model: ItemUnit,
  });

  if (!recurringBill) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_BILL_MESSAGES.FETCH_NOT_FOUND);
  }

  let commentHistoryWithUser = [];
  if (recurringBill.commentHistory?.length) {
    const userIds = recurringBill.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = recurringBill.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy,
      };
    });
  }

  // Get all unique item IDs from the invoice items
  const itemIds = recurringBill.items.map(item => item.itemId);
  const addedBy = await User.findById(recurringBill.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(recurringBill.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findById(recurringBill.branchId).select('name');
  const division = await Division.findById(recurringBill.divisionId).select('name');
  const warehouse = await Warehouse.findById(recurringBill.warehouseId).select('name');
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

  const company = await Company.findById(recurringBill.companyId);
  let customer = null;
  let shippingAddress = null;
  if (!recurringBill.customerId) {
    if (recurringBill.addressId) {
      if (recurringBill?.addressId?.toString() === company?.address?._id?.toString()) {
        shippingAddress = company.address;
      }
      if (!shippingAddress) {
        shippingAddress = company?.additionalShippingAddresses?.find(
          addr => addr._id.toString() === recurringBill.addressId.toString(),
        );
      }
    }
  } else {
    customer = await Customer.findById(recurringBill.customerId);
    if (customer?.address?.shipping?._id.toString() === recurringBill?.addressId?.toString()) {
      shippingAddress = customer?.address?.shipping;
    } else if (
      customer?.address?.additionalShippingAddresses?.some(
        address => address._id.toString() === recurringBill?.addressId?.toString(),
      )
    ) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        address => address._id.toString() === recurringBill?.addressId?.toString(),
      );
    }
  }

  const recurringBillObj = recurringBill.toObject();
  const vendor = await Customer.findById(recurringBillObj?.vendorId)
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails branch isVendorDirectTax')
    .lean();

  recurringBillObj.branchName = branch.name;
  recurringBillObj.divisionName = division.name;
  recurringBillObj.warehouseName = warehouse.name;
  recurringBillObj.commentHistory = commentHistoryWithUser;
  recurringBillObj.addedBy = addedBy;
  recurringBillObj.updatedBy = updatedBy;

  // Populate item data
  recurringBillObj.items = recurringBillObj.items.map(item => ({
    ...item,
    itemId: item.itemId,
    itemName: itemMap[item.itemId?.toString()]?.itemName || null,
  }));

  recurringBillObj.vendor = vendor;
  if (customer) {
    recurringBillObj.customer = customer;
  }
  recurringBillObj.shippingAddress = shippingAddress;

  const history = await RecurringBillHistory.find({ recurringBillId: id }).sort({ createdAt: -1 }).lean();

  recurringBillObj.history = history;

  return enrichDocumentCurrency(companyId, recurringBillObj);
};

const updateRecurringBill = async (billId, updateBody, userId) => {
  const { RecurringBills } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();

  const company = await Company.findById(updateBody.companyId).populate('baseCurrency');
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  let shippingAddressId = null;
  if (!updateBody?.customerId) {
    if (updateBody?.addressId === company?.address?._id?.toString()) {
      shippingAddressId = company?.address?._id;
    } else if (company?.additionalShippingAddresses?.some(address => address?._id?.toString() === updateBody?.addressId)) {
      shippingAddressId = company?.additionalShippingAddresses?.find(
        address => address?._id?.toString() === updateBody?.addressId,
      )?._id;
    }
  } else {
    const customer = await Customer.findOne({ _id: updateBody.customerId, companyId: updateBody.companyId });

    if (!customer) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Customer not found');
    }

    if (customer?.address?.shipping?._id?.toString() === updateBody?.addressId?.toString()) {
      shippingAddressId = customer?.address?.shipping?._id;
    } else if (
      customer?.address?.additionalShippingAddresses?.some(
        address => address?._id?.toString() === updateBody?.addressId?.toString(),
      )
    ) {
      shippingAddressId = customer?.address?.additionalShippingAddresses?.find(
        address => address?._id?.toString() === updateBody?.addressId?.toString(),
      )?._id;
    }
  }

  if (!shippingAddressId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
  }

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  let bill;
  try {
    await session.startTransaction();
    // Read inside the transaction so carried items match the saved profile.
    bill = await RecurringBills.findOne({ _id: billId, companyId: updateBody.companyId }).session(session);
    if (!bill) {
      throw new ApiError(httpStatus.NOT_FOUND, RECURRING_BILL_MESSAGES.FETCH_NOT_FOUND);
    }
    if (bill.status !== RECURRING_DOC_STATUS.DRAFT) {
      throw new ApiError(httpStatus.BAD_REQUEST, RECURRING_BILL_MESSAGES.UPDATE_DRAFT_ONLY);
    }
    const originalItems = bill.items.map(item => ({ itemId: item.itemId }));

    if (updateBody.vendorId && String(updateBody.vendorId) !== String(bill.vendorId)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: bill.companyId,
        vendorId: updateBody.vendorId,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(bill.companyId, updateBody.currency || bill.currency);

    const oldTotal = bill.total || 0;
    const newTotal = updateBody.total || oldTotal;

    let updateMsg = 'Recurring Bill updated.';
    if (oldTotal !== newTotal) {
      updateMsg = `Recurring Bill updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldTotal} to ${currencyDoc?.symbol || '₹'}${newTotal}`;
    }

    bill.commentHistory = bill.commentHistory || [];
    bill.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });

    bill.updatedBy = userId;
    bill.addressId = shippingAddressId;
    bill.customerId = updateBody.customerId;

    const { activateVendorBranch, activateItemWarehouse } = updateBody;
    delete updateBody.activateVendorBranch;
    delete updateBody.activateItemWarehouse;
    Object.assign(bill, { ...updateBody, authorizedSignature: company?.authorizedSignature });
    await preparePurchaseDocumentSave({
      vendorId: bill.vendorId,
      branchId: bill.branchId,
      warehouseId: bill.warehouseId,
      items: updateBody.items,
      carriedItemIds: (originalItems || []).map(item => item.itemId),
      companyId: bill.companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'recurring bill',
    });
    await bill.save({ session });
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
  return enrichDocumentCurrency(bill.companyId, bill.toJSON());
};

const deleteRecurringBill = async (billId, companyId) => {
  const { RecurringBills, Bill } = getBooksModels();
  const bill = await RecurringBills.findOne({ _id: billId, companyId });

  if (!bill) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_BILL_MESSAGES.FETCH_NOT_FOUND);
  }
  if (bill.status !== RECURRING_DOC_STATUS.DRAFT) {
    throw new ApiError(httpStatus.BAD_REQUEST, RECURRING_BILL_MESSAGES.DELETE_DRAFT_ONLY);
  }

  await Bill.updateMany(
    { 'commentHistory.referenceId': bill._id },
    {
      $set: {
        'commentHistory.$[target].isDeleted': true,
      },
    },
    { arrayFilters: [{ 'target.referenceId': bill._id }] },
  );

  await RecurringBills.deleteOne({ _id: billId });
};

const updateRecurringBillStatus = async (billId, status, userId, companyId) => {
  const { RecurringBills, Bill } = getBooksModels();
  const bill = await RecurringBills.findOne({ _id: billId, companyId });
  if (!bill) {
    throw new ApiError(httpStatus.NOT_FOUND, RECURRING_BILL_MESSAGES.FETCH_NOT_FOUND);
  }

  const oldStatus = bill.status;

  if (status === RECURRING_DOC_STATUS.CANCELLED) {
    await Bill.updateMany(
      { 'commentHistory.referenceId': bill._id },
      {
        $set: {
          'commentHistory.$[target].isCancelled': true,
        },
      },
      { arrayFilters: [{ 'target.referenceId': bill._id }] },
    );
  }

  bill.commentHistory = bill.commentHistory || [];
  bill.commentHistory.push({
    message: `Status changed from ${oldStatus} to ${status}.`,
    addedBy: userId,
    createdAt: new Date(),
  });

  bill.status = status;
  bill.updatedBy = userId;

  await bill.save();
  return bill;
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
const createBillFromRecurringDoc = async (recurringBillHistoryId, userId, companyId) => {
  const { RecurringBills, Bill, RecurringBillHistory } = getBooksModels();
  const connection = await getClientConnection();
  const { Customer, PaymentTerm, Branch } = getBooksCrmModels();
  const { Company } = getCommonModels();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const recurringBillHistory = await RecurringBillHistory.findById(recurringBillHistoryId).session(session);
    if (!recurringBillHistory) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Recurring bill history record not found');
    }
    if (recurringBillHistory.status !== 'FAILED') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Bill can only be created from a failed history record');
    }

    const recurringBills = await RecurringBills.findById(recurringBillHistory.recurringBillId).session(session);
    if (!recurringBills) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Recurring bill template not found');
    }
    const now = new Date();

    const billDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.BILL, session);
    const company = await Company.findById(companyId).session(session);

    const ids = await generateMultipleUniqueIdsForModules(
      Bill,
      companyId,
      [
        {
          moduleName: MODULE_NAMES.BILL,
          idField: 'billId',
          defaultPrefix: 'BILL',
          count: 1,
          resultKey: 'mainBillId',
        },
      ],
      session,
    );

    const nextExecutionDate = getNextExecutionDate(
      recurringBillHistory.scheduledDate,
      recurringBillHistory?.executedDate,
      recurringBills.repeatEvery.frequency,
      recurringBills.repeatEvery.period,
    );

    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(recurringBills.vendorId),
      'branch.branchId': recurringBills.branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(recurringBills.vendorId, recurringBills.branchId, session);
    }

    await validateVendorForModule({
      vendorId: recurringBills.vendorId,
      branchId: recurringBills.branchId,
      companyId: recurringBills.companyId,
      totalAmount: recurringBills.total,
      addressId: recurringBills.addressId,
      moduleName: MODULE_NAMES.BILL,
      session,
      customerId: recurringBills.customerId,
      models: { Customer, Branch },
    });

    if (recurringBills?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: recurringBills.items,
          warehouseId: recurringBills.warehouseId,
          branchId: recurringBills.branchId,
          divisionId: recurringBills.divisionId,
          companyId: recurringBills.companyId,
        },
        session,
      );
    }

    const paymentTerm = recurringBills.paymentTermsId
      ? await PaymentTerm.findById(recurringBills.paymentTermsId).session(session).lean()
      : null;

    const billObj = {
      items: recurringBills.items,
      subTotal: recurringBills.subTotal,
      sgst: recurringBills.sgst,
      cgst: recurringBills.cgst,
      igst: recurringBills.igst,
      totalTax: recurringBills.totalTax,
      total: recurringBills.total,
      divisionId: recurringBills.divisionId,
      branchId: recurringBills.branchId,
      warehouseId: recurringBills.warehouseId,
      additionalCharges: recurringBills.additionalCharges,
      tax: recurringBills.tax,
      companyId: recurringBills.companyId,
      vendor: recurringBills.vendorId,
      billId: ids.mainBillId,
      dueDate: calculateDueDate(paymentTerm),
      paymentTermsId: recurringBills.paymentTermsId,
      customerNotes: recurringBills.customerNotes,
      termsAndConditions: recurringBills.termsAndConditions,
      authorizedSignature: recurringBills.authorizedSignature,
      status: BILL_STATUSES.DRAFT,
      attachments: recurringBills.billFile,
      isSplit: false,
      inventoryConfig,
      addedBy: userId,
      balanceAmount: recurringBills.total,
      billDate,
      addressId: recurringBills.addressId,
      customerId: recurringBills?.customerId,
      isRoundOff: recurringBills.isRoundOff,
      roundOffAmount: recurringBills.roundOffAmount,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
      discountConfig: recurringBills?.discountConfig,
      currency: recurringBills.currency,
      exchangeRate: recurringBills.exchangeRate,
      decimalPlaces: recurringBills.decimalPlaces,
      commentHistory: [
        {
          message: `Bill created from recurring bill ${recurringBills.recurringBillId}`,
          addedBy: userId,
          referenceType: 'RecurringBill',
          referenceId: recurringBills?._id,
          createdAt: new Date(),
        },
      ],
      recurringBillId: recurringBills?._id,
    };

    const [created] = await Bill.create([billObj], { session });

    await RecurringBillHistory.updateOne(
      {
        _id: recurringBillHistoryId,
      },
      {
        $set: {
          generatedBillId: created._id,
          generatedBillNumber: ids.mainBillId,
          status: RECURRING_BILL_STATUS.SUCCESS,
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

    if (inventoryConfig.stockAddEnabled && !recurringBills.customerId) {
      for (let item of created.items) {
        const finalPurchasePrice = calculateFinalPrice(item);

        // `item` already is the saved line, so batches land on the right line when an item repeats.
        const billItem = item;

        const warehouseStockObj = {
          action: 'addStock',
          stockData: {
            itemId: item.itemId,
            companyId: created.companyId,
            divisionId: created.divisionId,
            branchId: created.branchId,
            warehouseId: created.warehouseId,
            quantity: item.quantity,
            itemUnitId: item.itemUnitId,
            purchasePrice: finalPurchasePrice,
            vendorBatchNo: item?.vendorBatchNo,
            vendorBatchExpiry: item?.vendorBatchExpiry,
            sourceType: MODULE_NAMES.BILL,
            sourceId: created._id,
            addedBy: created.addedBy,
          },
          session,
        };

        const batchSummary = await handleWarehouseStock(warehouseStockObj);
        if (!batchSummary?.skipped && batchSummary) {
          const batchToAdd = {
            batchNo: batchSummary.batchNo,
            quantity: batchSummary.quantity,
            purchasePrice: batchSummary.purchasePrice,
            warehouseId: created.warehouseId,
            itemBatchId: batchSummary?._id,
          };

          if (billItem) {
            if (!billItem.batches) billItem.batches = [];
            billItem.batches.push(batchToAdd);
          }
        }
      }

      await checkCompanyStockLevels({
        itemIds: created.items.map(item => item.itemId),
        companyId: created.companyId,
        docType: MODULE_NAMES.BILL,
        docId: created._id,
        docNo: created.billId,
        userId,
        session,
      });

      await Bill.updateOne({ _id: created._id }, { $set: { items: created.items } }, { session });
    }

    await updateBranchCurrentBalance({
      customerId: recurringBills.vendorId,
      branchId: recurringBills.branchId,
      amount: recurringBills.total,
      session,
    });

    // Guard against double-posting if this history record is ever reprocessed for the same bill.
    await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: created._id }, session);
    await ledgerService.postBillJournal({ companyId, bill: created, addedBy: userId }, session);

    await flushCompanyStockLevels(session);

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
module.exports = {
  createRecurringBill: withTransientRetry(createRecurringBill),
  queryRecurringBills,
  getRecurringBillById,
  updateRecurringBill,
  deleteRecurringBill,
  createBillFromRecurringDoc: withTransientRetry(createBillFromRecurringDoc),
  updateRecurringBillStatus,
};
