const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksCrmModels, getClientConnection, getBooksModels } = require('../../../services/model.service');
const { SALES_ORDER_STATUS, INVOICE_STATUS } = require('../../../utils/enum');
const mongoose = require('mongoose');
const { ITEM_GROUP_MESSAGES, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES } = require('../../../utils/messages');

const SPLIT_BY_PRICE = 'Split By Price';
const SPLIT_BY_QTY = 'Split By Qty';

/** Default analytics shape when showSplit is true */
const defaultSplitAnalytics = () => ({
  totalSales: 0,
  totalOrders: 0,
  totalQuantitySold: 0,
  totalQuantityOrders: 0,
  splitByPrice: { sales: 0, quantity: 0 },
  splitByQty: { sales: 0, quantity: 0 },
});

/** Default analytics shape when showSplit is false */
const defaultAnalytics = () => ({
  totalSales: 0,
  totalOrders: 0,
  totalQuantitySold: 0,
  totalQuantityOrders: 0,
});

const createItemGroupAnalyticsConfig = async configBody => {
  const { ItemGroup } = getBooksCrmModels();
  const { ItemGroupAnalyticsConfig } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const existingConfig = await ItemGroupAnalyticsConfig.findOne({
      companyId: configBody.companyId,
      groupTitle: configBody.groupTitle,
    });

    if (existingConfig) {
      throw new ApiError(httpStatus.CONFLICT, 'Configuration for this Item Group already exists');
    }

    for (const itemGroupId of configBody.itemGroupIds) {
      const itemGroup = await ItemGroup.findById(itemGroupId).session(session);
      if (!itemGroup) {
        throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
      }
      if (itemGroup.companyId.toString() !== configBody.companyId.toString()) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Item Group with name "${itemGroup.name}" does not belong to the specified company`,
        );
      }
    }

    const config = await ItemGroupAnalyticsConfig.create([configBody], { session });
    await session.commitTransaction();
    return config[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryItemGroupAnalyticsConfigs = async filter => {
  const { ItemGroupAnalyticsConfig, Invoice } = getBooksModels();
  const { Item, ItemGroup, SalesOrder } = getBooksCrmModels();
  const configs = await ItemGroupAnalyticsConfig.find({ companyId: filter.companyId }).lean();

  const itemGroupIds = [];
  configs.forEach(config => {
    itemGroupIds.push(...config.itemGroupIds);
  });

  // Fetch all items for all item groups in one query
  const allItems = await Item.find({
    itemGroup: { $in: itemGroupIds },
    companyId: filter.companyId,
  })
    .select('_id itemName itemType itemModelNo itemNo hsnCode description itemGroup itemStatus')
    .lean();

  // Group items by itemGroup
  const items = {};
  allItems.forEach(item => {
    const itemGroupId = item.itemGroup.toString();
    if (!items[itemGroupId]) {
      items[itemGroupId] = [];
    }
    items[itemGroupId].push(item);
  });

  // Set up date filters
  let salesOrderFilter = { status: { $ne: SALES_ORDER_STATUS.CANCELLED } };
  let invoiceFilter = { status: { $ne: INVOICE_STATUS.CANCELLED } };
  if (filter.startDate && filter.endDate) {
    salesOrderFilter = { ...salesOrderFilter, orderDate: { $gte: filter.startDate, $lte: filter.endDate } };
    invoiceFilter = { ...invoiceFilter, invoiceDate: { $gte: filter.startDate, $lte: filter.endDate } };
  }

  if (filter.divisionId) {
    salesOrderFilter = {
      ...salesOrderFilter,
      divisionId: {
        $in: filter.divisionId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
    invoiceFilter = {
      ...invoiceFilter,
      divisionId: {
        $in: filter.divisionId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
  }

  if (filter.branchId) {
    salesOrderFilter = {
      ...salesOrderFilter,
      branchId: {
        $in: filter.branchId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
    invoiceFilter = {
      ...invoiceFilter,
      branchId: {
        $in: filter.branchId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
  }

  // Get all item IDs for batch queries
  const allItemIds = allItems.map(item => item._id);

  // When isSplit=true is explicitly passed, fetch both normal and split invoices
  // and expose split-specific fields. Otherwise keep the original behaviour
  // (normal invoices only, no split fields in the response).
  const showSplit = filter.isSplit === true;

  const invoiceQueryFilter = {
    'items.itemId': { $in: allItemIds },
    companyId: filter.companyId,
    ...invoiceFilter,
    ...(showSplit ? {} : { isSplit: false }),
  };

  const salesOrderQueryFilter = {
    'items.itemId': { $in: allItemIds },
    companyId: filter.companyId,
    ...salesOrderFilter,
  };

  // Fetch all invoices and sales orders in batch queries
  const [allInvoices, allSalesOrders] = await Promise.all([
    Invoice.find(invoiceQueryFilter)
      .select('_id items invoiceDate invoiceId customerId total exchangeRate isSplit splitWiseType')
      .lean(),
    SalesOrder.find(salesOrderQueryFilter).select('_id items orderDate orderId customerId total exchangeRate').lean(),
  ]);

  // Bucket invoices/sales orders by itemId once so each item is an O(1) lookup
  // instead of re-scanning every document per item.
  const bucketByItemId = documents => {
    const map = new Map();
    for (const doc of documents) {
      const seen = new Set();
      for (const line of doc.items) {
        const id = line.itemId?.toString();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        let bucket = map.get(id);
        if (!bucket) {
          bucket = [];
          map.set(id, bucket);
        }
        bucket.push(doc);
      }
    }
    return map;
  };

  const invoicesByItemId = bucketByItemId(allInvoices);
  const salesOrdersByItemId = bucketByItemId(allSalesOrders);

  // Calculate analytics for each item group and individual items
  const calculationsByItemGroupId = {};
  const itemAnalytics = {};

  for (const itemGroupId of itemGroupIds) {
    const itemList = items[itemGroupId] || [];

    if (itemList.length === 0) {
      calculationsByItemGroupId[itemGroupId] = showSplit ? defaultSplitAnalytics() : defaultAnalytics();
      itemAnalytics[itemGroupId] = {};
      continue;
    }

    const groupAnalytics = showSplit ? defaultSplitAnalytics() : defaultAnalytics();
    itemAnalytics[itemGroupId] = {};

    itemList.forEach(item => {
      const itemId = item._id.toString();
      const itemSplit = showSplit ? defaultSplitAnalytics() : defaultAnalytics();

      const itemInvoices = invoicesByItemId.get(itemId) || [];
      const itemSalesOrders = salesOrdersByItemId.get(itemId) || [];

      itemInvoices.forEach(invoice => {
        const fxRate = invoice.exchangeRate ?? 1;
        const relevantItems = invoice.items.filter(i => i.itemId.toString() === itemId);
        const isSplit = showSplit && invoice.isSplit;
        const splitType = invoice.splitWiseType;

        relevantItems.forEach(invItem => {
          const amount = (parseFloat(invItem.amount) || 0) * fxRate;
          const quantity = parseFloat(invItem.quantity) || 0;
          if (isSplit && splitType === SPLIT_BY_PRICE) {
            itemSplit.splitByPrice.sales += amount;
            itemSplit.splitByPrice.quantity += quantity;
          } else if (isSplit && splitType === SPLIT_BY_QTY) {
            itemSplit.splitByQty.sales += amount;
            itemSplit.splitByQty.quantity += quantity;
          } else {
            itemSplit.totalSales += amount;
            itemSplit.totalQuantitySold += quantity;
          }
        });
      });

      itemSalesOrders.forEach(salesOrder => {
        const fxRateSo = salesOrder.exchangeRate ?? 1;
        const relevantItems = salesOrder.items.filter(i => i.itemId.toString() === itemId);

        relevantItems.forEach(soItem => {
          const amount = (parseFloat(soItem.amount) || 0) * fxRateSo;
          const quantity = parseFloat(soItem.quantity) || 0;
          itemSplit.totalOrders += amount;
          itemSplit.totalQuantityOrders += quantity;
        });
      });

      const hasTransactions = itemInvoices.length > 0 || itemSalesOrders.length > 0;
      if (hasTransactions) {
        groupAnalytics.totalSales += itemSplit.totalSales;
        groupAnalytics.totalOrders += itemSplit.totalOrders;
        groupAnalytics.totalQuantitySold += itemSplit.totalQuantitySold;
        groupAnalytics.totalQuantityOrders += itemSplit.totalQuantityOrders;
        if (showSplit) {
          groupAnalytics.splitByPrice.sales += itemSplit.splitByPrice?.sales ?? 0;
          groupAnalytics.splitByPrice.quantity += itemSplit.splitByPrice?.quantity ?? 0;
          groupAnalytics.splitByQty.sales += itemSplit.splitByQty?.sales ?? 0;
          groupAnalytics.splitByQty.quantity += itemSplit.splitByQty?.quantity ?? 0;
        }
      }
    });

    calculationsByItemGroupId[itemGroupId] = {
      totalSales: parseInt(groupAnalytics.totalSales, 10),
      totalOrders: parseInt(groupAnalytics.totalOrders, 10),
      totalQuantitySold: groupAnalytics.totalQuantitySold,
      totalQuantityOrders: groupAnalytics.totalQuantityOrders,
      ...(showSplit && {
        splitByPrice: {
          sales: parseFloat(groupAnalytics.splitByPrice.sales.toFixed(2)),
          quantity: groupAnalytics.splitByPrice.quantity,
        },
        splitByQty: {
          sales: parseFloat(groupAnalytics.splitByQty.sales.toFixed(2)),
          quantity: groupAnalytics.splitByQty.quantity,
        },
        totalSalesQuantity: (groupAnalytics.totalQuantitySold || 0) + (groupAnalytics.splitByQty.quantity || 0),
        totalSalesAmount: parseFloat(
          (
            (groupAnalytics.totalSales || 0) +
            (groupAnalytics.splitByQty.sales || 0) +
            (groupAnalytics.splitByPrice.sales || 0)
          ).toFixed(2),
        ),
      }),
    };
  }

  // Fetch item groups (to get names)
  const allItemGroupIds = configs.flatMap(c => c.itemGroupIds);
  const itemGroupsDocs = await ItemGroup.find({ _id: { $in: allItemGroupIds } })
    .select('_id name')
    .lean();
  const itemGroupMap = {};
  itemGroupsDocs.forEach(g => {
    itemGroupMap[g._id.toString()] = g;
  });

  // Transform results to include item drill-down
  const transformedResult = configs.map(config => ({
    configId: config._id,
    groupTitle: config.groupTitle,
    itemGroups: config.itemGroupIds.map(itemGroupId => {
      const analytics = calculationsByItemGroupId[itemGroupId] || (showSplit ? defaultSplitAnalytics() : defaultAnalytics());
      const groupDoc = itemGroupMap[itemGroupId.toString()];
      const groupItems = itemAnalytics[itemGroupId] || {};

      const itemsWithData = Object.values(groupItems).filter(
        item =>
          item.invoices.length > 0 ||
          item.salesOrders.length > 0 ||
          (showSplit && item.splitInvoices && item.splitInvoices.length > 0),
      );

      return {
        itemGroupId,
        itemGroupName: groupDoc ? groupDoc.name : null,
        analytics,
        items: itemsWithData, // Only include items that have invoices or sales orders
      };
    }),
  }));

  return transformedResult;
};

const updateItemGroupAnalyticsConfigById = async (configId, updateBody, companyId) => {
  const { ItemGroup } = getBooksCrmModels();
  const { ItemGroupAnalyticsConfig } = getBooksModels();
  const config = await ItemGroupAnalyticsConfig.findOne({ _id: configId, companyId });
  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (updateBody.groupTitle) {
    const existingConfig = await ItemGroupAnalyticsConfig.findOne({
      companyId: companyId,
      groupTitle: updateBody.groupTitle,
    });

    if (existingConfig && existingConfig._id.toString() !== configId) {
      throw new ApiError(httpStatus.CONFLICT, 'Configuration with this group title already exists');
    }
  }

  for (const itemGroupId of updateBody.itemGroupIds || []) {
    const itemGroup = await ItemGroup.findById(itemGroupId);
    if (!itemGroup) {
      throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    if (itemGroup.companyId.toString() !== config.companyId.toString()) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Item Group with ID "${itemGroupId}" does not belong to the specified company`);
    }
  }

  Object.assign(config, updateBody);
  await config.save();
  return config;
};

const deleteItemGroupAnalyticsConfigById = async (configId, companyId) => {
  const { ItemGroupAnalyticsConfig } = getBooksModels();
  const config = await ItemGroupAnalyticsConfig.findOne({ _id: configId, companyId });
  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  await ItemGroupAnalyticsConfig.deleteOne({ _id: configId, companyId });
};

const getAnalyticsByItemGroupId = async (itemGroupId, companyId, filter) => {
  const { Invoice } = getBooksModels();
  const { Item, ItemGroup, SalesOrder } = getBooksCrmModels();

  const itemGroupDoc = await ItemGroup.findOne({ _id: itemGroupId, companyId });
  if (!itemGroupDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  let salesOrderFilter = { status: { $ne: SALES_ORDER_STATUS.CANCELLED } };
  let invoiceFilter = { status: { $ne: INVOICE_STATUS.CANCELLED } };
  if (filter.startDate && filter.endDate) {
    salesOrderFilter = { ...salesOrderFilter, orderDate: { $gte: filter.startDate, $lte: filter.endDate } };
    invoiceFilter = { ...invoiceFilter, invoiceDate: { $gte: filter.startDate, $lte: filter.endDate } };
  }

  if (filter.divisionId) {
    salesOrderFilter = {
      ...salesOrderFilter,
      divisionId: {
        $in: filter.divisionId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
    invoiceFilter = {
      ...invoiceFilter,
      divisionId: {
        $in: filter.divisionId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
  }

  if (filter?.isSplit === undefined) {
    invoiceFilter.isSplit = false;
  }

  if (filter.branchId) {
    salesOrderFilter = {
      ...salesOrderFilter,
      branchId: {
        $in: filter.branchId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
    invoiceFilter = {
      ...invoiceFilter,
      branchId: {
        $in: filter.branchId
          .split(',')
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
      },
    };
  }
  // Step 1: Find all items under this itemGroup
  const items = await Item.find({ itemGroup: itemGroupId, companyId })
    .select('_id itemName itemType itemModelNo itemNo hsnCode description itemStatus')
    .lean();
  if (!items || items.length === 0) {
    return {
      itemGroupId,
      itemGroupName: itemGroupDoc.name,
      analytics: {
        totalSales: 0,
        totalOrders: 0,
        totalQuantitySold: 0,
        totalQuantityOrders: 0,
      },
    };
  }

  const itemIds = items.map(i => i._id);

  // Step 2: Get all invoices & sales orders with these items
  const invoiceList = await Invoice.find({
    'items.itemId': { $in: itemIds },
    companyId,
    ...invoiceFilter,
  })
    .select('_id items invoiceDate invoiceId customerId total exchangeRate isSplit splitWiseType')
    .lean();

  const salesOrderList = await SalesOrder.find({
    'items.itemId': { $in: itemIds },
    companyId,
    ...salesOrderFilter,
  })
    .select('_id items orderDate orderId customerId total exchangeRate')
    .lean();

  // Step 3: Build per-item drill-down detail + group analytics
  const showSplit = filter?.isSplit === true || filter?.isSplit === 'true';

  const bucketByItemId = documents => {
    const map = new Map();
    for (const doc of documents) {
      const seen = new Set();
      for (const line of doc.items) {
        const id = line.itemId?.toString();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        let bucket = map.get(id);
        if (!bucket) {
          bucket = [];
          map.set(id, bucket);
        }
        bucket.push(doc);
      }
    }
    return map;
  };

  const invoicesByItemId = bucketByItemId(invoiceList);
  const salesOrdersByItemId = bucketByItemId(salesOrderList);

  const groupAnalytics = showSplit ? defaultSplitAnalytics() : defaultAnalytics();
  const itemDetailById = {};

  items.forEach(item => {
    const itemId = item._id.toString();
    const itemSplit = showSplit ? defaultSplitAnalytics() : defaultAnalytics();

    const detail = {
      item: {
        _id: item._id,
        itemName: item.itemName,
        itemType: item.itemType,
        itemModelNo: item.itemModelNo,
        itemNo: item.itemNo,
        hsnCode: item.hsnCode,
        description: item.description,
        itemStatus: item.itemStatus,
      },
      invoices: [],
      ...(showSplit && { splitInvoices: [] }),
      salesOrders: [],
    };

    const itemInvoices = invoicesByItemId.get(itemId) || [];
    const itemSalesOrders = salesOrdersByItemId.get(itemId) || [];

    let totalInvoiceAmount = 0;
    let totalSplitInvoiceAmount = 0;
    let totalSalesOrderAmount = 0;

    itemInvoices.forEach(invoice => {
      const fxRate = invoice.exchangeRate ?? 1;
      const relevantItems = invoice.items.filter(i => i.itemId.toString() === itemId);
      const itemTotalInInvoice = relevantItems.reduce((sum, i) => sum + (parseFloat(i.amount) || 0) * fxRate, 0);
      const isSplit = showSplit && invoice.isSplit;
      const splitType = invoice.splitWiseType;

      relevantItems.forEach(invItem => {
        const amount = (parseFloat(invItem.amount) || 0) * fxRate;
        const quantity = parseFloat(invItem.quantity) || 0;
        if (isSplit && splitType === SPLIT_BY_PRICE) {
          itemSplit.splitByPrice.sales += amount;
          itemSplit.splitByPrice.quantity += quantity;
        } else if (isSplit && splitType === SPLIT_BY_QTY) {
          itemSplit.splitByQty.sales += amount;
          itemSplit.splitByQty.quantity += quantity;
        } else {
          itemSplit.totalSales += amount;
          itemSplit.totalQuantitySold += quantity;
        }
      });

      if (isSplit) {
        totalSplitInvoiceAmount += itemTotalInInvoice;
      } else {
        totalInvoiceAmount += itemTotalInInvoice;
      }

      const invoiceSummary = {
        _id: invoice._id,
        invoiceId: invoice.invoiceId,
        invoiceDate: invoice.invoiceDate,
        customerId: invoice.customerId,
        splitWiseType: invoice.splitWiseType || null,
        invoiceTotal: invoice.total,
        itemTotal: parseFloat(itemTotalInInvoice.toFixed(2)),
        itemDetails: relevantItems.map(i => ({
          quantity: i.quantity,
          rate: i.rate,
          amount: i.amount,
          discount: i.discount,
          taxAmount: i.taxAmount,
        })),
      };

      if (showSplit && invoice.isSplit) {
        detail.splitInvoices.push(invoiceSummary);
      } else {
        detail.invoices.push(invoiceSummary);
      }
    });

    itemSalesOrders.forEach(salesOrder => {
      const fxRateSo = salesOrder.exchangeRate ?? 1;
      const relevantItems = salesOrder.items.filter(i => i.itemId.toString() === itemId);
      const itemTotalInOrder = relevantItems.reduce((sum, i) => sum + (parseFloat(i.amount) || 0) * fxRateSo, 0);

      relevantItems.forEach(soItem => {
        const amount = (parseFloat(soItem.amount) || 0) * fxRateSo;
        const quantity = parseFloat(soItem.quantity) || 0;
        itemSplit.totalOrders += amount;
        itemSplit.totalQuantityOrders += quantity;
      });

      totalSalesOrderAmount += itemTotalInOrder;
      detail.salesOrders.push({
        _id: salesOrder._id,
        orderId: salesOrder.orderId,
        orderDate: salesOrder.orderDate,
        customerId: salesOrder.customerId,
        orderTotal: salesOrder.total,
        itemTotal: parseFloat(itemTotalInOrder.toFixed(2)),
        itemDetails: relevantItems.map(i => ({
          quantity: i.quantity,
          rate: i.rate,
          amount: i.amount,
          discount: i.discount,
          taxAmount: i.taxAmount,
        })),
      });
    });

    detail.analytics = {
      totalSales: parseFloat(itemSplit.totalSales.toFixed(2)),
      totalOrders: parseFloat(itemSplit.totalOrders.toFixed(2)),
      totalQuantitySold: itemSplit.totalQuantitySold,
      totalQuantityOrders: itemSplit.totalQuantityOrders,
      ...(showSplit && {
        splitByPrice: {
          sales: parseFloat((itemSplit.splitByPrice?.sales ?? 0).toFixed(2)),
          quantity: itemSplit.splitByPrice?.quantity ?? 0,
        },
        splitByQty: {
          sales: parseFloat((itemSplit.splitByQty?.sales ?? 0).toFixed(2)),
          quantity: itemSplit.splitByQty?.quantity ?? 0,
        },
        totalSalesQuantity: (itemSplit.totalQuantitySold || 0) + (itemSplit.splitByQty?.quantity ?? 0),
        totalSalesAmount: parseFloat(
          ((itemSplit.totalSales || 0) + (itemSplit.splitByQty?.sales ?? 0) + (itemSplit.splitByPrice?.sales ?? 0)).toFixed(2),
        ),
      }),
    };
    detail.totalInvoiceAmount = parseFloat(totalInvoiceAmount.toFixed(2));
    if (showSplit) {
      detail.totalSplitInvoiceAmount = parseFloat(totalSplitInvoiceAmount.toFixed(2));
    }
    detail.totalOrderAmount = parseFloat(totalSalesOrderAmount.toFixed(2));
    detail.grandTotal = parseFloat((totalInvoiceAmount + totalSplitInvoiceAmount + totalSalesOrderAmount).toFixed(2));

    itemDetailById[itemId] = detail;

    const hasTransactions = itemInvoices.length > 0 || itemSalesOrders.length > 0;
    if (hasTransactions) {
      groupAnalytics.totalSales += itemSplit.totalSales;
      groupAnalytics.totalOrders += itemSplit.totalOrders;
      groupAnalytics.totalQuantitySold += itemSplit.totalQuantitySold;
      groupAnalytics.totalQuantityOrders += itemSplit.totalQuantityOrders;
      if (showSplit) {
        groupAnalytics.splitByPrice.sales += itemSplit.splitByPrice?.sales ?? 0;
        groupAnalytics.splitByPrice.quantity += itemSplit.splitByPrice?.quantity ?? 0;
        groupAnalytics.splitByQty.sales += itemSplit.splitByQty?.sales ?? 0;
        groupAnalytics.splitByQty.quantity += itemSplit.splitByQty?.quantity ?? 0;
      }
    }
  });

  const itemsWithData = Object.values(itemDetailById).filter(
    d => d.invoices.length > 0 || d.salesOrders.length > 0 || (showSplit && d.splitInvoices && d.splitInvoices.length > 0),
  );

  const analytics = {
    totalSales: parseInt(groupAnalytics.totalSales, 10),
    totalOrders: parseInt(groupAnalytics.totalOrders, 10),
    totalQuantitySold: groupAnalytics.totalQuantitySold,
    totalQuantityOrders: groupAnalytics.totalQuantityOrders,
    ...(showSplit && {
      splitByPrice: {
        sales: parseFloat(groupAnalytics.splitByPrice.sales.toFixed(2)),
        quantity: groupAnalytics.splitByPrice.quantity,
      },
      splitByQty: {
        sales: parseFloat(groupAnalytics.splitByQty.sales.toFixed(2)),
        quantity: groupAnalytics.splitByQty.quantity,
      },
      totalSalesQuantity: (groupAnalytics.totalQuantitySold || 0) + (groupAnalytics.splitByQty.quantity || 0),
      totalSalesAmount: parseFloat(
        (
          (groupAnalytics.totalSales || 0) +
          (groupAnalytics.splitByQty.sales || 0) +
          (groupAnalytics.splitByPrice.sales || 0)
        ).toFixed(2),
      ),
    }),
  };

  return {
    itemGroupId,
    itemGroupName: itemGroupDoc.name,
    analytics,
    items: itemsWithData,
  };
};

module.exports = {
  createItemGroupAnalyticsConfig,
  queryItemGroupAnalyticsConfigs,
  updateItemGroupAnalyticsConfigById,
  deleteItemGroupAnalyticsConfigById,
  getAnalyticsByItemGroupId,
};
