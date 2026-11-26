const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { INVOICE_STATUS, BILL_STATUSES, PAYMENT_STATUS } = require('../../../utils/enum');
const { formatTemplateAmount, formatTemplateCount } = require('../shared/schedule');
const { TIMEZONE } = require('../shared/constants');

const aggregateDocStats = async (
  Model,
  { companyId, dateField, startDate, endDate, amountField, cancelledStatus, statusFilter },
) => {
  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    [dateField]: { $gte: startDate, $lte: endDate },
  };

  if (statusFilter) {
    match.status = statusFilter;
  } else if (cancelledStatus) {
    match.status = { $ne: cancelledStatus };
  }

  const groupStage = {
    _id: null,
    count: { $sum: 1 },
  };

  if (amountField) {
    groupStage.total = {
      $sum: { $multiply: [{ $ifNull: [`$${amountField}`, 0] }, { $ifNull: ['$exchangeRate', 1] }] },
    };
  }

  const [result] = await Model.aggregate([{ $match: match }, { $group: groupStage }]);

  return {
    count: result?.count || 0,
    total: result?.total || 0,
  };
};

const getCustomerOutstanding = async companyId => {
  const { Customer } = getBooksCrmModels();

  const [result] = await Customer.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        'Role.isCustomer': true,
        isActive: true,
      },
    },
    { $unwind: '$branch' },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$branch.currentBalance', 0] } } } },
  ]);

  return result?.total || 0;
};

const getVendorOutstanding = async companyId => {
  const { Customer } = getBooksCrmModels();

  const [result] = await Customer.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        'Role.isVendor': true,
        isActive: true,
      },
    },
    { $unwind: '$branch' },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$branch.currentBalance', 0] } } } },
  ]);

  return result?.total || 0;
};

const getPeriodFinancialStats = async (companyId, startDate, endDate, { includeOutstanding = true } = {}) => {
  const { PaymentReceived } = getBooksCrmModels();
  const { Invoice, Bill, PaymentMade } = getBooksModels();

  const tasks = [
    aggregateDocStats(Invoice, {
      companyId,
      dateField: 'invoiceDate',
      startDate,
      endDate,
      amountField: 'total',
      cancelledStatus: INVOICE_STATUS.CANCELLED,
    }),
    aggregateDocStats(Bill, {
      companyId,
      dateField: 'billDate',
      startDate,
      endDate,
      amountField: 'total',
      cancelledStatus: BILL_STATUSES.CANCELLED,
    }),
    aggregateDocStats(PaymentReceived, {
      companyId,
      dateField: 'paymentDate',
      startDate,
      endDate,
      amountField: 'amountReceived',
      statusFilter: PAYMENT_STATUS.APPROVED,
    }),
    aggregateDocStats(PaymentMade, {
      companyId,
      dateField: 'paymentDate',
      startDate,
      endDate,
      amountField: 'paymentMade',
      statusFilter: PAYMENT_STATUS.APPROVED,
    }),
  ];

  if (includeOutstanding) {
    tasks.push(getCustomerOutstanding(companyId), getVendorOutstanding(companyId));
  }

  const [sales, purchases, paymentsReceived, paymentsMade, customerOutstanding, vendorOutstanding] = await Promise.all(tasks);

  return {
    SalesAmount: sales.total,
    SalesCount: sales.count,
    PurchaseAmount: purchases.total,
    PurchaseCount: purchases.count,
    PaymentReceived: paymentsReceived.total,
    PaymentReceivedCount: paymentsReceived.count,
    PaymentMade: paymentsMade.total,
    PaymentMadeCount: paymentsMade.count,
    CustomerOutstanding: includeOutstanding ? customerOutstanding : undefined,
    VendorOutstanding: includeOutstanding ? vendorOutstanding : undefined,
    NetCashFlow: paymentsReceived.total - paymentsMade.total,
  };
};

const formatMtdPeriodLabel = periodEnd => {
  const end = moment.isMoment(periodEnd) ? periodEnd.clone().tz(TIMEZONE) : moment(periodEnd).tz(TIMEZONE);
  const start = end.clone().startOf('month');
  return `${start.format('D MMM YYYY')} to ${end.format('D MMM YYYY')}`;
};

const getSummaryData = async (companyId, startDate, endDate, dateLabel, companyName, options = {}) => {
  const { incremental = false, periodEnd } = options;

  const periodStats = await getPeriodFinancialStats(companyId, startDate, endDate, { includeOutstanding: true });

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
  const mtdStats = await getPeriodFinancialStats(companyId, mtdStart, mtdEnd, { includeOutstanding: true });

  return {
    ...summary,
    incremental: true,
    MtdDate: formatMtdPeriodLabel(mtdEndMoment),
    MtdSalesAmount: mtdStats.SalesAmount,
    MtdSalesCount: mtdStats.SalesCount,
    MtdPurchaseAmount: mtdStats.PurchaseAmount,
    MtdPurchaseCount: mtdStats.PurchaseCount,
    MtdPaymentReceived: mtdStats.PaymentReceived,
    MtdPaymentReceivedCount: mtdStats.PaymentReceivedCount,
    MtdPaymentMade: mtdStats.PaymentMade,
    MtdPaymentMadeCount: mtdStats.PaymentMadeCount,
    MtdCustomerOutstanding: mtdStats.CustomerOutstanding,
    MtdVendorOutstanding: mtdStats.VendorOutstanding,
    MtdNetCashFlow: mtdStats.NetCashFlow,
  };
};

const buildPeriodBodyParameters = data => [
  { type: 'text', text: data.Date },
  { type: 'text', text: data.CompanyName },
  { type: 'text', text: formatTemplateAmount(data.SalesAmount) },
  { type: 'text', text: formatTemplateCount(data.SalesCount) },
  { type: 'text', text: formatTemplateAmount(data.PurchaseAmount) },
  { type: 'text', text: formatTemplateCount(data.PurchaseCount) },
  { type: 'text', text: formatTemplateAmount(data.PaymentReceived) },
  { type: 'text', text: formatTemplateCount(data.PaymentReceivedCount) },
  { type: 'text', text: formatTemplateAmount(data.PaymentMade) },
  { type: 'text', text: formatTemplateCount(data.PaymentMadeCount) },
  { type: 'text', text: formatTemplateAmount(data.CustomerOutstanding) },
  { type: 'text', text: formatTemplateAmount(data.VendorOutstanding) },
  { type: 'text', text: formatTemplateAmount(data.NetCashFlow) },
];

const buildTemplateComponents = data => {
  const parameters = buildPeriodBodyParameters(data);

  if (data.incremental) {
    parameters.push(
      { type: 'text', text: data.MtdDate },
      { type: 'text', text: formatTemplateAmount(data.MtdSalesAmount) },
      { type: 'text', text: formatTemplateCount(data.MtdSalesCount) },
      { type: 'text', text: formatTemplateAmount(data.MtdPurchaseAmount) },
      { type: 'text', text: formatTemplateCount(data.MtdPurchaseCount) },
      { type: 'text', text: formatTemplateAmount(data.MtdPaymentReceived) },
      { type: 'text', text: formatTemplateCount(data.MtdPaymentReceivedCount) },
      { type: 'text', text: formatTemplateAmount(data.MtdPaymentMade) },
      { type: 'text', text: formatTemplateCount(data.MtdPaymentMadeCount) },
      { type: 'text', text: formatTemplateAmount(data.MtdCustomerOutstanding) },
      { type: 'text', text: formatTemplateAmount(data.MtdVendorOutstanding) },
      { type: 'text', text: formatTemplateAmount(data.MtdNetCashFlow) },
    );
  }

  return [{ type: 'body', parameters }];
};

module.exports = {
  getSummaryData,
  buildTemplateComponents,
};
