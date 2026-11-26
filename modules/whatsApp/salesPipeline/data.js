const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { QUOTE_STATUS, INVOICE_STATUS, DELIVERY_CHALLAN_STATUS } = require('../../../utils/enum');
const { formatTemplateAmount, formatTemplateCount, getCurrentIstMoment } = require('../shared/schedule');
const { TIMEZONE } = require('../shared/constants');

const OPEN_STATUSES = [QUOTE_STATUS.DRAFT, QUOTE_STATUS.SENT];

const amountExpr = {
  $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
};

const getNewQuotations = async (Quote, companyId, startDate, endDate) => {
  const [result] = await Quote.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        quoteDate: { $gte: startDate, $lte: endDate },
        status: { $ne: QUOTE_STATUS.CANCELLED },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total: amountExpr,
      },
    },
  ]);

  return {
    count: result?.count || 0,
    total: result?.total || 0,
  };
};

const getConvertedToSalesOrders = async (Quote, companyId, startDate, endDate) => {
  const [result] = await Quote.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: { $ne: QUOTE_STATUS.CANCELLED },
        'convertedTo.0': { $exists: true },
      },
    },
    { $unwind: '$convertedTo' },
    {
      $match: {
        'convertedTo.type': 'SalesOrder',
        'convertedTo.convertedAt': { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
      },
    },
  ]);

  return result?.count || 0;
};

// Invoices in period for Sales Orders that were converted from quotations
// (covers SO → Invoice and SO → Delivery Challan → Invoice).
const getInvoicedFromQuotePipeline = async (Quote, companyId, startDate, endDate) => {
  const { Invoice, DeliveryChallan } = getBooksModels();

  const [converted] = await Quote.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: { $ne: QUOTE_STATUS.CANCELLED },
        'convertedTo.type': 'SalesOrder',
      },
    },
    { $unwind: '$convertedTo' },
    {
      $match: {
        'convertedTo.type': 'SalesOrder',
        'convertedTo.documentId': { $ne: null },
      },
    },
    {
      $group: {
        _id: null,
        salesOrderIds: { $addToSet: '$convertedTo.documentId' },
      },
    },
  ]);

  const salesOrderIds = converted?.salesOrderIds || [];
  if (!salesOrderIds.length) {
    return { count: 0, total: 0 };
  }

  const deliveryChallans = await DeliveryChallan.find({
    companyId,
    status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
    'salesOrders.salesOrderId': { $in: salesOrderIds },
  })
    .select('_id')
    .lean();

  const deliveryChallanIds = deliveryChallans.map(challan => challan._id);

  const invoiceMatch = {
    companyId: new mongoose.Types.ObjectId(companyId),
    invoiceDate: { $gte: startDate, $lte: endDate },
    status: { $ne: INVOICE_STATUS.CANCELLED },
    $or: [{ 'salesOrders.salesOrderId': { $in: salesOrderIds } }],
  };

  if (deliveryChallanIds.length) {
    invoiceMatch.$or.push({ 'deliveryChallanIds.deliveryChallanId': { $in: deliveryChallanIds } });
  }

  const [result] = await Invoice.aggregate([
    { $match: invoiceMatch },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total: amountExpr,
      },
    },
  ]);

  return {
    count: result?.count || 0,
    total: result?.total || 0,
  };
};

const getOpenQuotations = async (Quote, companyId, startDate, endDate) => {
  const [result] = await Quote.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        quoteDate: { $gte: startDate, $lte: endDate },
        status: { $in: OPEN_STATUSES },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total: amountExpr,
      },
    },
  ]);

  return {
    count: result?.count || 0,
    total: result?.total || 0,
  };
};

const getExpiringSoonCount = async (Quote, companyId) => {
  const now = getCurrentIstMoment();
  const expiryStart = now.clone().startOf('day').toDate();
  const expiryEnd = now.clone().add(3, 'days').endOf('day').toDate();

  return Quote.countDocuments({
    companyId,
    status: { $in: OPEN_STATUSES },
    expiryDate: { $gte: expiryStart, $lte: expiryEnd },
  });
};

const getPeriodPipelineStats = async (companyId, startDate, endDate) => {
  const { Quote } = getBooksCrmModels();

  const [newQuotations, convertedOrders, invoiced, openQuotations, expiringSoon] = await Promise.all([
    getNewQuotations(Quote, companyId, startDate, endDate),
    getConvertedToSalesOrders(Quote, companyId, startDate, endDate),
    getInvoicedFromQuotePipeline(Quote, companyId, startDate, endDate),
    getOpenQuotations(Quote, companyId, startDate, endDate),
    getExpiringSoonCount(Quote, companyId),
  ]);

  const conversionRate = newQuotations.count ? `${Math.round((convertedOrders / newQuotations.count) * 100)}` : '0';

  return {
    NewQuotesCount: newQuotations.count,
    NewQuotesValue: newQuotations.total,
    ConvertedOrders: convertedOrders,
    ConversionRate: conversionRate,
    InvoicedCount: invoiced.count,
    InvoicedValue: invoiced.total,
    OpenQuotesCount: openQuotations.count,
    OpenQuotesValue: openQuotations.total,
    ExpiringSoonCount: expiringSoon,
  };
};

const formatMtdPeriodLabel = periodEnd => {
  const end = moment.isMoment(periodEnd) ? periodEnd.clone().tz(TIMEZONE) : moment(periodEnd).tz(TIMEZONE);
  const start = end.clone().startOf('month');
  return `${start.format('D MMM YYYY')} to ${end.format('D MMM YYYY')}`;
};

const getSummaryData = async (companyId, startDate, endDate, dateLabel, companyName, options = {}) => {
  const { incremental = false, periodEnd } = options;

  const periodStats = await getPeriodPipelineStats(companyId, startDate, endDate);

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
  const mtdStats = await getPeriodPipelineStats(companyId, mtdStart, mtdEnd);

  return {
    ...summary,
    incremental: true,
    MtdDate: formatMtdPeriodLabel(mtdEndMoment),
    MtdNewQuotesCount: mtdStats.NewQuotesCount,
    MtdNewQuotesValue: mtdStats.NewQuotesValue,
    MtdConvertedOrders: mtdStats.ConvertedOrders,
    MtdConversionRate: mtdStats.ConversionRate,
    MtdInvoicedCount: mtdStats.InvoicedCount,
    MtdInvoicedValue: mtdStats.InvoicedValue,
    MtdOpenQuotesCount: mtdStats.OpenQuotesCount,
    MtdOpenQuotesValue: mtdStats.OpenQuotesValue,
    MtdExpiringSoonCount: mtdStats.ExpiringSoonCount,
  };
};

const buildPeriodBodyParameters = data => [
  { type: 'text', text: data.Date },
  { type: 'text', text: data.CompanyName },
  { type: 'text', text: formatTemplateCount(data.NewQuotesCount) },
  { type: 'text', text: formatTemplateAmount(data.NewQuotesValue) },
  { type: 'text', text: formatTemplateCount(data.ConvertedOrders) },
  { type: 'text', text: data.ConversionRate },
  { type: 'text', text: formatTemplateCount(data.InvoicedCount) },
  { type: 'text', text: formatTemplateAmount(data.InvoicedValue) },
  { type: 'text', text: formatTemplateCount(data.OpenQuotesCount) },
  { type: 'text', text: formatTemplateAmount(data.OpenQuotesValue) },
  { type: 'text', text: formatTemplateCount(data.ExpiringSoonCount) },
];

const buildTemplateComponents = data => {
  const parameters = buildPeriodBodyParameters(data);

  if (data.incremental) {
    parameters.push(
      { type: 'text', text: data.MtdDate },
      { type: 'text', text: formatTemplateCount(data.MtdNewQuotesCount) },
      { type: 'text', text: formatTemplateAmount(data.MtdNewQuotesValue) },
      { type: 'text', text: formatTemplateCount(data.MtdConvertedOrders) },
      { type: 'text', text: data.MtdConversionRate },
      { type: 'text', text: formatTemplateCount(data.MtdInvoicedCount) },
      { type: 'text', text: formatTemplateAmount(data.MtdInvoicedValue) },
      { type: 'text', text: formatTemplateCount(data.MtdOpenQuotesCount) },
      { type: 'text', text: formatTemplateAmount(data.MtdOpenQuotesValue) },
      { type: 'text', text: formatTemplateCount(data.MtdExpiringSoonCount) },
    );
  }

  return [{ type: 'body', parameters }];
};

module.exports = {
  getSummaryData,
  buildTemplateComponents,
};
