const httpStatus = require('http-status');
const { getBooksCrmModels, getCommonModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const mongoose = require('mongoose');
const {
  SALES_ORDER_STATUS,
  INVOICE_STATUS,
  BILL_STATUSES,
  DELIVERY_CHALLAN_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  GENERAL_SALES_ANALYTICS_BASIS,
  GENERAL_SALES_ANALYTICS_MODULES,
  MODULE_LABELS,
  MODULE_DATA_KEYS,
  QUOTE_STATUS,
  PAYMENT_STATUS,
} = require('../../../utils/enum');
const moment = require('moment');
const { exportToExcel } = require('../../../utils/excelExport');

const SPLIT_BY_PRICE = 'Split By Price';
const SPLIT_BY_QTY = 'Split By Qty';

const applySorting = (data, sortBy) => {
  if (!sortBy) return data;
  const [field, order = 'desc'] = sortBy.split(':');
  const direction = order.toLowerCase() === 'asc' ? 1 : -1;

  return data.sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];

    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return aVal.localeCompare(bVal) * direction;
    }

    return (aVal - bVal) * direction;
  });
};

const getCustomerAggregation = async (Model, matchQuery, itemIdsFilter = null) => {
  const initialMatch = itemIdsFilter ? { ...matchQuery, 'items.itemId': { $in: itemIdsFilter } } : matchQuery;
  const pipeline = [{ $match: initialMatch }, { $unwind: '$items' }];

  if (itemIdsFilter) {
    pipeline.push({ $match: { 'items.itemId': { $in: itemIdsFilter } } });
  }

  pipeline.push({
    $group: {
      _id: '$customerId',
      totalQty: { $sum: '$items.quantity' },
      totalValue: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
    },
  });

  return Model.aggregate(pipeline);
};

const getSplitCustomerAggregation = async (Model, matchQuery, itemIdsFilter = null) => {
  const baseMatch = { ...matchQuery, isSplit: true };
  const initialMatch = itemIdsFilter ? { ...baseMatch, 'items.itemId': { $in: itemIdsFilter } } : baseMatch;
  const pipeline = [{ $match: initialMatch }, { $unwind: '$items' }];

  if (itemIdsFilter) {
    pipeline.push({ $match: { 'items.itemId': { $in: itemIdsFilter } } });
  }

  pipeline.push({
    $group: {
      _id: { customerId: '$customerId', splitWiseType: '$splitWiseType' },
      totalQty: { $sum: '$items.quantity' },
      totalValue: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
    },
  });

  return Model.aggregate(pipeline);
};

const mergeSplitCustomerData = (customerMap, data, emptyCustomerFactory, splitFields) => {
  data.forEach(row => {
    const customerId = row._id?.customerId?.toString();
    if (!customerId) return;

    if (!customerMap.has(customerId)) {
      customerMap.set(customerId, emptyCustomerFactory(row._id?.customerId));
    }

    const existing = customerMap.get(customerId);

    let type = row._id?.splitWiseType;

    if (!type) {
      type = SPLIT_BY_QTY;
    }

    if (type === SPLIT_BY_QTY) {
      existing[splitFields.qtyByQty] = (existing[splitFields.qtyByQty] || 0) + row.totalQty;
      existing[splitFields.valueByQty] = (existing[splitFields.valueByQty] || 0) + row.totalValue;
    }

    if (type === SPLIT_BY_PRICE) {
      existing[splitFields.qtyByPrice] = (existing[splitFields.qtyByPrice] || 0) + row.totalQty;
      existing[splitFields.valueByPrice] = (existing[splitFields.valueByPrice] || 0) + row.totalValue;
    }
  });
};

const topCustomersOfSales = async filter => {
  const { SalesOrder, Customer, Quote } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const showSplit = filter?.isSplit === true || filter?.isSplit === 'true';

  const soMatch = {
    ...buildMatchQuery(filter, 'orderDate'),
    status: { $ne: SALES_ORDER_STATUS.CANCELLED },
  };

  const quoteMatch = {
    ...buildMatchQuery(filter, 'quoteDate'),
    status: { $ne: QUOTE_STATUS.CANCELLED },
  };

  const dcMatch = {
    ...buildMatchQuery(filter, 'challanDate'),
    status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
  };

  const invMatch = {
    ...buildMatchQuery(filter, 'invoiceDate'),
    status: { $ne: INVOICE_STATUS.CANCELLED },
    isSplit: { $ne: true },
  };

  const itemIdsFilter = await resolveItemIdsFilter(filter);

  const [quoteData, soData, dcData, invData] = await Promise.all([
    getCustomerAggregation(Quote, quoteMatch, itemIdsFilter),
    getCustomerAggregation(SalesOrder, soMatch, itemIdsFilter),
    getCustomerAggregation(DeliveryChallan, dcMatch, itemIdsFilter),
    getCustomerAggregation(Invoice, invMatch, itemIdsFilter),
  ]);

  let splitInvData = [];

  if (showSplit) {
    splitInvData = await getSplitCustomerAggregation(
      Invoice,
      {
        ...buildMatchQuery(filter, 'invoiceDate'),
        status: { $ne: INVOICE_STATUS.CANCELLED },
      },
      itemIdsFilter,
    );
  }

  const customerMap = new Map();

  const invoiceSplitFields = {
    qtyByQty: 'invoiceSplitByQtyQty',
    valueByQty: 'invoiceSplitByQtyValue',
    qtyByPrice: 'invoiceSplitByPriceQty',
    valueByPrice: 'invoiceSplitByPriceValue',
  };

  const createEmptyCustomer = customerId => ({
    customerId,
    quoteQty: 0,
    quoteValue: 0,
    salesOrderQty: 0,
    salesOrderValue: 0,
    dcQty: 0,
    dcValue: 0,
    invoiceQty: 0,
    invoiceValue: 0,
    invoiceSplitByQtyQty: 0,
    invoiceSplitByQtyValue: 0,
    invoiceSplitByPriceQty: 0,
    invoiceSplitByPriceValue: 0,
  });

  const mergeData = (data, type) => {
    data.forEach(customer => {
      const id = customer._id?.toString();
      if (!id || id === 'null') return;

      if (!customerMap.has(id)) {
        customerMap.set(id, createEmptyCustomer(customer._id));
      }

      const existing = customerMap.get(id);

      if (type === 'quote') {
        existing.quoteQty = customer.totalQty;
        existing.quoteValue = customer.totalValue;
      }

      if (type === 'so') {
        existing.salesOrderQty = customer.totalQty;
        existing.salesOrderValue = customer.totalValue;
      }

      if (type === 'dc') {
        existing.dcQty = customer.totalQty;
        existing.dcValue = customer.totalValue;
      }

      if (type === 'inv') {
        existing.invoiceQty = customer.totalQty;
        existing.invoiceValue = customer.totalValue;
      }
    });
  };

  mergeData(quoteData, 'quote');
  mergeData(soData, 'so');
  mergeData(dcData, 'dc');
  mergeData(invData, 'inv');

  if (showSplit) {
    mergeSplitCustomerData(customerMap, splitInvData, createEmptyCustomer, invoiceSplitFields);
  }

  const customerIds = Array.from(customerMap.keys()).map(id => new mongoose.Types.ObjectId(id));

  const customers = await Customer.find(
    { _id: { $in: customerIds }, 'Role.isCustomer': true },
    { customerDisplayName: 1, customerNumber: 1 },
  ).lean();

  const customerDetailsMap = new Map();

  customers.forEach(customer => {
    customerDetailsMap.set(customer._id.toString(), {
      customerName: customer.customerDisplayName,
      customerNumber: customer.customerNumber,
    });
  });

  let finalData = Array.from(customerMap.values()).map(customer => {
    const details = customerDetailsMap.get(customer.customerId.toString());

    const result = {
      ...customer,
      customerName: details?.customerName ?? null,
      customerNumber: details?.customerNumber ?? null,
    };

    if (!showSplit) {
      delete result.invoiceSplitByQtyQty;
      delete result.invoiceSplitByQtyValue;
      delete result.invoiceSplitByPriceQty;
      delete result.invoiceSplitByPriceValue;
    }

    return result;
  });

  finalData = applySorting(finalData, filter.sortBy);

  const totalRecords = finalData.length;

  finalData = finalData.slice(skip, skip + limit);

  return {
    result: finalData,
    otherDetails: {
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      page,
      limit,
    },
  };
};

const buildMatchQuery = (filter, dateField) => {
  const { startDate, endDate, companyId, branchId, divisionId } = filter;

  let query = {
    companyId: new mongoose.Types.ObjectId(companyId),
  };

  if (startDate && endDate) {
    query[dateField] = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    query.branchId = {
      $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
    };
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    query.divisionId = {
      $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)),
    };
  }

  if (filter.customerId) {
    const customerArray = filter.customerId.split(',').filter(Boolean);
    query.customerId = {
      $in: customerArray.map(id => new mongoose.Types.ObjectId(id)),
    };
  }

  return query;
};

const resolveItemIdsFilter = async filter => {
  const { itemId, itemGroupId } = filter || {};

  if (!itemId && !itemGroupId) return null;

  let idsFromItemGroup = null;

  if (itemGroupId) {
    const { Item } = getBooksCrmModels();
    const groupIds = itemGroupId
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    const items = await Item.find({ itemGroup: { $in: groupIds } }, { _id: 1 }).lean();
    idsFromItemGroup = items.map(item => item._id);
  }

  let idsFromItemId = null;

  if (itemId) {
    idsFromItemId = itemId
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
  }

  if (idsFromItemGroup && idsFromItemId) {
    const groupIdSet = new Set(idsFromItemGroup.map(id => id.toString()));
    return idsFromItemId.filter(id => groupIdSet.has(id.toString()));
  }

  return idsFromItemGroup || idsFromItemId;
};

const getItemAggregation = async (Model, matchQuery, itemIdsFilter = null) => {
  const initialMatch = itemIdsFilter ? { ...matchQuery, 'items.itemId': { $in: itemIdsFilter } } : matchQuery;
  const pipeline = [{ $match: initialMatch }, { $unwind: '$items' }];

  if (itemIdsFilter) {
    pipeline.push({ $match: { 'items.itemId': { $in: itemIdsFilter } } });
  }

  pipeline.push({
    $group: {
      _id: '$items.itemId',
      totalQty: { $sum: '$items.quantity' },
      totalValue: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
    },
  });

  return Model.aggregate(pipeline);
};

const getSplitItemAggregation = async (Model, matchQuery, itemIdsFilter = null) => {
  const baseMatch = { ...matchQuery, isSplit: true };
  const initialMatch = itemIdsFilter ? { ...baseMatch, 'items.itemId': { $in: itemIdsFilter } } : baseMatch;
  const pipeline = [{ $match: initialMatch }, { $unwind: '$items' }];

  if (itemIdsFilter) {
    pipeline.push({ $match: { 'items.itemId': { $in: itemIdsFilter } } });
  }

  pipeline.push({
    $group: {
      _id: { itemId: '$items.itemId', splitWiseType: '$splitWiseType' },
      totalQty: { $sum: '$items.quantity' },
      totalValue: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
    },
  });

  return Model.aggregate(pipeline);
};

const mergeSplitItemData = (itemMap, data, emptyItemFactory, splitFields) => {
  data.forEach(item => {
    if (!item._id.itemId) return;
    const id = item._id.itemId.toString();

    if (!itemMap.has(id)) {
      itemMap.set(id, emptyItemFactory(item._id.itemId));
    }

    const existing = itemMap.get(id);

    if (item._id.splitWiseType === SPLIT_BY_QTY) {
      existing[splitFields.qtyByQty] = item.totalQty;
      existing[splitFields.valueByQty] = item.totalValue;
    } else if (item._id.splitWiseType === SPLIT_BY_PRICE) {
      existing[splitFields.qtyByPrice] = item.totalQty;
      existing[splitFields.valueByPrice] = item.totalValue;
    }
  });
};

const topItemsOfSales = async filter => {
  const { SalesOrder, Item, Quote } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const soMatch = {
    ...buildMatchQuery(filter, 'orderDate'),
    status: { $ne: SALES_ORDER_STATUS.CANCELLED },
  };

  const dcMatch = {
    ...buildMatchQuery(filter, 'challanDate'),
    status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
  };

  const quoteMatch = {
    ...buildMatchQuery(filter, 'quoteDate'),
    status: { $ne: QUOTE_STATUS.CANCELLED },
  };

  const showSplit = filter?.isSplit === true || filter?.isSplit === 'true';

  const invMatch = {
    ...buildMatchQuery(filter, 'invoiceDate'),
    status: { $ne: INVOICE_STATUS.CANCELLED },
    isSplit: { $ne: true },
  };

  const itemIdsFilter = await resolveItemIdsFilter({ itemGroupId: filter?.itemGroupId });

  const [quoteData, soData, dcData, invData] = await Promise.all([
    getItemAggregation(Quote, quoteMatch, itemIdsFilter),
    getItemAggregation(SalesOrder, soMatch, itemIdsFilter),
    getItemAggregation(DeliveryChallan, dcMatch, itemIdsFilter),
    getItemAggregation(Invoice, invMatch, itemIdsFilter),
  ]);

  let splitInvData = [];
  if (showSplit) {
    splitInvData = await getSplitItemAggregation(
      Invoice,
      {
        ...buildMatchQuery(filter, 'invoiceDate'),
        status: { $ne: INVOICE_STATUS.CANCELLED },
      },
      itemIdsFilter,
    );
  }

  const itemMap = new Map();

  const invoiceSplitFields = {
    qtyByQty: 'invoiceSplitByQtyQty',
    valueByQty: 'invoiceSplitByQtyValue',
    qtyByPrice: 'invoiceSplitByPriceQty',
    valueByPrice: 'invoiceSplitByPriceValue',
  };

  const createEmptySalesItem = itemId => ({
    itemId,
    quoteQty: 0,
    quoteValue: 0,
    salesOrderQty: 0,
    salesOrderValue: 0,
    dcQty: 0,
    dcValue: 0,
    invoiceQty: 0,
    invoiceValue: 0,
    invoiceSplitByQtyQty: 0,
    invoiceSplitByQtyValue: 0,
    invoiceSplitByPriceQty: 0,
    invoiceSplitByPriceValue: 0,
  });

  const mergeData = (data, type) => {
    data.forEach(item => {
      const id = item._id.toString();

      if (!itemMap.has(id)) {
        itemMap.set(id, createEmptySalesItem(item._id));
      }

      const existing = itemMap.get(id);

      if (type === 'quote') {
        existing.quoteQty = item.totalQty;
        existing.quoteValue = item.totalValue;
      }

      if (type === 'so') {
        existing.salesOrderQty = item.totalQty;
        existing.salesOrderValue = item.totalValue;
      }

      if (type === 'dc') {
        existing.dcQty = item.totalQty;
        existing.dcValue = item.totalValue;
      }

      if (type === 'inv') {
        existing.invoiceQty = item.totalQty;
        existing.invoiceValue = item.totalValue;
      }
    });
  };

  mergeData(quoteData, 'quote');
  mergeData(soData, 'so');
  mergeData(dcData, 'dc');
  mergeData(invData, 'inv');

  if (showSplit) {
    mergeSplitItemData(itemMap, splitInvData, createEmptySalesItem, invoiceSplitFields);
  }

  const itemIds = Array.from(itemMap.keys()).map(id => new mongoose.Types.ObjectId(id));
  const items = await Item.find({ _id: { $in: itemIds } }, { itemName: 1, itemNo: 1 }).lean();

  const itemDetailsMap = new Map();
  items.forEach(item => {
    itemDetailsMap.set(item._id.toString(), { itemName: item.itemName, itemNo: item.itemNo });
  });

  let finalData = Array.from(itemMap.values()).map(item => {
    const details = itemDetailsMap.get(item.itemId.toString());
    const result = {
      ...item,
      itemName: details?.itemName ?? null,
      itemNo: details?.itemNo ?? null,
    };

    if (!showSplit) {
      delete result.invoiceSplitByQtyQty;
      delete result.invoiceSplitByQtyValue;
      delete result.invoiceSplitByPriceQty;
      delete result.invoiceSplitByPriceValue;
    }

    return result;
  });

  finalData = applySorting(finalData, filter.sortBy);

  const totalRecords = finalData.length;

  finalData = finalData.slice(skip, skip + limit);

  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page,
    limit,
  };

  return {
    result: finalData,
    otherDetails: response,
  };
};

const topPurchasedItems = async filter => {
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();
  const { Item } = getBooksCrmModels();

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const poMatch = {
    ...buildMatchQuery(filter, 'date'),
    status: { $ne: PO_STATUSES.CANCELLED },
  };

  const grpoMatch = {
    ...buildMatchQuery(filter, 'date'),
    status: { $ne: GRPO_STATUSES.CANCELLED },
  };

  const showSplit = filter?.isSplit === true || filter?.isSplit === 'true';

  const billMatch = {
    ...buildMatchQuery(filter, 'billDate'),
    status: { $ne: BILL_STATUSES.CANCELLED },
    isSplit: { $ne: true },
  };

  const [poData, grpoData, billData] = await Promise.all([
    getItemAggregation(PurchaseOrder, poMatch),
    getItemAggregation(GrpoOrder, grpoMatch),
    getItemAggregation(Bill, billMatch),
  ]);

  let splitBillData = [];
  if (showSplit) {
    splitBillData = await getSplitItemAggregation(Bill, {
      ...buildMatchQuery(filter, 'billDate'),
      status: { $ne: BILL_STATUSES.CANCELLED },
    });
  }

  const itemMap = new Map();

  const billSplitFields = {
    qtyByQty: 'billSplitByQtyQty',
    valueByQty: 'billSplitByQtyValue',
    qtyByPrice: 'billSplitByPriceQty',
    valueByPrice: 'billSplitByPriceValue',
  };

  const createEmptyPurchaseItem = itemId => ({
    itemId,
    purchaseOrderQty: 0,
    purchaseOrderValue: 0,
    grpoQty: 0,
    grpoValue: 0,
    billQty: 0,
    billValue: 0,
    billSplitByQtyQty: 0,
    billSplitByQtyValue: 0,
    billSplitByPriceQty: 0,
    billSplitByPriceValue: 0,
  });

  const mergeData = (data, type) => {
    data.forEach(item => {
      const id = item._id.toString();

      if (!itemMap.has(id)) {
        itemMap.set(id, createEmptyPurchaseItem(item._id));
      }

      const existing = itemMap.get(id);

      if (type === 'po') {
        existing.purchaseOrderQty = item.totalQty;
        existing.purchaseOrderValue = item.totalValue;
      }

      if (type === 'grpo') {
        existing.grpoQty = item.totalQty;
        existing.grpoValue = item.totalValue;
      }

      if (type === 'bill') {
        existing.billQty = item.totalQty;
        existing.billValue = item.totalValue;
      }
    });
  };

  mergeData(poData, 'po');
  mergeData(grpoData, 'grpo');
  mergeData(billData, 'bill');

  if (showSplit) {
    mergeSplitItemData(itemMap, splitBillData, createEmptyPurchaseItem, billSplitFields);
  }

  const itemIds = Array.from(itemMap.keys()).map(id => new mongoose.Types.ObjectId(id));
  const items = await Item.find({ _id: { $in: itemIds } }, { itemName: 1, itemNo: 1 }).lean();

  const itemDetailsMap = new Map();
  items.forEach(item => {
    itemDetailsMap.set(item._id.toString(), { itemName: item.itemName, itemNo: item.itemNo });
  });

  let finalData = Array.from(itemMap.values()).map(item => {
    const totalQty = item.purchaseOrderQty + item.grpoQty + item.billQty;
    const totalValue = item.purchaseOrderValue + item.grpoValue + item.billValue;
    const details = itemDetailsMap.get(item.itemId.toString());
    const result = {
      ...item,
      totalQuantity: totalQty,
      totalPurchaseAmount: totalValue,
      itemName: details?.itemName ?? null,
      itemNo: details?.itemNo ?? null,
    };

    if (!showSplit) {
      delete result.billSplitByQtyQty;
      delete result.billSplitByQtyValue;
      delete result.billSplitByPriceQty;
      delete result.billSplitByPriceValue;
    }

    return result;
  });

  finalData = applySorting(finalData, filter.sortBy);

  const totalRecords = finalData.length;

  finalData = finalData.slice(skip, skip + limit);

  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page,
    limit,
  };

  return {
    result: finalData,
    otherDetails: response,
  };
};

const topPurchaseOrders = async filter => {
  const { PurchaseOrder } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { startDate, endDate, companyId, branchId, divisionId } = filter;

  let query = {};

  if (startDate && endDate) {
    query.date = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const vendors = await PurchaseOrder.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), ...query, status: { $ne: SALES_ORDER_STATUS.CANCELLED } } },
    {
      $group: {
        _id: '$_id',
        purchaseOrderId: { $first: '$purchaseOrderId' },
        vendor: { $first: '$vendor' },
        totalAmount: { $sum: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] } },
        date: { $first: '$date' },
      },
    },
    { $sort: { totalAmount: -1 } },
    {
      $project: {
        purchaseOrderId: 1,
        totalAmount: 1,
        date: 1,
        vendorId: '$vendor',
      },
    },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = vendors[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];

  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };

  const result = [];
  for (let i of data) {
    const customer = await Customer.findById(i.vendorId).select('customerDisplayName');
    result.push({
      ...i,
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }

  return { result: result, otherDetails: response };
};

const getVendorAggregation = async (Model, matchQuery) => {
  return Model.aggregate([
    { $match: matchQuery },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$vendor',
        totalQty: { $sum: '$items.quantity' },
        totalValue: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
  ]);
};

const getSplitVendorAggregation = async (Model, matchQuery) => {
  return Model.aggregate([
    { $match: { ...matchQuery, isSplit: true } },
    { $unwind: '$items' },
    {
      $group: {
        _id: { vendorId: '$vendor', splitWiseType: '$splitWiseType' },
        totalQty: { $sum: '$items.quantity' },
        totalValue: { $sum: { $multiply: ['$items.amount', { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
  ]);
};

const mergeSplitVendorData = (vendorMap, data, emptyVendorFactory, splitFields) => {
  data.forEach(row => {
    const vendorId = row._id?.vendorId?.toString();
    if (!vendorId) return;

    if (!vendorMap.has(vendorId)) {
      vendorMap.set(vendorId, emptyVendorFactory(row._id?.vendorId));
    }

    const existing = vendorMap.get(vendorId);

    let type = row._id?.splitWiseType;

    if (!type) {
      type = SPLIT_BY_QTY;
    }

    if (type === SPLIT_BY_QTY) {
      existing[splitFields.qtyByQty] = (existing[splitFields.qtyByQty] || 0) + row.totalQty;
      existing[splitFields.valueByQty] = (existing[splitFields.valueByQty] || 0) + row.totalValue;
    }

    if (type === SPLIT_BY_PRICE) {
      existing[splitFields.qtyByPrice] = (existing[splitFields.qtyByPrice] || 0) + row.totalQty;
      existing[splitFields.valueByPrice] = (existing[splitFields.valueByPrice] || 0) + row.totalValue;
    }
  });
};

const topVendorsOfPurchase = async filter => {
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const showSplit = filter?.isSplit === true || filter?.isSplit === 'true';

  const poMatch = {
    ...buildMatchQuery(filter, 'date'),
    status: { $ne: PO_STATUSES.CANCELLED },
  };

  const grpoMatch = {
    ...buildMatchQuery(filter, 'date'),
    status: { $ne: GRPO_STATUSES.CANCELLED },
  };

  const billMatch = {
    ...buildMatchQuery(filter, 'billDate'),
    status: { $ne: BILL_STATUSES.CANCELLED },
    isSplit: { $ne: true },
  };

  const [poData, grpoData, billData] = await Promise.all([
    getVendorAggregation(PurchaseOrder, poMatch),
    getVendorAggregation(GrpoOrder, grpoMatch),
    getVendorAggregation(Bill, billMatch),
  ]);

  let splitBillData = [];

  if (showSplit) {
    splitBillData = await getSplitVendorAggregation(Bill, {
      ...buildMatchQuery(filter, 'billDate'),
      status: { $ne: BILL_STATUSES.CANCELLED },
    });
  }

  const vendorMap = new Map();

  const billSplitFields = {
    qtyByQty: 'billSplitByQtyQty',
    valueByQty: 'billSplitByQtyValue',
    qtyByPrice: 'billSplitByPriceQty',
    valueByPrice: 'billSplitByPriceValue',
  };

  const createEmptyVendor = vendor => ({
    vendor,
    purchaseOrderQty: 0,
    purchaseOrderValue: 0,
    grpoQty: 0,
    grpoValue: 0,
    billQty: 0,
    billValue: 0,
    billSplitByQtyQty: 0,
    billSplitByQtyValue: 0,
    billSplitByPriceQty: 0,
    billSplitByPriceValue: 0,
  });

  const mergeData = (data, type) => {
    data.forEach(vendor => {
      const id = vendor?._id?.toString();
      if (!id || id === 'null') return;

      if (!vendorMap.has(id)) {
        vendorMap.set(id, createEmptyVendor(vendor._id));
      }

      const existing = vendorMap.get(id);

      if (type === 'po') {
        existing.purchaseOrderQty = vendor.totalQty;
        existing.purchaseOrderValue = vendor.totalValue;
      }

      if (type === 'grpo') {
        existing.grpoQty = vendor.totalQty;
        existing.grpoValue = vendor.totalValue;
      }

      if (type === 'bill') {
        existing.billQty = vendor.totalQty;
        existing.billValue = vendor.totalValue;
      }
    });
  };

  mergeData(poData, 'po');
  mergeData(grpoData, 'grpo');
  mergeData(billData, 'bill');

  if (showSplit) {
    mergeSplitVendorData(vendorMap, splitBillData, createEmptyVendor, billSplitFields);
  }

  const vendorIds = Array.from(vendorMap.keys()).map(id => new mongoose.Types.ObjectId(id));

  const vendors = await Customer.find(
    { _id: { $in: vendorIds }, 'Role.isVendor': true },
    { customerDisplayName: 1, customerNumber: 1 },
  ).lean();

  const vendorDetailsMap = new Map();

  vendors.forEach(vendor => {
    vendorDetailsMap.set(vendor._id.toString(), {
      vendorName: vendor.customerDisplayName,
      vendorNumber: vendor.customerNumber,
    });
  });

  let finalData = Array.from(vendorMap.values()).map(vendor => {
    const details = vendorDetailsMap.get(vendor.vendor.toString());

    const result = {
      ...vendor,
      vendorName: details?.vendorName ?? null,
      vendorNumber: details?.vendorNumber ?? null,
    };

    if (!showSplit) {
      delete result.billSplitByQtyQty;
      delete result.billSplitByQtyValue;
      delete result.billSplitByPriceQty;
      delete result.billSplitByPriceValue;
    }

    return result;
  });

  finalData = applySorting(finalData, filter.sortBy);

  const totalRecords = finalData.length;

  finalData = finalData.slice(skip, skip + limit);

  return {
    result: finalData,
    otherDetails: {
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      page,
      limit,
    },
  };
};

const topCustomersByBalance = async filter => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  } else {
    query.isSplit = true;
  }

  if (startDate && endDate) {
    query.invoiceDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const topCustomers = await Invoice.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        balanceAmount: { $gt: 0 },
        ...query,
        status: { $ne: SALES_ORDER_STATUS.CANCELLED },
      },
    },
    {
      $group: {
        _id: '$customerId',
        totalBalance: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } },
        invoiceCount: { $sum: 1 },
      },
    },
    { $sort: { totalBalance: -1 } },
    {
      $project: {
        totalBalance: 1,
        invoiceCount: 1,
      },
    },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = topCustomers[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];

  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };

  const result = [];
  for (let i of data) {
    const customer = await Customer.findById(i._id).select('customerDisplayName');
    result.push({
      ...i,
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }
  return { result: result, otherDetails: response };
};

const recentPayments = async filter => {
  const { PaymentReceived } = getBooksCrmModels();
  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;
  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  } else {
    query.isSplit = true;
  }

  if (startDate && endDate) {
    query.paymentDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const recentPayments = await PaymentReceived.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        ...query,
      },
    },
    { $sort: { paymentDate: -1 } },
    {
      $lookup: {
        from: 'customers',
        localField: 'customerId',
        foreignField: '_id',
        as: 'customerDetails',
      },
    },
    { $unwind: { path: '$customerDetails', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        paymentReceivedId: 1,
        customerName: '$customerDetails.customerDisplayName',
        amountReceived: { $multiply: ['$amountReceived', { $ifNull: ['$exchangeRate', 1] }] },
        paymentMode: 1,
        paymentDate: 1,
      },
    },
    {
      $facet: {
        metadata: [{ $group: { _id: null, totalRecords: { $sum: 1 }, totalAmount: { $sum: '$amountReceived' } } }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = recentPayments[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const totalAmount = aggResult.metadata?.[0]?.totalAmount || 0;
  const data = aggResult.data || [];

  const response = {
    totalRecords,
    totalAmount,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };

  return { result: data, otherDetails: response };
};

const upcomingReceivables = async filter => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  }

  if (startDate && endDate) {
    query.invoiceDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const start = moment().startOf('day');

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const upcomingReceivables = await Invoice.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        dueDate: { $gte: start.toDate() },
        balanceAmount: { $gt: 0 },
        status: { $in: [INVOICE_STATUS.SENT, INVOICE_STATUS.PARTIALLY_PAID] },
        ...query,
      },
    },
    {
      $project: {
        invoiceId: 1,
        dueDate: 1,
        customerId: 1,
        balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
      },
    },
    { $sort: { dueDate: 1 } },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = upcomingReceivables[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];

  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };
  const result = [];

  for (let i of data) {
    const customer = await Customer.findById(i.customerId).select('customerDisplayName');
    result.push({
      ...i,
      customerName: customer ? customer.customerDisplayName : null,
    });
  }

  return { result: result, otherDetails: response };
};

const overdueInvoices = async filter => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  }

  if (startDate && endDate) {
    query.invoiceDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const overdueInvoices = await Invoice.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        balanceAmount: { $gt: 0 },
        dueDate: { $lt: moment().startOf('day').toDate() },
        status: INVOICE_STATUS.OVERDUE,
        ...query,
      },
    },
    {
      $project: {
        invoiceId: 1,
        dueDate: 1,
        balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
        customerId: 1,
      },
    },
    { $sort: { dueDate: 1 } },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = overdueInvoices[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];

  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };
  const result = [];

  for (let i of data) {
    const customer = await Customer.findById(i.customerId).select('customerDisplayName');
    result.push({
      ...i,
      customerName: customer ? customer.customerDisplayName : null,
    });
  }

  return { result: result, otherDetails: response };
};

const topVendorsByBalance = async filter => {
  const { Bill } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  } else {
    query.isSplit = true;
  }

  if (startDate && endDate) {
    query.invoiceDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const topVendors = await Bill.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        balanceAmount: { $gt: 0 },
        ...query,
        status: { $ne: SALES_ORDER_STATUS.CANCELLED },
      },
    },
    {
      $group: {
        _id: '$vendor',
        totalBalance: { $sum: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] } },
        billCount: { $sum: 1 },
      },
    },
    { $sort: { totalBalance: -1 } },
    {
      $project: {
        totalBalance: 1,
        billCount: 1,
        vendorId: '$_id',
      },
    },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = topVendors[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];
  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };

  const result = [];
  for (let i of data) {
    const customer = await Customer.findById(i.vendorId).select('customerDisplayName');
    result.push({
      ...i,
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }

  return { result: result, otherDetails: response };
};

const recentPaymentsMade = async filter => {
  const { PaymentMade } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;
  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  } else {
    query.isSplit = true;
  }

  if (startDate && endDate) {
    query.paymentDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const recentPayments = await PaymentMade.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        ...query,
      },
    },
    { $sort: { paymentDate: -1 } },
    {
      $project: {
        paymentMadeId: 1,
        paymentMade: { $multiply: ['$paymentMade', { $ifNull: ['$exchangeRate', 1] }] },
        paymentMode: 1,
        paymentDate: 1,
        vendorId: 1,
      },
    },
    {
      $facet: {
        metadata: [{ $group: { _id: null, totalRecords: { $sum: 1 }, totalAmount: { $sum: '$paymentMade' } } }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = recentPayments[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const totalAmount = aggResult.metadata?.[0]?.totalAmount || 0;
  const data = aggResult.data || [];

  const response = {
    totalRecords,
    totalAmount,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };

  const result = [];
  for (let i of data) {
    const customer = await Customer.findById(i.vendorId).select('customerDisplayName');
    result.push({
      ...i,
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }
  return { result: result, otherDetails: response };
};

const upcomingPayables = async filter => {
  const { Bill } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  } else {
    query.isSplit = true;
  }

  if (startDate && endDate) {
    query.invoiceDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const upcomingPayables = await Bill.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        dueDate: { $gte: moment().startOf('day').toDate() },
        balanceAmount: { $gt: 0 },
        ...query,
        status: { $in: [BILL_STATUSES.OPEN, BILL_STATUSES.PARTIALLY_PAID] },
      },
    },
    {
      $project: {
        billId: 1,
        vendor: 1,
        dueDate: 1,
        balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
      },
    },
    { $sort: { dueDate: 1 } },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = upcomingPayables[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];
  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };

  const result = [];
  for (let i of data) {
    const customer = await Customer.findById(i.vendor).select('customerDisplayName');
    result.push({
      ...i,
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }

  return { result: result, otherDetails: response };
};

const overdueBills = async filter => {
  const { Bill } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { startDate, endDate, companyId, branchId, divisionId, isSplit } = filter;

  let query = {};

  if (isSplit == undefined) {
    query.isSplit = false;
  }

  if (startDate && endDate) {
    query.invoiceDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;

  const overdueBills = await Bill.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        dueDate: { $lt: moment().startOf('day').toDate() },
        balanceAmount: { $gt: 0 },
        status: BILL_STATUSES.OVERDUE,
        ...query,
      },
    },
    {
      $project: {
        billId: 1,
        dueDate: 1,
        vendor: 1,
        balanceAmount: { $multiply: ['$balanceAmount', { $ifNull: ['$exchangeRate', 1] }] },
      },
    },
    { $sort: { dueDate: 1 } },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const aggResult = overdueBills[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];
  const response = {
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    page: page,
    limit,
  };

  const result = [];
  for (let i of data) {
    const customer = await Customer.findById(i.vendor).select('customerDisplayName');
    result.push({
      ...i,
      vendorName: customer ? customer.customerDisplayName : null,
    });
  }

  return { result: result, otherDetails: response };
};

const customersWithSingleInvoice = async filter => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, branchId, divisionId } = filter;

  const query = {};
  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      query.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }
  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }
  if (filter?.isSplit == undefined) {
    query.isSplit = false;
  }

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;
  const isSplit = filter?.isSplit === true || filter?.isSplit === 'true';
  const invoiceMatch = {
    companyId: new mongoose.Types.ObjectId(companyId),
    status: { $ne: SALES_ORDER_STATUS.CANCELLED },
  };

  if (!isSplit) {
    invoiceMatch.isSplit = false;
  }

  const aggregationResult = await Invoice.aggregate([
    {
      $match: invoiceMatch,
    },
    {
      $group: {
        _id: '$customerId',
        invoiceCount: { $sum: 1 },
        invoices: { $push: '$$ROOT' },
      },
    },
    {
      $match: {
        invoiceCount: 1,
      },
    },
    {
      $project: {
        customerId: '$_id',
        invoice: { $arrayElemAt: ['$invoices', 0] },
      },
    },
    {
      $match: {
        ...(query.branchId && { 'invoice.branchId': query.branchId }),
        ...(query.divisionId && { 'invoice.divisionId': query.divisionId }),
      },
    },
    {
      $sort: {
        'invoice.invoiceId': 1,
      },
    },
    {
      $facet: {
        metadata: [{ $count: 'totalRecords' }],
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              customerId: 1,
              invoice: {
                _id: 1,
                invoiceId: 1,
                invoiceDate: 1,
                dueDate: 1,
                total: 1,
                balanceAmount: 1,
                paidAmount: 1,
                status: 1,
              },
            },
          },
        ],
      },
    },
  ]);

  const aggResult = aggregationResult[0] || {};
  const totalRecords = aggResult.metadata?.[0]?.totalRecords || 0;
  const data = aggResult.data || [];

  const customerIds = data.map(item => item.customerId).filter(Boolean);

  const customers = await Customer.find({
    _id: { $in: customerIds },
  }).select('customerDisplayName customerPhoneNumber companyName');

  const customerMap = new Map();
  customers.forEach(customer => {
    customerMap.set(customer._id.toString(), customer);
  });

  const result = data.map(item => {
    const customer = customerMap.get(item.customerId.toString());
    const invoice = item.invoice;

    return {
      customerId: item.customerId,
      customerName: customer ? customer.customerDisplayName : null,
      customerPhoneNumber: customer ? customer.customerPhoneNumber : null,
      companyName: customer ? customer.companyName : null,
      invoice: {
        _id: invoice._id,
        invoiceId: invoice.invoiceId,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        total: (invoice.total || 0) * (invoice.exchangeRate ?? 1),
        balanceAmount: (invoice.balanceAmount || 0) * (invoice.exchangeRate ?? 1),
        paidAmount: (invoice.paidAmount || 0) * (invoice.exchangeRate ?? 1),
        status: invoice.status,
      },
    };
  });

  return {
    result,
    otherDetails: {
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      page,
      limit,
    },
  };
};

const getCreatedByName = async createdById => {
  if (!createdById) return '';
  try {
    const { User } = getCommonModels();
    const user = await User.findById(createdById).select('firstName lastName').lean();
    if (!user) return '';
    return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || '';
  } catch {
    return '';
  }
};

const resolveCreatedByName = async createdBy => {
  if (!createdBy) return '';
  const { User } = getCommonModels();
  const user = await User.findById(createdBy).select('firstName lastName').lean();
  if (!user) return '';
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
};

const createGeneralSalesAnalytics = async (body, companyId, userId) => {
  const { GeneralSalesAnalytics } = getBooksModels();
  const { reportName, reportBasis, basisIds, documents } = body;
  const trimmedName = (reportName || '').trim();

  const existing = await GeneralSalesAnalytics.findOne({
    companyId: new mongoose.Types.ObjectId(companyId),
    reportName: trimmedName,
  }).lean();

  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'An analytics configuration with this name already exists for this company');
  }

  const doc = await GeneralSalesAnalytics.create({
    companyId: new mongoose.Types.ObjectId(companyId),
    reportName: trimmedName,
    reportBasis,
    basisIds: (basisIds || []).map(id => new mongoose.Types.ObjectId(id)),
    documents: (documents || []).map(d => ({ module: d.module, statuses: Array.isArray(d.statuses) ? d.statuses : [] })),
    ...(userId ? { createdBy: new mongoose.Types.ObjectId(userId) } : {}),
  });

  return doc;
};

const getGeneralSalesAnalytics = async companyId => {
  const { GeneralSalesAnalytics } = getBooksModels();
  const list = await GeneralSalesAnalytics.find({ companyId: new mongoose.Types.ObjectId(companyId) })
    .select('_id reportName reportBasis createdAt createdBy')
    .sort({ createdAt: -1 })
    .lean();

  const creatorIds = [...new Set(list.map(r => r.createdBy?.toString()).filter(Boolean))];
  const { User } = getCommonModels();
  const users = creatorIds.length
    ? await User.find({ _id: { $in: creatorIds } })
        .select('firstName lastName')
        .lean()
    : [];
  const idToName = new Map(users.map(u => [u._id.toString(), [u.firstName, u.lastName].filter(Boolean).join(' ').trim()]));

  return list.map(row => ({
    _id: row._id,
    reportName: row.reportName,
    reportBasis: row.reportBasis,
    createdAt: row.createdAt,
    createdBy: row.createdBy ? idToName.get(row.createdBy.toString()) || '' : '',
  }));
};

const getGeneralSalesAnalyticsById = async (reportId, companyId) => {
  const { GeneralSalesAnalytics } = getBooksModels();
  const companyObjId = new mongoose.Types.ObjectId(companyId);
  const reportObjId = new mongoose.Types.ObjectId(reportId);

  const doc = await GeneralSalesAnalytics.findOne({ _id: reportObjId, companyId: companyObjId }).lean();
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Analytics configuration not found');

  const createdByName = await resolveCreatedByName(doc.createdBy);
  return { ...doc, createdBy: createdByName };
};

const updateGeneralSalesAnalytics = async (reportId, body, companyId, userId) => {
  const { GeneralSalesAnalytics } = getBooksModels();
  const reportObjId = new mongoose.Types.ObjectId(reportId);
  const companyObjId = new mongoose.Types.ObjectId(companyId);

  const updateFields = {};

  if (body.reportName !== undefined) {
    const trimmedName = (body.reportName || '').trim();
    const conflict = await GeneralSalesAnalytics.findOne({
      companyId: companyObjId,
      reportName: trimmedName,
      _id: { $ne: reportObjId },
    }).lean();
    if (conflict) {
      throw new ApiError(httpStatus.CONFLICT, 'An analytics configuration with this name already exists for this company');
    }
    updateFields.reportName = trimmedName;
  }

  if (body.reportBasis !== undefined) updateFields.reportBasis = body.reportBasis;
  if (body.basisIds !== undefined) updateFields.basisIds = body.basisIds.map(id => new mongoose.Types.ObjectId(id));
  if (body.documents !== undefined)
    updateFields.documents = body.documents.map(d => ({
      module: d.module,
      statuses: Array.isArray(d.statuses) ? d.statuses : [],
    }));
  if (userId) updateFields.updatedBy = new mongoose.Types.ObjectId(userId);

  const updated = await GeneralSalesAnalytics.findOneAndUpdate(
    { _id: reportObjId, companyId: companyObjId },
    { $set: updateFields },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) throw new ApiError(httpStatus.NOT_FOUND, 'Analytics configuration not found');

  const createdByName = await resolveCreatedByName(updated.createdBy);
  return { ...updated, createdBy: createdByName };
};

const deleteGeneralSalesAnalytics = async (reportId, companyId) => {
  const { GeneralSalesAnalytics } = getBooksModels();
  const companyObjId = new mongoose.Types.ObjectId(companyId);
  const reportObjId = new mongoose.Types.ObjectId(reportId);

  const doc = await GeneralSalesAnalytics.findOneAndDelete({ _id: reportObjId, companyId: companyObjId }).lean();
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Analytics configuration not found');

  return { deleted: true };
};

const MODULE_DATE_FIELDS = {
  [GENERAL_SALES_ANALYTICS_MODULES.QUOTE]: 'quoteDate',
  [GENERAL_SALES_ANALYTICS_MODULES.SALES_ORDER]: 'orderDate',
  [GENERAL_SALES_ANALYTICS_MODULES.DELIVERY_CHALLAN]: 'challanDate',
  [GENERAL_SALES_ANALYTICS_MODULES.INVOICE]: 'invoiceDate',
};

const DOCUMENT_DISPLAY_ORDER = [
  GENERAL_SALES_ANALYTICS_MODULES.QUOTE,
  GENERAL_SALES_ANALYTICS_MODULES.SALES_ORDER,
  GENERAL_SALES_ANALYTICS_MODULES.DELIVERY_CHALLAN,
  GENERAL_SALES_ANALYTICS_MODULES.INVOICE,
];

const getBulkCountAndAmountByItem = async (Model, itemIdList, statuses, dateField, dateRange, companyObjectId) => {
  if (!itemIdList.length) return new Map();

  const match = {
    companyId: companyObjectId,
    'items.itemId': { $in: itemIdList },
    ...(statuses?.length ? { status: { $in: statuses } } : {}),
    ...(dateField && dateRange ? { [dateField]: { $gte: dateRange.start, $lte: dateRange.end } } : {}),
  };

  const results = await Model.aggregate([
    { $match: match },
    { $unwind: '$items' },
    { $match: { 'items.itemId': { $in: itemIdList } } },
    {
      $group: {
        _id: '$items.itemId',
        docIds: { $addToSet: '$_id' },
        amount: {
          $sum: {
            $add: [{ $ifNull: ['$items.amount', 0] }, { $ifNull: ['$items.taxAmount', 0] }],
          },
        },
      },
    },
    {
      $project: {
        _id: 1,
        count: { $size: '$docIds' },
        amount: 1,
      },
    },
  ]);

  return new Map(results.map(r => [r._id.toString(), { count: r.count, amount: r.amount }]));
};

const getGeneralSalesAnalyticsByIdWithData = async (reportId, companyId, filter = {}) => {
  const { GeneralSalesAnalytics, DeliveryChallan, Invoice } = getBooksModels();
  const { Quote, SalesOrder, Item, ItemGroup } = getBooksCrmModels();
  const companyObjId = new mongoose.Types.ObjectId(companyId);
  const reportObjId = new mongoose.Types.ObjectId(reportId);

  const report = await GeneralSalesAnalytics.findOne({ _id: reportObjId, companyId: companyObjId }).lean();
  if (!report) throw new ApiError(httpStatus.NOT_FOUND, 'Analytics configuration not found');

  const { reportBasis, documents = [] } = report;
  const sortedDocuments = [...documents].sort((a, b) => {
    const indexA = DOCUMENT_DISPLAY_ORDER.indexOf(a.module);
    const indexB = DOCUMENT_DISPLAY_ORDER.indexOf(b.module);
    const orderA = indexA === -1 ? DOCUMENT_DISPLAY_ORDER.length : indexA;
    const orderB = indexB === -1 ? DOCUMENT_DISPLAY_ORDER.length : indexB;
    return orderA - orderB;
  });
  const allBasisIds = (report.basisIds || []).map(id => new mongoose.Types.ObjectId(id));

  const page = parseInt(filter.page, 10) || 1;
  const limit = parseInt(filter.limit, 10) || 10;
  const totalRecords = allBasisIds.length;
  const totalPages = Math.ceil(totalRecords / limit);
  const basisIds = allBasisIds.slice((page - 1) * limit, page * limit);

  if (!allBasisIds.length || !sortedDocuments.length) {
    return {
      result: {
        _id: report._id,
        reportName: report.reportName,
        reportBasis,
        basisIds: report.basisIds,
        documents: sortedDocuments,
        companyId,
        createdBy: await getCreatedByName(report.createdBy),
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        columns: [{ key: 'basisName', title: 'Basis Name' }],
        data: [],
      },
      page,
      limit,
      totalRecords: 0,
      totalPages: 0,
    };
  }

  const startDate = filter.startDate ? new Date(filter.startDate) : null;
  const endDate = filter.endDate ? new Date(filter.endDate) : null;
  const dateRange = startDate && endDate ? { start: startDate, end: endDate } : null;

  const moduleToModel = {
    [GENERAL_SALES_ANALYTICS_MODULES.QUOTE]: Quote,
    [GENERAL_SALES_ANALYTICS_MODULES.SALES_ORDER]: SalesOrder,
    [GENERAL_SALES_ANALYTICS_MODULES.DELIVERY_CHALLAN]: DeliveryChallan,
    [GENERAL_SALES_ANALYTICS_MODULES.INVOICE]: Invoice,
  };

  let basisIdToName = new Map();
  let basisIdToItemIds = new Map();

  if (reportBasis === GENERAL_SALES_ANALYTICS_BASIS.ITEM_GROUP) {
    const [groups, items] = await Promise.all([
      ItemGroup.find({ _id: { $in: allBasisIds } })
        .select('_id name')
        .lean(),
      Item.find({ itemGroup: { $in: allBasisIds } })
        .select('_id itemGroup')
        .lean(),
    ]);

    basisIdToName = new Map(groups.map(g => [g._id.toString(), g.name || g._id.toString()]));

    const groupItemMap = new Map();
    for (const item of items) {
      const gid = item.itemGroup?.toString();
      if (!gid) continue;
      if (!groupItemMap.has(gid)) groupItemMap.set(gid, []);
      groupItemMap.get(gid).push(item._id);
    }
    for (const bId of allBasisIds) {
      basisIdToItemIds.set(bId.toString(), groupItemMap.get(bId.toString()) || []);
    }
  } else {
    const items = await Item.find({ _id: { $in: allBasisIds } })
      .select('_id itemName')
      .lean();
    basisIdToName = new Map(items.map(i => [i._id.toString(), i.itemName || i._id.toString()]));
    for (const bId of allBasisIds) {
      basisIdToItemIds.set(bId.toString(), [bId]);
    }
  }

  const pageItemIds = [
    ...new Set(basisIds.flatMap(bId => (basisIdToItemIds.get(bId.toString()) || []).map(id => id.toString()))),
  ].map(id => mongoose.Types.ObjectId.createFromHexString(id));

  const [createdByName, ...moduleMaps] = await Promise.all([
    getCreatedByName(report.createdBy),
    ...sortedDocuments.map(docConfig => {
      const Model = moduleToModel[docConfig.module];
      const dateField = MODULE_DATE_FIELDS[docConfig.module] || null;
      if (!Model) return Promise.resolve(new Map());
      return getBulkCountAndAmountByItem(Model, pageItemIds, docConfig.statuses, dateField, dateRange, companyObjId);
    }),
  ]);

  const columns = [{ key: 'basisName', title: 'Basis Name' }];
  for (const docConfig of sortedDocuments) {
    const baseKey = MODULE_DATA_KEYS[docConfig.module] || docConfig.module.toLowerCase();
    const label = MODULE_LABELS[docConfig.module] || docConfig.module;
    columns.push({ key: `${baseKey}Count`, title: label });
    columns.push({ key: `${baseKey}Amount`, title: `${label} Amount` });
  }

  const data = basisIds.map(bId => {
    const idStr = bId.toString();
    const itemIds = (basisIdToItemIds.get(idStr) || []).map(id => id.toString());
    const row = { basisName: basisIdToName.get(idStr) || idStr };

    sortedDocuments.forEach((docConfig, i) => {
      const baseKey = MODULE_DATA_KEYS[docConfig.module] || docConfig.module.toLowerCase();
      const moduleMap = moduleMaps[i]; // Map<itemIdStr, { count, amount }>

      let totalCount = 0,
        totalAmount = 0;
      for (const itemIdStr of itemIds) {
        const stats = moduleMap.get(itemIdStr);
        if (stats) {
          totalCount += stats.count;
          totalAmount += stats.amount;
        }
      }

      row[`${baseKey}Count`] = totalCount;
      row[`${baseKey}Amount`] = totalAmount;
    });

    return row;
  });

  return {
    result: {
      _id: report._id,
      reportName: report.reportName,
      reportBasis,
      basisIds: report.basisIds,
      documents: sortedDocuments,
      companyId,
      createdBy: createdByName,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      columns,
      data,
    },
    page,
    limit,
    totalRecords,
    totalPages,
  };
};

const itemProcessAnalytics = async filter => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const { startDate, endDate, companyId, itemId, process } = filter;

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
  };

  let dateRange = null;
  if (startDate && endDate) {
    dateRange = {
      start: moment(startDate).startOf('day').toDate(),
      end: moment(endDate).endOf('day').toDate(),
    };
    match['processBased.processes'] = {
      $elemMatch: {
        startDatetime: { $gte: dateRange.start, $lte: dateRange.end },
      },
    };
  }

  if (itemId) {
    match.itemId = new mongoose.Types.ObjectId(itemId);
  }

  const orders = await ProductionOrder.find(match)
    .select(
      'itemId processBased.processes._id processBased.processes.processNo processBased.processes.processName processBased.processes.startDatetime processBased.processes.processIN processBased.processes.processOUT processBased.processes.startedBy',
    )
    .lean();

  const itemIds = [
    ...new Set(
      orders
        .map(order => order.itemId)
        .filter(Boolean)
        .map(id => id.toString()),
    ),
  ];
  const startedByIds = [
    ...new Set(
      orders.flatMap(order =>
        (order.processBased?.processes || [])
          .map(p => p.startedBy)
          .filter(Boolean)
          .map(id => id.toString()),
      ),
    ),
  ];

  // Cross-DB: Item is in booksCrm and User is in common, not books — fetch manually, in parallel
  const { User } = getCommonModels();
  const [items, users] = await Promise.all([
    Item.find({ _id: { $in: itemIds } })
      .select('itemName itemNo')
      .lean(),
    User.find({ _id: { $in: startedByIds } })
      .select('firstName lastName')
      .lean(),
  ]);
  const itemMap = new Map(items.map(item => [item._id.toString(), item]));
  const userMap = new Map(users.map(user => [user._id.toString(), [user.firstName, user.lastName].filter(Boolean).join(' ')]));

  let rows = [];
  for (const order of orders) {
    const processes = order.processBased?.processes || [];
    const item = order.itemId ? itemMap.get(order.itemId.toString()) : null;

    for (let i = 0; i < processes.length - 1; i++) {
      const fromProcess = processes[i];
      const toProcess = processes[i + 1];

      rows.push({
        id: fromProcess._id?.toString(),
        date: fromProcess.startDatetime,
        jobNo: fromProcess.processNo,
        itemId: order.itemId,
        itemNo: item?.itemNo || null,
        itemName: item?.itemName || null,
        from: fromProcess.processName,
        to: toProcess.processName,
        sendQty: fromProcess.processOUT,
        sendBy: fromProcess.startedBy ? userMap.get(fromProcess.startedBy.toString()) || null : null,
        recvQty: toProcess.processIN,
        recvBy: toProcess.startedBy ? userMap.get(toProcess.startedBy.toString()) || null : null,
      });
    }
  }

  if (dateRange) {
    rows = rows.filter(row => row.date && new Date(row.date) >= dateRange.start && new Date(row.date) <= dateRange.end);
  }

  if (process) {
    const processArray = process.split(',').filter(Boolean);
    if (processArray.length > 0) {
      const processSet = new Set(processArray);
      rows = rows.filter(row => processSet.has(row.from) || processSet.has(row.to));
    }
  }

  rows.sort((a, b) => new Date(b.date) - new Date(a.date));

  const isPaginated = ![false, 'false'].includes(filter?.pagination);
  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;
  const totalRecords = rows.length;
  const result = isPaginated ? rows.slice(skip, skip + limit) : rows;

  return {
    result,
    otherDetails: {
      totalRecords,
      totalPages: isPaginated ? Math.ceil(totalRecords / limit) : 1,
      page: isPaginated ? page : 1,
      limit: isPaginated ? limit : totalRecords,
    },
  };
};

const round2 = value => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

const normalizePartyWiseDateFilter = filter => {
  if (!filter?.startDate || !filter?.endDate) return filter;
  return {
    ...filter,
    startDate: moment(filter.startDate).startOf('day').toDate(),
    endDate: moment(filter.endDate).endOf('day').toDate(),
  };
};

const applyAddedByFilter = (match, filter) => {
  const raw = filter?.addedBy && String(filter.addedBy).trim();
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return match;
  match.addedBy = new mongoose.Types.ObjectId(raw);
  return match;
};

const buildPartyAmountPipeline = match => [
  { $match: match },
  {
    $group: {
      _id: { customerId: '$customerId' },
      amount: {
        $sum: {
          $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }],
        },
      },
    },
  },
];

const buildPartyQtyByUomPipeline = match => [
  { $match: match },
  { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
  {
    $group: {
      _id: {
        customerId: '$customerId',
        unitKey: {
          $cond: [
            { $ne: [{ $ifNull: ['$items.itemUnitId', null] }, null] },
            { $toString: '$items.itemUnitId' },
            {
              $toLower: {
                $trim: { input: { $ifNull: ['$items.itemUnit', ''] } },
              },
            },
          ],
        },
      },
      itemUnitId: { $first: '$items.itemUnitId' },
      itemUnit: { $first: { $ifNull: ['$items.itemUnit', ''] } },
      qty: { $sum: { $ifNull: ['$items.quantity', 0] } },
    },
  },
];

const sumQtyByUomEntries = entries => (entries || []).reduce((sum, entry) => sum + (Number(entry?.qty) || 0), 0);

const formatQtyByUomForExport = entries => {
  const list = (entries || []).filter(e => (Number(e?.qty) || 0) !== 0 || e?.unit);
  if (!list.length) return '0';
  return list.map(e => `${round2(e.qty)}${e.unit ? ` ${e.unit}` : ''}`).join(', ');
};

/** Qty sort ranks by summed UOM totals as an approximate key only; display stays per-UOM. */
const applyPartyWiseSorting = (data, sortBy) => {
  if (!sortBy) return data;
  const [field, order = 'desc'] = sortBy.split(':');
  const direction = order.toLowerCase() === 'asc' ? 1 : -1;

  if (field === 'orderQty' || field === 'orderQtyByUom') {
    return [...data].sort((a, b) => (sumQtyByUomEntries(a.orderQtyByUom) - sumQtyByUomEntries(b.orderQtyByUom)) * direction);
  }
  if (field === 'dispatchedQty' || field === 'dispatchedQtyByUom') {
    return [...data].sort(
      (a, b) => (sumQtyByUomEntries(a.dispatchedQtyByUom) - sumQtyByUomEntries(b.dispatchedQtyByUom)) * direction,
    );
  }

  return applySorting(data, sortBy);
};

const resolveUnitNames = async (unitIds, companyId) => {
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) return new Map();

  const ids = [
    ...new Set(
      (unitIds || [])
        .filter(Boolean)
        .map(id => id.toString())
        .filter(id => mongoose.Types.ObjectId.isValid(id)),
    ),
  ].map(id => new mongoose.Types.ObjectId(id));
  if (!ids.length) return new Map();

  const { ItemUnit } = getBooksCrmModels();
  const units = await ItemUnit.find({ _id: { $in: ids }, companyId: new mongoose.Types.ObjectId(companyId) }, { name: 1 }).lean();
  return new Map(units.map(u => [u._id.toString(), u.name]));
};

const toQtyByUomEntries = (rows, unitNameMap) => {
  const byUnit = new Map();

  (rows || []).forEach(row => {
    const qty = round2(row.qty);
    if (!qty && !row.itemUnitId && !row.itemUnit) return;

    const unitId = row.itemUnitId ? row.itemUnitId.toString() : null;
    const unitName = (row.itemUnit && String(row.itemUnit).trim()) || (unitId ? unitNameMap.get(unitId) : '') || '';
    const key = unitId || unitName.toLowerCase() || 'unknown';

    if (!byUnit.has(key)) {
      byUnit.set(key, { unitId, unit: unitName || null, qty: 0 });
    }
    byUnit.get(key).qty = round2(byUnit.get(key).qty + qty);
  });

  return Array.from(byUnit.values()).sort((a, b) => String(a.unit || '').localeCompare(String(b.unit || '')));
};

const partyWiseBusinessPerformance = async filter => {
  const { SalesOrder, Customer, PaymentReceived } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  const page = Number(filter?.page) || 1;
  const limit = Number(filter?.limit) || 10;
  const skip = (page - 1) * limit;
  const datedFilter = normalizePartyWiseDateFilter(filter);

  const baseSoMatch = applyAddedByFilter(
    {
      ...buildMatchQuery(datedFilter, 'orderDate'),
      status: { $ne: SALES_ORDER_STATUS.CANCELLED },
    },
    datedFilter,
  );
  if (!baseSoMatch.customerId) {
    baseSoMatch.customerId = { $exists: true, $ne: null };
  }

  const dcMatch = applyAddedByFilter(
    {
      ...buildMatchQuery(datedFilter, 'challanDate'),
      status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
    },
    datedFilter,
  );
  if (!dcMatch.customerId) {
    dcMatch.customerId = { $exists: true, $ne: null };
  }

  const invMatch = applyAddedByFilter(
    {
      ...buildMatchQuery(datedFilter, 'invoiceDate'),
      status: { $ne: INVOICE_STATUS.CANCELLED },
      isSplit: { $ne: true },
    },
    datedFilter,
  );
  if (!invMatch.customerId) {
    invMatch.customerId = { $exists: true, $ne: null };
  }

  const payMatch = applyAddedByFilter(
    {
      ...buildMatchQuery(datedFilter, 'paymentDate'),
      status: PAYMENT_STATUS.APPROVED,
      isSplit: { $ne: true },
    },
    datedFilter,
  );
  if (!payMatch.customerId) {
    payMatch.customerId = { $exists: true, $ne: null };
  }

  const [soQtyAgg, soAmountAgg, dcQtyAgg, invAgg, payAgg] = await Promise.all([
    SalesOrder.aggregate(buildPartyQtyByUomPipeline(baseSoMatch)),
    SalesOrder.aggregate(buildPartyAmountPipeline(baseSoMatch)),
    DeliveryChallan.aggregate(buildPartyQtyByUomPipeline(dcMatch)),
    Invoice.aggregate(buildPartyAmountPipeline(invMatch)),
    PaymentReceived.aggregate([
      { $match: payMatch },
      {
        $group: {
          _id: { customerId: '$customerId' },
          amount: {
            $sum: {
              $multiply: [{ $ifNull: ['$amountReceived', 0] }, { $ifNull: ['$exchangeRate', 1] }],
            },
          },
        },
      },
    ]),
  ]);

  const unitIdsNeedingLookup = [];
  [...soQtyAgg, ...dcQtyAgg].forEach(row => {
    if (row.itemUnitId && !String(row.itemUnit || '').trim()) {
      unitIdsNeedingLookup.push(row.itemUnitId);
    }
  });
  const unitNameMap = await resolveUnitNames(unitIdsNeedingLookup, filter.companyId);

  const partyMap = new Map();

  const ensureRow = customerId => {
    const key = String(customerId);
    if (!partyMap.has(key)) {
      partyMap.set(key, {
        rowKey: key,
        customerId: customerId || null,
        orderQtyRows: [],
        dispatchedQtyRows: [],
        orderAmount: 0,
        invoiceAmount: 0,
        paymentReceived: 0,
      });
    }
    return partyMap.get(key);
  };

  soQtyAgg.forEach(row => {
    const customerId = row._id?.customerId;
    if (!customerId) return;
    ensureRow(customerId).orderQtyRows.push(row);
  });

  soAmountAgg.forEach(row => {
    const customerId = row._id?.customerId;
    if (!customerId) return;
    ensureRow(customerId).orderAmount = round2(row.amount);
  });

  dcQtyAgg.forEach(row => {
    const customerId = row._id?.customerId;
    if (!customerId) return;
    ensureRow(customerId).dispatchedQtyRows.push(row);
  });

  invAgg.forEach(row => {
    const customerId = row._id?.customerId;
    if (!customerId) return;
    ensureRow(customerId).invoiceAmount = round2(row.amount);
  });

  payAgg.forEach(row => {
    const customerId = row._id?.customerId;
    if (!customerId) return;
    ensureRow(customerId).paymentReceived = round2(row.amount);
  });

  const customerIds = [
    ...new Set(
      Array.from(partyMap.values())
        .map(r => r.customerId?.toString())
        .filter(Boolean),
    ),
  ].map(id => new mongoose.Types.ObjectId(id));

  const customers = await Customer.find(
    { _id: { $in: customerIds }, 'Role.isCustomer': true },
    {
      customerDisplayName: 1,
      customerNumber: 1,
      'address.billing.city': 1,
      'address.billing.state': 1,
    },
  ).lean();

  const customerMap = new Map(
    customers.map(c => [
      c._id.toString(),
      {
        customerName: c.customerDisplayName || 'Unknown Customer',
        customerNumber: c.customerNumber || null,
        city: c.address?.billing?.city || null,
        state: c.address?.billing?.state || null,
      },
    ]),
  );

  const stateFilterValues = String(filter?.state || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  const cityFilterValues = String(filter?.city || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);

  let finalData = Array.from(partyMap.values())
    .map(row => {
      const customer = customerMap.get(row.customerId?.toString());
      if (!customer) return null;

      return {
        rowKey: row.rowKey,
        customerId: row.customerId,
        customerName: customer.customerName,
        customerNumber: customer.customerNumber,
        city: customer.city,
        state: customer.state,
        orderQtyByUom: toQtyByUomEntries(row.orderQtyRows, unitNameMap),
        dispatchedQtyByUom: toQtyByUomEntries(row.dispatchedQtyRows, unitNameMap),
        orderAmount: row.orderAmount,
        invoiceAmount: row.invoiceAmount,
        paymentReceived: row.paymentReceived,
      };
    })
    .filter(Boolean)
    .filter(row => {
      if (stateFilterValues.length && !stateFilterValues.includes(String(row.state || '').toLowerCase())) {
        return false;
      }
      if (cityFilterValues.length && !cityFilterValues.includes(String(row.city || '').toLowerCase())) {
        return false;
      }
      return true;
    });

  finalData = applyPartyWiseSorting(finalData, filter.sortBy || 'orderAmount:desc');

  const totalRecords = finalData.length;
  const pageRows = finalData.slice(skip, skip + limit);

  return {
    result: pageRows,
    otherDetails: {
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit) || 0,
      page,
      limit,
    },
  };
};

const exportPartyWiseBusinessPerformance = async (filter, res) => {
  const { result } = await partyWiseBusinessPerformance({
    ...filter,
    page: 1,
    limit: Number(filter?.limit) > 0 ? Number(filter.limit) : 100000,
  });

  const columns = [
    { header: 'Sr. No', key: 's_no', width: 10 },
    { header: 'Customer No', key: 'customerNumber', width: 18 },
    { header: 'Customer Name', key: 'customerName', width: 30 },
    { header: 'City', key: 'city', width: 18 },
    { header: 'State', key: 'state', width: 18 },
    { header: 'Order Qty', key: 'orderQty', width: 22 },
    { header: 'Dispatch Qty', key: 'dispatchedQty', width: 22 },
    { header: 'Order', key: 'orderAmount', width: 16 },
    { header: 'Invoice', key: 'invoiceAmount', width: 16 },
    { header: 'Payment', key: 'paymentReceived', width: 16 },
  ];

  const data = (result || []).map(row => ({
    customerNumber: row.customerNumber || '-',
    customerName: row.customerName || '-',
    city: row.city || '-',
    state: row.state || '-',
    orderQty: formatQtyByUomForExport(row.orderQtyByUom),
    dispatchedQty: formatQtyByUomForExport(row.dispatchedQtyByUom),
    orderAmount: row.orderAmount ?? 0,
    invoiceAmount: row.invoiceAmount ?? 0,
    paymentReceived: row.paymentReceived ?? 0,
  }));

  const filename = String(filter?.fileName || 'Customer_Wise_Business_Performance')
    .replace(/\.xlsx$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 120);

  await exportToExcel({ data, columns, filename }, res);
};

module.exports = {
  topCustomersOfSales,
  topItemsOfSales,
  topPurchasedItems,
  topPurchaseOrders,
  topVendorsOfPurchase,
  topCustomersByBalance,
  recentPayments,
  upcomingReceivables,
  overdueInvoices,
  itemProcessAnalytics,
  topVendorsByBalance,
  recentPaymentsMade,
  upcomingPayables,
  overdueBills,
  customersWithSingleInvoice,
  createGeneralSalesAnalytics,
  getGeneralSalesAnalytics,
  getGeneralSalesAnalyticsById,
  updateGeneralSalesAnalytics,
  deleteGeneralSalesAnalytics,
  getGeneralSalesAnalyticsByIdWithData,
  partyWiseBusinessPerformance,
  exportPartyWiseBusinessPerformance,
};
