const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksCrmModels, getClientConnection, getBooksModels } = require('../../../services/model.service');
const { SALES_ORDER_STATUS, INVOICE_STATUS } = require('../../../utils/enum');
const mongoose = require('mongoose');
const { SUB_ITEM_GROUP_MESSAGES, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES } = require('../../../utils/messages');

const SPLIT_BY_PRICE = 'Split By Price';
const SPLIT_BY_QTY = 'Split By Qty';

const defaultSplitAnalytics = () => ({
  totalSales: 0,
  totalOrders: 0,
  totalQuantitySold: 0,
  totalQuantityOrders: 0,
  splitByPrice: { sales: 0, quantity: 0 },
  splitByQty: { sales: 0, quantity: 0 },
});

const defaultAnalytics = () => ({
  totalSales: 0,
  totalOrders: 0,
  totalQuantitySold: 0,
  totalQuantityOrders: 0,
});

const createSubItemGroupAnalyticsConfig = async configBody => {
  const { SubItemGroup } = getBooksCrmModels();
  const { SubItemGroupAnalyticsConfig } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const existingConfig = await SubItemGroupAnalyticsConfig.findOne({
      companyId: configBody.companyId,
      groupTitle: configBody.groupTitle,
    });

    if (existingConfig) {
      throw new ApiError(httpStatus.CONFLICT, 'Configuration for this Sub Item Group already exists');
    }

    for (const subItemGroupId of configBody.subItemGroupIds) {
      const subItemGroup = await SubItemGroup.findById(subItemGroupId).session(session);
      if (!subItemGroup) {
        throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
      }
      if (subItemGroup.companyId.toString() !== configBody.companyId.toString()) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Sub Item Group with name "${subItemGroup.name}" does not belong to the specified company`,
        );
      }
    }

    const config = await SubItemGroupAnalyticsConfig.create([configBody], { session });
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

const querySubItemGroupAnalyticsConfigs = async filter => {
  const { SubItemGroupAnalyticsConfig, Invoice } = getBooksModels();
  const { Item, SubItemGroup, SalesOrder } = getBooksCrmModels();
  const configs = await SubItemGroupAnalyticsConfig.find({ companyId: filter.companyId }).lean();

  const subItemGroupIds = [];
  configs.forEach(config => {
    subItemGroupIds.push(...config.subItemGroupIds);
  });

  const allItems = await Item.find({
    subItemGroup: { $in: subItemGroupIds },
    companyId: filter.companyId,
  })
    .select('_id itemName itemType itemModelNo itemNo hsnCode description subItemGroup itemStatus')
    .lean();

  const items = {};
  allItems.forEach(item => {
    const subItemGroupId = item.subItemGroup.toString();
    if (!items[subItemGroupId]) {
      items[subItemGroupId] = [];
    }
    items[subItemGroupId].push(item);
  });

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

  const allItemIds = allItems.map(item => item._id);

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

  const [allInvoices, allSalesOrders] = await Promise.all([
    Invoice.find(invoiceQueryFilter)
      .select('_id items invoiceDate invoiceId customerId total exchangeRate isSplit splitWiseType')
      .lean(),
    SalesOrder.find(salesOrderQueryFilter).select('_id items orderDate orderId customerId total exchangeRate').lean(),
  ]);

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

  const calculationsBySubItemGroupId = {};
  const itemAnalytics = {};

  for (const subItemGroupId of subItemGroupIds) {
    const itemList = items[subItemGroupId] || [];

    if (itemList.length === 0) {
      calculationsBySubItemGroupId[subItemGroupId] = showSplit ? defaultSplitAnalytics() : defaultAnalytics();
      itemAnalytics[subItemGroupId] = {};
      continue;
    }

    const groupAnalytics = showSplit ? defaultSplitAnalytics() : defaultAnalytics();
    itemAnalytics[subItemGroupId] = {};

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

    calculationsBySubItemGroupId[subItemGroupId] = {
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

  const allSubItemGroupIds = configs.flatMap(c => c.subItemGroupIds);
  const subItemGroupsDocs = await SubItemGroup.find({ _id: { $in: allSubItemGroupIds } })
    .select('_id name')
    .lean();
  const subItemGroupMap = {};
  subItemGroupsDocs.forEach(g => {
    subItemGroupMap[g._id.toString()] = g;
  });

  const transformedResult = configs.map(config => ({
    configId: config._id,
    groupTitle: config.groupTitle,
    subItemGroups: config.subItemGroupIds.map(subItemGroupId => {
      const analytics =
        calculationsBySubItemGroupId[subItemGroupId] || (showSplit ? defaultSplitAnalytics() : defaultAnalytics());
      const groupDoc = subItemGroupMap[subItemGroupId.toString()];
      const groupItems = itemAnalytics[subItemGroupId] || {};

      const itemsWithData = Object.values(groupItems).filter(
        item =>
          item.invoices.length > 0 ||
          item.salesOrders.length > 0 ||
          (showSplit && item.splitInvoices && item.splitInvoices.length > 0),
      );

      return {
        subItemGroupId,
        subItemGroupName: groupDoc ? groupDoc.name : null,
        analytics,
        items: itemsWithData,
      };
    }),
  }));

  return transformedResult;
};

const updateSubItemGroupAnalyticsConfigById = async (configId, updateBody, companyId) => {
  const { SubItemGroup } = getBooksCrmModels();
  const { SubItemGroupAnalyticsConfig } = getBooksModels();
  const config = await SubItemGroupAnalyticsConfig.findOne({ _id: configId, companyId });
  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (updateBody.groupTitle) {
    const existingConfig = await SubItemGroupAnalyticsConfig.findOne({
      companyId: companyId,
      groupTitle: updateBody.groupTitle,
    });

    if (existingConfig && existingConfig._id.toString() !== configId) {
      throw new ApiError(httpStatus.CONFLICT, 'Configuration with this group title already exists');
    }
  }

  for (const subItemGroupId of updateBody.subItemGroupIds || []) {
    const subItemGroup = await SubItemGroup.findById(subItemGroupId);
    if (!subItemGroup) {
      throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    if (subItemGroup.companyId.toString() !== config.companyId.toString()) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Sub Item Group with ID "${subItemGroupId}" does not belong to the specified company`,
      );
    }
  }

  Object.assign(config, updateBody);
  await config.save();
  return config;
};

const deleteSubItemGroupAnalyticsConfigById = async (configId, companyId) => {
  const { SubItemGroupAnalyticsConfig } = getBooksModels();
  const config = await SubItemGroupAnalyticsConfig.findOne({ _id: configId, companyId });
  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  await SubItemGroupAnalyticsConfig.deleteOne({ _id: configId, companyId });
};

const getAnalyticsBySubItemGroupId = async (subItemGroupId, companyId, filter) => {
  const { Invoice } = getBooksModels();
  const { Item, SubItemGroup, SalesOrder } = getBooksCrmModels();

  const subItemGroupDoc = await SubItemGroup.findOne({ _id: subItemGroupId, companyId });
  if (!subItemGroupDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
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
  const items = await Item.find({ subItemGroup: subItemGroupId, companyId })
    .select('_id itemName itemType itemModelNo itemNo hsnCode description itemStatus')
    .lean();
  if (!items || items.length === 0) {
    return {
      subItemGroupId,
      subItemGroupName: subItemGroupDoc.name,
      analytics: {
        totalSales: 0,
        totalOrders: 0,
        totalQuantitySold: 0,
        totalQuantityOrders: 0,
      },
    };
  }

  const itemIds = items.map(i => i._id);

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
    subItemGroupId,
    subItemGroupName: subItemGroupDoc.name,
    analytics,
    items: itemsWithData,
  };
};

module.exports = {
  createSubItemGroupAnalyticsConfig,
  querySubItemGroupAnalyticsConfigs,
  updateSubItemGroupAnalyticsConfigById,
  deleteSubItemGroupAnalyticsConfigById,
  getAnalyticsBySubItemGroupId,
};
