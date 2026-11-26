const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { getBooksModels, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const { MODULE_NAMES, INVENTORY_TRANSFER_REQUEST } = require('../../../utils/enum');
const { formatTemplateAmount } = require('../shared/schedule');
const { TIMEZONE } = require('../shared/constants');

const STOCK_IN_SOURCES = {
  [MODULE_NAMES.GRPO]: {
    label: 'GRPO',
    modelName: 'GrpoOrder',
    dateField: 'date',
  },
  [MODULE_NAMES.BILL]: {
    label: 'Bill',
    modelName: 'Bill',
    dateField: 'billDate',
  },
};

const STOCK_OUT_SOURCES = {
  [MODULE_NAMES.INVOICE]: {
    label: 'Invoice',
    modelName: 'Invoice',
    dateField: 'invoiceDate',
  },
  [MODULE_NAMES.DELIVERY_CHALLAN]: {
    label: 'Delivery Challan',
    modelName: 'DeliveryChallan',
    dateField: 'challanDate',
  },
};

const formatSignedUnits = value => {
  const rounded = Math.round(value || 0);
  if (rounded > 0) return `+${rounded.toLocaleString('en-IN')}`;
  return rounded.toLocaleString('en-IN');
};

const formatUnits = value => Math.round(value || 0).toLocaleString('en-IN');

const aggregateDocItemStats = async (Model, { companyId, dateField, startDate, endDate }) => {
  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    [dateField]: { $gte: startDate, $lte: endDate },
    status: { $ne: 'CANCELLED' },
  };

  const pipeline = [{ $match: match }];

  if (Model.modelName === 'Invoice' || Model.modelName === 'Bill') {
    pipeline.push({
      $match: {
        $or: [
          { isSplit: false },
          { isSplit: { $exists: false } },
          {
            isSplit: true,
            splitWiseType: { $ne: 'Split By Price' },
          },
        ],
      },
    });
  }

  pipeline.push(
    { $unwind: '$items' },
    {
      $group: {
        _id: null,
        units: { $sum: { $ifNull: ['$items.quantity', 0] } },
        value: {
          $sum: {
            $multiply: [{ $ifNull: ['$items.amount', 0] }, { $ifNull: ['$exchangeRate', 1] }],
          },
        },
      },
    },
  );

  const [totals] = await Model.aggregate(pipeline);

  return {
    units: totals?.units || 0,
    value: totals?.value || 0,
  };
};

const getTopStockOutItem = async (Model, { companyId, dateField, startDate, endDate }) => {
  const { Item } = getBooksCrmModels();

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    [dateField]: { $gte: startDate, $lte: endDate },
    status: { $ne: 'CANCELLED' },
  };

  const pipeline = [{ $match: match }];

  if (Model.modelName === 'Invoice' || Model.modelName === 'Bill') {
    pipeline.push({
      $match: {
        $or: [
          { isSplit: false },
          { isSplit: { $exists: false } },
          {
            isSplit: true,
            splitWiseType: { $ne: 'Split By Price' },
          },
        ],
      },
    });
  }

  pipeline.push(
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.itemId',
        units: { $sum: { $ifNull: ['$items.quantity', 0] } },
        itemName: { $first: '$items.itemName' },
      },
    },
    { $match: { units: { $gt: 0 } } },
    { $sort: { units: -1 } },
    { $limit: 1 },
  );

  const [top] = await Model.aggregate(pipeline);

  if (!top) {
    return { name: '-', unitsLabel: '-' };
  }

  let name = top.itemName;
  if (!name && top._id) {
    const item = await Item.findById(top._id).select('itemName').lean();
    name = item?.itemName;
  }

  return {
    name: name || 'Item',
    unitsLabel: Math.round(top.units).toLocaleString('en-IN'),
  };
};

const getTopStockInItem = async (Model, { companyId, dateField, startDate, endDate }) => {
  const { Item } = getBooksCrmModels();

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    [dateField]: { $gte: startDate, $lte: endDate },
    status: { $ne: 'CANCELLED' },
  };

  const pipeline = [{ $match: match }];

  if (Model.modelName === 'Invoice' || Model.modelName === 'Bill') {
    pipeline.push({
      $match: {
        $or: [
          { isSplit: false },
          { isSplit: { $exists: false } },
          {
            isSplit: true,
            splitWiseType: { $ne: 'Split By Price' },
          },
        ],
      },
    });
  }

  pipeline.push(
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.itemId',
        units: { $sum: { $ifNull: ['$items.quantity', 0] } },
        itemName: { $first: '$items.itemName' },
      },
    },
    { $match: { units: { $gt: 0 } } },
    { $sort: { units: -1 } },
    { $limit: 1 },
  );

  const [top] = await Model.aggregate(pipeline);

  if (!top) {
    return { name: '-', unitsLabel: '-' };
  }

  let name = top.itemName;
  if (!name && top._id) {
    const item = await Item.findById(top._id).select('itemName').lean();
    name = item?.itemName;
  }

  return {
    name: name || 'Item',
    unitsLabel: Math.round(top.units).toLocaleString('en-IN'),
  };
};

const getTransferredUnits = async (companyId, startDate, endDate) => {
  const { InventoryTransferRequest } = getBooksModels();

  const transfers = await InventoryTransferRequest.find({
    companyId,
    status: INVENTORY_TRANSFER_REQUEST.APPROVED,
    date: { $gte: startDate, $lte: endDate },
  })
    .select('quantity rawMaterials isProductionOrderReq')
    .lean();

  let total = 0;
  for (const doc of transfers) {
    if (doc.isProductionOrderReq && Array.isArray(doc.rawMaterials) && doc.rawMaterials.length) {
      total += doc.rawMaterials.reduce((sum, rm) => sum + (Number(rm.productionOrderRequiredUnit) || 0), 0);
    } else {
      total += Number(doc.quantity) || 0;
    }
  }

  return total;
};

const getAdjustedUnits = async (companyId, startDate, endDate) => {
  const { InventoryAdjustment } = getBooksModels();

  const [result] = await InventoryAdjustment.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: 'APPROVED',
        adjustmentDate: { $gte: startDate, $lte: endDate },
      },
    },
    { $unwind: '$items' },
    {
      $group: {
        _id: null,
        total: { $sum: { $ifNull: ['$items.adjustedStock', 0] } },
      },
    },
  ]);

  return result?.total || 0;
};

const getPeriodInventoryStats = async (companyId, startDate, endDate) => {
  const { CompanySettings } = getCommonModels();
  const booksModels = getBooksModels();

  const settings = await CompanySettings.findOne({ companyId }).select('inventoryConfig').lean();
  const stockInKey = settings?.inventoryConfig?.purchaseFlowStockAddSource || MODULE_NAMES.GRPO;
  const stockOutKey = settings?.inventoryConfig?.salesFlowStockDeductSource || MODULE_NAMES.DELIVERY_CHALLAN;

  const stockInSource = STOCK_IN_SOURCES[stockInKey] || STOCK_IN_SOURCES[MODULE_NAMES.GRPO];
  const stockOutSource = STOCK_OUT_SOURCES[stockOutKey] || STOCK_OUT_SOURCES[MODULE_NAMES.DELIVERY_CHALLAN];

  const StockInModel = booksModels[stockInSource.modelName];
  const StockOutModel = booksModels[stockOutSource.modelName];

  const [stockIn, stockOut, transferred, adjusted, topMoverOut, topMoverIn] = await Promise.all([
    aggregateDocItemStats(StockInModel, {
      companyId,
      dateField: stockInSource.dateField,
      startDate,
      endDate,
    }),
    aggregateDocItemStats(StockOutModel, {
      companyId,
      dateField: stockOutSource.dateField,
      startDate,
      endDate,
    }),
    getTransferredUnits(companyId, startDate, endDate),
    getAdjustedUnits(companyId, startDate, endDate),
    getTopStockOutItem(StockOutModel, {
      companyId,
      dateField: stockOutSource.dateField,
      startDate,
      endDate,
    }),
    getTopStockInItem(StockInModel, {
      companyId,
      dateField: stockInSource.dateField,
      startDate,
      endDate,
    }),
  ]);

  const netChange = stockIn.units - (stockOut.units - adjusted);

  return {
    StockInLabel: stockInSource.label,
    UnitsReceived: stockIn.units,
    StockInValue: stockIn.value,
    StockOutLabel: stockOutSource.label,
    UnitsSold: stockOut.units,
    Transferred: transferred,
    Adjusted: adjusted,
    NetChange: netChange,
    TopMoverOutName: topMoverOut.name,
    TopMoverOut: topMoverOut.unitsLabel,
    TopMoverInName: topMoverIn.name,
    TopMoverIn: topMoverIn.unitsLabel,
  };
};

const formatMtdPeriodLabel = periodEnd => {
  const end = moment.isMoment(periodEnd) ? periodEnd.clone().tz(TIMEZONE) : moment(periodEnd).tz(TIMEZONE);
  const start = end.clone().startOf('month');
  return `${start.format('D MMM YYYY')} to ${end.format('D MMM YYYY')}`;
};

const getSummaryData = async (companyId, startDate, endDate, dateLabel, companyName, options = {}) => {
  const { incremental = false, periodEnd } = options;

  const periodStats = await getPeriodInventoryStats(companyId, startDate, endDate);

  const summary = {
    Date: dateLabel,
    CompanyName: companyName || 'Company',
    ...periodStats,
    incremental: false,
  };

  if (!incremental) {
    return summary;
  }

  const mtdEndMoment = moment.isMoment(periodEnd) ? periodEnd.clone().tz(TIMEZONE) : moment(endDate).tz(TIMEZONE);
  const mtdStart = mtdEndMoment.clone().startOf('month').toDate();
  const mtdEnd = mtdEndMoment.clone().endOf('day').toDate();
  const mtdStats = await getPeriodInventoryStats(companyId, mtdStart, mtdEnd);

  return {
    ...summary,
    incremental: true,
    MtdDate: formatMtdPeriodLabel(mtdEndMoment),
    MtdStockInLabel: mtdStats.StockInLabel,
    MtdUnitsReceived: mtdStats.UnitsReceived,
    MtdStockInValue: mtdStats.StockInValue,
    MtdStockOutLabel: mtdStats.StockOutLabel,
    MtdUnitsSold: mtdStats.UnitsSold,
    MtdTransferred: mtdStats.Transferred,
    MtdAdjusted: mtdStats.Adjusted,
    MtdNetChange: mtdStats.NetChange,
    MtdTopMoverOutName: mtdStats.TopMoverOutName,
    MtdTopMoverOut: mtdStats.TopMoverOut,
    MtdTopMoverInName: mtdStats.TopMoverInName,
    MtdTopMoverIn: mtdStats.TopMoverIn,
  };
};

const buildPeriodBodyParameters = data => [
  { type: 'text', text: data.Date },
  { type: 'text', text: data.CompanyName },
  { type: 'text', text: data.StockInLabel },
  { type: 'text', text: formatUnits(data.UnitsReceived) },
  { type: 'text', text: formatTemplateAmount(data.StockInValue) },
  { type: 'text', text: data.StockOutLabel },
  { type: 'text', text: formatUnits(data.UnitsSold) },
  { type: 'text', text: formatSignedUnits(data.Transferred) },
  { type: 'text', text: formatSignedUnits(data.Adjusted) },
  { type: 'text', text: formatSignedUnits(data.NetChange) },
  { type: 'text', text: data.TopMoverOutName },
  { type: 'text', text: data.TopMoverOut },
  { type: 'text', text: data.TopMoverInName },
  { type: 'text', text: data.TopMoverIn },
];

const buildTemplateComponents = data => {
  const parameters = buildPeriodBodyParameters(data);

  if (data.incremental) {
    parameters.push(
      { type: 'text', text: data.MtdDate },
      { type: 'text', text: data.MtdStockInLabel },
      { type: 'text', text: formatUnits(data.MtdUnitsReceived) },
      { type: 'text', text: formatTemplateAmount(data.MtdStockInValue) },
      { type: 'text', text: data.MtdStockOutLabel },
      { type: 'text', text: formatUnits(data.MtdUnitsSold) },
      { type: 'text', text: formatSignedUnits(data.MtdTransferred) },
      { type: 'text', text: formatSignedUnits(data.MtdAdjusted) },
      { type: 'text', text: formatSignedUnits(data.MtdNetChange) },
      { type: 'text', text: data.MtdTopMoverOutName },
      { type: 'text', text: data.MtdTopMoverOut },
      { type: 'text', text: data.MtdTopMoverInName },
      { type: 'text', text: data.MtdTopMoverIn },
    );
  }

  return [{ type: 'body', parameters }];
};

module.exports = {
  getSummaryData,
  buildTemplateComponents,
};
